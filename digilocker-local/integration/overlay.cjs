"use strict";
const vm = require("node:vm");
function once(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error(`Unsupported kiosk source at ${label}; original files were not changed`);
  return source.replace(before, after);
}
function appOverlay(source, { preview = false, hosted = false } = {}) {
  // These tiny connections are applied to the HTTP response, never to source files.
  let result = once(source, "function renderCustomerStep() {", "function renderCustomerStep() {\n  if (window.DigilockerUI?.isActive()) return window.DigilockerUI.render();", "screen registry");
  if (!hosted) result = once(result, "const DEMO_KIOSK_MODE =", `const DEMO_KIOSK_MODE = ${preview ? "true" : "false"};\nconst digilockerOriginalDemoSetting =`, "explicit preview mode");
  result = once(result,
    "  return services.filter((service) => serviceAvailableForKiosk(service));",
    `  const available = services.filter((service) => serviceAvailableForKiosk(service)); if (!available.some((service) => isDigiLockerService(service)) && window.DigilockerUI?.serviceAvailable()) { const locker = window.DigilockerUI.serviceDefinition(); ${preview ? "if (locker && !services.some(service => service.id === locker.id)) services.push(locker); " : ""}available.push(locker); } return available;`,
    "DigiLocker service card visibility");
  result = once(result,
    "function renderAdditionalPremiumServiceCard(service, index, printerReady, serviceBlockStatus = null) {",
    "function renderAdditionalPremiumServiceCard(service, index, printerReady, serviceBlockStatus = null) { if (isDigiLockerService(service)) return window.DigilockerUI?.renderServiceCard(service, printerReady, serviceBlockStatus) || \"\";",
    "DigiLocker service card renderer");
  result = once(result, "function resetCustomer() {", "function digilockerOriginalResetCustomer() {", "reset");
  result = once(result, "function clearCurrentFile() {", "function digilockerOriginalClearCurrentFile() {", "clear documents");
  result = once(result, "async function startLocalPrintJob() {", "async function digilockerOriginalStartLocalPrintJob() {", "print entry");
  result = result.includes("function localPrintRequest(file, jobId)") ?
    once(result, "    jobId, fileName: file.name, pageCount:", "    ...window.DigilockerUI?.printOptions(file),\n    jobId, fileName: file.name, pageCount:", "print options") :
    once(result, "const printBody = {", "const printBody = {\n        ...window.DigilockerUI?.printOptions(file),", "print options");
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
