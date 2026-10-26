"use strict";
// Reuse the project's actual PDF.js parser without its canvas/rendering layer.
// This worker is short lived and never renders, fetches links or evaluates PDF JS.
const { parentPort, workerData, MessageChannel } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");
if (!Uint8Array.prototype.toHex) Object.defineProperty(Uint8Array.prototype, "toHex", {
  value() { return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString("hex"); }
});
(async () => {
  const source = fs.readFileSync(workerData.source, "utf8");
  const version = /pdfjsVersion\s*=\s*([\d.]+)/.exec(source)?.[1];
  if (!version) throw new Error("Unsupported PDF.js worker");
  const { WorkerMessageHandler } = await import(pathToFileURL(workerData.source).href);
  const { port1, port2 } = new MessageChannel();
  WorkerMessageHandler.initializeFromPort(port1);
  port2.on("message", message => {
    if (message.callbackId === 1 && message.callback === 1) port2.postMessage({ sourceName: "dl", targetName: message.data, action: "Ready", data: null });
    if (message.action === "GetDoc") parentPort.postMessage({ pages: message.data.pdfInfo.numPages });
    if (["DocException", "PasswordRequest", "UnsupportedFeature"].includes(message.action) || message.callback === 2) parentPort.postMessage({ error: "PDF_INVALID" });
  });
  port2.postMessage({ sourceName: "main", targetName: "worker", action: "GetDocRequest", callbackId: 1,
    data: { docId: "dl", apiVersion: version, data: workerData.data, disableAutoFetch: true,
      evaluatorOptions: { isEvalSupported: false, useSystemFonts: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false } } });
})().catch(() => parentPort.postMessage({ error: "PDF_INVALID" }));
