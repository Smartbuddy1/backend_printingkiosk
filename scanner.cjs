'use strict';
// Adapter for a separately configured LOCAL staging backend. Never auto-discover
// or start hardware from the isolated development launcher.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

function createScanner({ executable, driver, device, scratchDir, run = execFile } = {}) {
  if (!path.isAbsolute(executable || '') || !['wia', 'twain', 'escl'].includes(driver) || !device || !path.isAbsolute(scratchDir || '')) {
    throw new Error('Configure an absolute NAPS2 console path, WIA/TWAIN/eSCL driver, exact device name and private scratch directory.');
  }
  let busy = false;
  return {
    async capture(signal) {
      if (busy) throw new Error('Scanner is busy. Please wait and try again.');
      busy = true;
      let dir;
      try {
        if (signal?.aborted) throw new Error('Scan cancelled.');
        await fs.mkdir(scratchDir, { recursive: true });
        dir = await fs.mkdtemp(path.join(scratchDir, 'scan-'));
        const output = path.join(dir, 'page.png');
        await new Promise((resolve, reject) => run(executable, [
          '--noprofile', '--driver', driver, '--device', device,
          '--source', 'glass', '--pagesize', 'a4', '--dpi', '200',
          '--bitdepth', 'color', '-o', output
        ], { windowsHide: true, shell: false, timeout: 60000, maxBuffer: 65536, signal }, error => {
          if (error) reject(new Error(signal?.aborted ? 'Scan cancelled.' : 'Scanner did not respond. Check its connection and try again.'));
          else resolve();
        }));
        if (signal?.aborted) throw new Error('Scan cancelled.');
        const stat = await fs.stat(output);
        if (stat.size > 20 * 1024 * 1024) throw new Error('Scanned page is too large.');
        const bytes = await fs.readFile(output);
        if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Scanner returned an invalid image.');
        return bytes;
      } finally {
        try {
          // Only our freshly allocated child directory is ever removed.
          if (dir && path.dirname(dir) === path.resolve(scratchDir)) await fs.rm(dir, { recursive: true, force: true });
        } finally { busy = false; }
      }
    }
  };
}

function scannerHandler({ scanner = null, origin = '' } = {}) {
  return async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (!scanner) return reply(503, { error: 'Scanner is not configured on this kiosk. Please contact the operator.' });
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || req.headers.origin !== origin || req.headers['x-kiosk-scanner'] !== 'capture') {
      return reply(403, { error: 'Scan requests must come from this kiosk.' });
    }
    if (req.method !== 'POST') return reply(405, { error: 'Method not allowed.' });
    const abort = new AbortController();
    const cancel = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', cancel);
    try {
      const bytes = await scanner.capture(abort.signal);
      if (abort.signal.aborted) return;
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(bytes);
    } catch (error) {
      if (!abort.signal.aborted) reply(503, { error: error.message });
    } finally { res.off('close', cancel); }
  };
}
module.exports = { createScanner, scannerHandler };
