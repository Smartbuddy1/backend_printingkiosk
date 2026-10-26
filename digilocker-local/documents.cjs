"use strict";
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { Failure } = require("./security.cjs");

function countPdf(bytes, frontend, signal) {
  if (signal?.aborted) return Promise.reject(new Failure("SESSION_ENDED", 410));
  return new Promise((resolve, reject) => {
    const data = Uint8Array.from(bytes);
    const worker = new Worker(path.join(__dirname, "pdf-worker.cjs"), {
      workerData: { data, source: path.join(frontend, "assets/vendor/pdfjs/pdf.worker.min.mjs") }, transferList: [data.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 96 }, stdout: true, stderr: true
    });
    // PDF parser diagnostics may contain document metadata; never forward them.
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false;
    const done = (error, pages) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      worker.terminate().then(() => error ? reject(error) : resolve(pages));
    };
    const abort = () => done(new Failure("SESSION_ENDED", 410));
    const timer = setTimeout(() => done(new Failure("PDF_INVALID", 415)), 8000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.on("message", value => Number.isSafeInteger(value.pages) && value.pages > 0 ? done(null, value.pages) : done(new Failure("PDF_INVALID", 415)));
    worker.on("error", () => done(new Failure("PDF_INVALID", 415)));
    worker.on("exit", () => { if (!settled) done(new Failure("PDF_INVALID", 415)); });
  });
}
function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 255) throw new Failure("FILE_TYPE_INVALID", 415);
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Failure("FILE_TYPE_INVALID", 415);
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if (length < 8) break;
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  throw new Failure("FILE_TYPE_INVALID", 415);
}
async function validateDocument(bytes, contentType, config, signal) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > config.maxBytes) throw new Failure("FILE_TOO_LARGE", 413);
  const mime = String(contentType || "").split(";")[0].trim().toLowerCase().replace("image/jpg", "image/jpeg");
  if (!["application/pdf","image/png","image/jpeg"].includes(mime)) throw new Failure("FILE_TYPE_INVALID", 415);
  if (mime === "application/pdf") {
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Failure("FILE_TYPE_INVALID", 415);
    const pages = await countPdf(bytes, config.frontend, signal);
    if (pages > config.maxPages) throw new Failure("PAGE_LIMIT", 400);
    return { mime, pages };
  }
  let dimensions;
  if (mime === "image/png") {
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString("ascii",12,16) !== "IHDR") throw new Failure("FILE_TYPE_INVALID", 415);
    dimensions = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  } else {
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Failure("FILE_TYPE_INVALID", 415);
    dimensions = jpegDimensions(bytes);
  }
  if (!dimensions[0] || !dimensions[1] || dimensions[0] * dimensions[1] > 25000000) throw new Failure("IMAGE_TOO_LARGE", 413);
  return { mime, pages: 1 };
}
module.exports = { validateDocument, countPdf };
