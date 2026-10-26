"use strict";
const vm = require("node:vm");
function once(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error(`Unsupported kiosk source at ${label}; original files were not changed`);
  return source.replace(before, after);
}
function appOverlay(source, { preview = false } = {}) {
  // These tiny connections are applied to the HTTP response, never to source files.
  let result = once(source, "function renderCustomerStep() {", "function renderCustomerStep() {\n  if (window.DigilockerUI?.isActive()) return window.DigilockerUI.render();", "screen registry");
  result = once(result, "const DEMO_KIOSK_MODE =", `const DEMO_KIOSK_MODE = ${preview ? "true" : "false"};\nconst digilockerOriginalDemoSetting =`, "explicit preview mode");
  result = once(result, '<h1>Printing Kiosk</h1>', '<h1>Printing Kiosk</h1>\n        ${window.DigilockerUI?.renderButton() || ""}', "DigiLocker heading placement");
  result = once(result, "function resetCustomer() {", "function digilockerOriginalResetCustomer() {", "reset");
  result = once(result, "function clearCurrentFile() {", "function digilockerOriginalClearCurrentFile() {", "clear documents");
  result = once(result, "async function startLocalPrintJob() {", "async function digilockerOriginalStartLocalPrintJob() {", "print entry");
  result = once(result, "const printBody = {", "const printBody = {\n        ...window.DigilockerUI?.printOptions(file),", "print options");
  if (preview) result = once(result, "function paymentQrMarkup(paymentUrl) {", "function paymentQrMarkup(paymentUrl) {\n  if (window.DigilockerUI) return window.DigilockerUI.mockPaymentMarkup();", "local mock payment");
  result += `\n// Local DigiLocker hooks; the original functions above are preserved.\nfunction resetCustomer() {\n  window.DigilockerUI?.cancel();\n  return digilockerOriginalResetCustomer();\n}\nasync function startLocalPrintJob() {\n  return window.DigilockerUI ? window.DigilockerUI.aroundPrint(digilockerOriginalStartLocalPrintJob) : digilockerOriginalStartLocalPrintJob();\n}\nwindow.DigilockerUI?.attach();\n`;
  result += '\nfunction clearCurrentFile() { window.DigilockerUI?.beforeClear(); return digilockerOriginalClearCurrentFile(); }\n';
  new vm.Script(result, { filename: "local-kiosk-app.js" });
  return result;
}
function htmlOverlay(source) {
  return once(source, "</head>", '<link rel="stylesheet" href="/digilocker/kiosk.css"><script src="/digilocker/runtime.js"></script><script src="/digilocker/kiosk.js"></script></head>', "HTML head");
}
module.exports = { appOverlay, htmlOverlay, once };
