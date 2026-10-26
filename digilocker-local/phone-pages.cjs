"use strict";
const { escapeHtml: h } = require("./security.cjs");
const { translator } = require("./i18n.cjs");
function shell(language, title, body, mock = false, script = false) {
  const t = translator(language);
  return `<!doctype html><html lang="${h(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · DigiLocker</title><link rel="stylesheet" href="/digilocker/phone.css"></head><body><main class="phone"><div class="phone-brand"><span aria-hidden="true">▧</span> DigiLocker <small>→ Printing Kiosk</small></div>${mock ? `<p class="test-label">${h(t("mock"))}</p>` : ""}<h1>${h(title)}</h1>${body}<footer>${h(t("consent"))}</footer></main>${script ? '<script src="/digilocker/phone.js" defer></script>' : ""}</body></html>`;
}
function documents(session, config) {
  const t = translator(session.language);
  const entries = [...session.documents.values()];
  return shell(session.language, t("selectTitle"), `<p>${h(t("selectIntro"))}</p>${entries.length ? `<form method="post" action="/api/digilocker/sessions/${session.id}/select" data-max="${config.maxFiles}" data-idle-ms="${config.phoneIdleMs}" data-idle-expires="${session.phoneIdleExpiresAt}" data-expires="${session.expiresAt}" data-ended="${h(t("ended"))}"><input type="hidden" name="csrf" value="${h(session.csrf)}"><div class="documents">${entries.map(d => `<label class="document"><input type="checkbox" name="uris" value="${h(d.uri)}"><span><strong>${h(d.name)}</strong><small>${h(t("issuer"))}: ${h(d.issuer || "—")}</small><small>${h(t("type"))}: ${h(d.type)} · ${h(d.mime === "application/pdf" ? "PDF" : d.mime === "image/png" ? "PNG" : "JPG")}</small>${d.date ? `<small>${h(t("date"))}: ${h(d.date)}</small>` : ""}</span></label>`).join("")}</div><p>${h(t("max"))} ${config.maxFiles} ${h(t("files"))} · ${config.maxBytes / 1048576} MB / ${h(t("copied"))}</p><p role="status" id="selection-count">0 ${h(t("selected"))}</p><button type="submit" class="send" disabled>${h(t("send"))}</button></form>` : `<p role="status">${h(t("noDocuments"))}</p>`}`, config.mode === "mock", true);
}
function result(language, config, success = true, code = "generic") {
  const t = translator(language);
  return shell(language, t(success ? "sent" : "failed"), `<div class="result ${success ? "ok" : "error"}" role="status">${success ? "✓" : "!"}</div><p>${h(t(success ? "sentNote" : code))}</p>${config.mode === "live" ? `<p><a href="${h(config.endpoints.logout)}" rel="noreferrer">${h(t("logout"))}</a></p>` : ""}`, config.mode === "mock", true).replace("<body>", `<body data-phone-page-expiry="${Date.now()+(success?15000:30000)}">`);
}
module.exports = { shell, documents, result };
