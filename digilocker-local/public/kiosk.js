(function () {
  "use strict";
  const config = window.DigiLockerConfig;
  if (!config?.enabled) return;
  let session = null, phase = "", active = false, handedOff = false, generation = 0;
  let resumePending = false, resumeTimer = null;
  let poller = null, clock = null, fetching = false, records = [], received = [], message = "";
  let abort = new AbortController();
  const owned = new WeakSet();
  const t = key => (config.translations[state.customerLanguage] || config.translations.en)[key] || (config.translations[state.customerLanguage] || config.translations.en).generic;
  const h = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  function redraw() { render(); }
  function normalService() { return customerServices().find(s => s.id === "print" && !isFormTemplateService(s.id)) || customerServices().find(s => !isFormTemplateService(s.id)); }
  async function request(suffix, options = {}, current = session) {
    if (!current) throw new Error("SESSION_ENDED");
    const response = await fetch(`/api/digilocker/sessions/${current.sessionId}/${suffix}`, {
      ...options, signal: options.signal || abort.signal, cache: "no-store",
      headers: { "x-kiosk-secret": current.kioskSecret, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
    });
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || "unavailable"); }
    return response;
  }
  async function complete(current, result) {
    if (!current) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(`/api/digilocker/sessions/${current.sessionId}/complete`, { method: "POST", keepalive: true,
          headers: { "x-kiosk-secret": current.kioskSecret, "Content-Type": "application/json" },
          body: JSON.stringify({ result }), signal: AbortSignal.timeout(4000) });
        if (response.ok || response.status === 410) return;
      } catch { /* The server TTL is the fallback if this browser disappears. */ }
    }
  }
  function clearTimers() { clearTimeout(poller); clearInterval(clock); clearTimeout(resumeTimer); poller = clock = resumeTimer = null; }
  function eraseRecord(record) {
    if (record.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(record.previewUrl);
    record.previewUrl = ""; record.printContentBase64 = "";
  }
  function eraseLocal() { records.forEach(eraseRecord); records = []; received = []; }
  function cancel() {
    const old = session; session = null; generation++; abort.abort(); abort = new AbortController();
    resumePending = false; active = false; handedOff = false; fetching = false; phase = ""; message = ""; clearTimers(); eraseLocal();
    void complete(old, "cancelled");
  }
  function fail(code) {
    const old = session; session = null; abort.abort(); clearTimers(); eraseLocal();
    resumePending = false; active = true; handedOff = false; phase = "FAILED"; message = t(code); clearCurrentFile(); redraw();
    void complete(old, "failed");
  }
  async function prepare(files, epoch) {
    const prepared = [];
    try {
      for (let index = 0; index < files.length; index++) {
        const meta = files[index];
        const response = await request(`files/${meta.fileId}`), blob = await response.blob();
        if (epoch !== generation) throw new Error("SESSION_ENDED");
        const extension = meta.mime === "application/pdf" ? "pdf" : meta.mime === "image/png" ? "png" : "jpg";
        // Provider names stay only in the transient receipt, never job history.
        const file = new File([blob], `Document-${index + 1}.${extension}`, { type: meta.mime });
        const result = createFileRecord(file.name, file.size, meta.pages, file.type);
        if (result.error) throw new Error("FILE_TYPE_INVALID");
        const record = result.file; prepared.push(record); owned.add(record);
        record.pages = meta.pages; record.previewUrl = URL.createObjectURL(file);
        const pageError = await enforceUploadPageLimit(record);
        if (pageError) throw new Error("PAGE_LIMIT");
        record.printContentBase64 = await readFileAsBase64(file);
        if (epoch !== generation) throw new Error("SESSION_ENDED");
      }
      const paperError = enforceUploadPaperSufficiency(prepared);
      if (paperError) { message = paperError; throw new Error("unavailable"); }
      return prepared;
    } catch (error) { prepared.forEach(eraseRecord); throw error; }
  }
  async function poll(epoch) {
    if (!session || epoch !== generation || fetching || handedOff) return;
    fetching = true;
    try {
      const data = await (await request("status")).json();
      if (epoch !== generation) return;
      if (data.phoneActivityAt > (session.lastPhoneActivityAt || 0)) {
        session.lastPhoneActivityAt = data.phoneActivityAt;
        noteCustomerActivity();
        if (epoch !== generation) return;
      }
      if (["DENIED","FAILED","CANCELLED","EXPIRED"].includes(data.status)) { fail(data.status === "DENIED" ? "denied" : data.error || "ended"); return; }
      if (data.status === "READY") {
        const prepared = await prepare(data.files, epoch);
        if (epoch !== generation) { prepared.forEach(eraseRecord); return; }
        received = data.files; records = prepared;
        phase = "READY"; redraw(); return;
      }
      if (phase !== data.status) { phase = data.status; redraw(); }
    } catch (error) { if (epoch === generation && error.name !== "AbortError") fail(error.message); }
    finally {
      if (epoch === generation) fetching = false;
      if (epoch === generation && session && phase !== "READY" && !handedOff) poller = setTimeout(() => poll(epoch), 1500);
    }
  }
  function tick() {
    if (!session) return;
    if (active && checkCustomerInactivityDeadline()) return;
    // The customer timer owns the visible countdown and reset. Keep the
    // server lifetime guard for later document/print phases without another UI clock.
    if (session && Date.now() >= session.expiresAt && phase !== "PRINTING") fail("ended");
  }
  async function start() {
    const service = normalService(); if (!service || !printerReadyForCustomerFlow()) return;
    cancel(); const epoch = generation;
    clearCurrentFile(); stopUploadPolling(); stopPaymentPolling();
    state.selectedService = service.id; applyServicePrintDefaults(service); state.step = 1; state.activeJobId = null;
    state.paymentStatus = "Pending"; state.paymentError = ""; state.printError = "";
    active = true; phase = "STARTING"; redraw();
    try {
      const response = await fetch("/api/digilocker/sessions", { method: "POST", signal: abort.signal,
        headers: { "Content-Type":"application/json", "x-digilocker-kiosk-key":config.kioskKey }, body:JSON.stringify({language:state.customerLanguage}) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "unavailable");
      if (epoch !== generation) { void complete(data,"cancelled"); return; }
      session = data; phase = "CREATED"; redraw(); clock = setInterval(tick,1000); tick(); poller=setTimeout(()=>poll(epoch),500);
    } catch(error) { if(epoch === generation && error.name !== "AbortError")fail(error.message); }
  }
  function confirm() {
    if (phase !== "READY" || !session || !records.length || !printerReadyForCustomerFlow()) return;
    const paperError=enforceUploadPaperSufficiency(records);if(paperError){message=paperError;redraw();return;}
    clearCurrentFile(); handedOff = true; active = false; clearTimeout(poller);
    setJobFiles(records); state.uploadError=""; state.step=2; redraw();
  }
  async function aroundPrint(original) {
    if (!session || !handedOff || !jobFiles().some(f=>owned.has(f))) return original();
    // The existing payment code alone decides when this entry point is called.
    if (state.paymentStatus !== "Success") { fail("generic"); return; }
    const current=session, epoch=generation;
    try {
      await request("printing",{method:"POST"}); phase="PRINTING";
      await original();
      if(epoch !== generation)return;
      const success=state.printProgress===5 && !state.printError;
      active=true;phase="CLEANUP";redraw();
      await complete(current,success?"done":"failed");
      if(epoch !== generation)return;
      session=null;handedOff=false;clearTimers();eraseLocal();clearCurrentFile();
      active=true;phase=success?"DONE":"FAILED";message=success?t("deleted"):t("printFailed");redraw();
    } catch(error) { if(epoch===generation)fail(error.message); }
  }
  function renderButton() {
    if (state.mode !== "customer" || !normalService()) return "";
    return `<button type="button" class="dl-launch" data-digilocker="start" ${printerReadyForCustomerFlow()?"":"disabled"} aria-label="Print from DigiLocker"><img src="/assets/digilocker-official.svg" alt="DigiLocker" width="220" height="44"></button>`;
  }
  function inactivityDeadline() {
    return session && ["CREATED", "PHONE_CONNECTED"].includes(phase) ? session.pairExpiresAt : null;
  }
  function inactivityScreenKey() {
    if (["PRINTING","CLEANUP"].includes(phase)) return "";
    if (phase === "DONE") return "digilockerDone";
    if (["FAILED","DENIED","EXPIRED"].includes(phase)) return "error";
    if (phase === "READY") return "digilockerReady";
    if (["STARTING","DOWNLOADING"].includes(phase)) return "digilockerReceive";
    return "digilockerPair";
  }
  function screen() {
    const steps=["scan","login","choose","print"];
    const index=phase==="CREATED"?0:phase==="PHONE_CONNECTED"?1:["DOWNLOADING","READY"].includes(phase)?2:3;
    let content="";
    if(phase==="STARTING")content=`<p role="status">${h(t("starting"))}</p>`;
    else if(["CREATED","PHONE_CONNECTED","DOWNLOADING"].includes(phase))content=`<div class="dl-pair"><div class="dl-qr" aria-label="DigiLocker QR code">${session?.qrSvg||""}</div><div><h2>${h(t(phase==="CREATED"?"instructions":phase==="PHONE_CONNECTED"?"phoneConnected":"downloading"))}</h2><p>${h(t("consent"))}</p><p class="dl-countdown">${h(t("timeLeft"))} <strong data-digilocker-countdown>--:--</strong></p></div></div>`;
    else if(phase==="READY")content=`<h2>${h(t("ready"))}</h2><ul class="dl-files">${received.map(f=>`<li><span>${h(f.name)}</span><strong>${f.pages} ${h(t("pages"))}</strong></li>`).join("")}</ul><p class="dl-privacy">${h(t("privacy"))}</p><button class="primary-button" data-digilocker="confirm">${h(t("confirm"))}</button><p class="helper-text">${h(t("continueNote"))}</p>`;
    else content=`<div class="dl-result">${phase==="DONE"?"✓":phase==="CLEANUP"?"…":"!"}</div><h2>${h(t(phase==="DONE"?"done":phase==="CLEANUP"?"cleanup":"failed"))}</h2>`;
    return `<div class="stage dl-stage" data-no-customer-translation><div class="stage-header"><h1>${h(t("heading"))}</h1></div><ol class="dl-progress" aria-label="DigiLocker"><!-- distinct from the existing print steps -->${steps.map((s,i)=>`<li class="${i<=index?"is-current":""}"><span>${i+1}</span>${h(t(s))}</li>`).join("")}</ol><div class="dl-content" aria-live="polite">${content}${message?`<p role="status">${h(message)}</p>`:""}</div><div class="flow-actions">${["CREATED","PHONE_CONNECTED","FAILED"].includes(phase)?`<button class="secondary-button" data-digilocker="refresh">${h(t("refresh"))}</button>`:""}<button class="secondary-button" data-digilocker="home">${h(t(["DONE","FAILED"].includes(phase)?"home":"cancel"))}</button></div></div>`;
  }
  // Persist only the screen identity in the existing customer state. Reloads
  // create a fresh QR; credentials, QR secrets and documents are never restored.
  function restoreCustomerState(saved) {
    if (saved.documentSource !== "digilocker" || state.mode !== "customer" || isMobilePaymentEntry) return false;
    resumePending = true; active = true; phase = "STARTING";
    return true;
  }
  function attach() {
    if (resumePending) {
      const deadline = Date.now() + 15000;
      const resume = () => {
        if (!resumePending || !active) return;
        if (normalService() && printerReadyForCustomerFlow()) { void start(); return; }
        if (Date.now() >= deadline) { fail("unavailable"); return; }
        resumeTimer = setTimeout(resume, 100);
      };
      resume();
    }
    if(config.preview){const banner=document.createElement("div");banner.className="dl-preview-banner";banner.setAttribute("role","note");banner.textContent=t("mockPrint");document.body.prepend(banner);}
    document.addEventListener("click",event=>{
      const target=event.target.closest("[data-digilocker]");if(!target)return;event.preventDefault();event.stopPropagation();
      const action=target.dataset.digilocker;
      if(action==="start"||action==="refresh")void start();
      if(action==="confirm")confirm();
      if(action==="home"){resetCustomer();redraw();void refreshPrinterStatus();}
    },true);
    window.addEventListener("pagehide",cancel);
  }
  window.DigilockerUI={attach,cancel,restoreCustomerState,beforeClear:()=>{if(handedOff)cancel();},isActive:()=>active,inactivityScreenKey,inactivityDeadline,render:screen,renderButton,aroundPrint,
    printOptions:file=>owned.has(file)?{digilockerTransient:true}:{},
    mockPaymentMarkup:()=>`<div class="dl-mock-payment"><strong>${h(t("paymentMock"))}</strong><p>${h(t("paymentMockNote"))}</p></div>`
  };
})();
