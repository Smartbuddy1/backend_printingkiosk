"use strict";
const form = document.querySelector("form[data-max]");
let submitting = false;
if (form) {
  const boxes = [...form.querySelectorAll('input[type="checkbox"]')];
  const button = form.querySelector('button[type="submit"]');
  const count = form.querySelector("#selection-count");
  const label = count.textContent.replace(/^0\s*/, "");
  const update = () => {
    const selected = boxes.filter(b => b.checked).length;
    button.disabled = selected < 1 || selected > Number(form.dataset.max);
    count.textContent = `${selected} ${label}`;
  };
  form.addEventListener("change", update);
  form.addEventListener("submit", event => {
    update();
    if (button.disabled) { event.preventDefault(); return; }
    submitting = true;
    button.disabled = true; form.setAttribute("aria-busy", "true");
  });
  update();
}

// Use absolute deadlines so background tabs expire when brought back. Polling
// checks validity but never extends inactivity; only actual interaction does.
if (form || document.body.dataset.phonePageExpiry) {
  const hardExpiry = Number(form?.dataset.expires || document.body.dataset.phonePageExpiry);
  const idleMs = Number(form?.dataset.idleMs || 180000);
  let idleExpiry = Number(form?.dataset.idleExpires || Math.min(Date.now() + idleMs, hardExpiry));
  let ended = false, lastSent = 0, pendingActivity = false, inFlight = false;
  const base = form?.getAttribute("action").replace(/\/select$/, "");
  const csrf = form?.querySelector('[name="csrf"]')?.value;
  const notice = document.createElement("p");
  notice.className = "phone-session-clock";
  document.querySelector(".phone")?.appendChild(notice);
  function expire(notify = true) {
    if (ended) return;
    ended = true;
    if (notify && base) void fetch(base + "/phone-expire", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({csrf}),keepalive:true}).catch(()=>{});
    const panel = document.querySelector(".phone");
    panel.replaceChildren();
    const heading = document.createElement("h1"); heading.textContent = "Session ended";
    const message = document.createElement("p"); message.textContent = form?.dataset.ended || "Return to the kiosk to start again. You can close this tab.";
    panel.append(heading,message);
  }
  function check() {
    if (ended) return;
    if (Date.now() >= hardExpiry || (!submitting && Date.now() >= idleExpiry)) { expire(); return; }
    const seconds = Math.max(0,Math.ceil((Math.min(hardExpiry,idleExpiry)-Date.now())/1000));
    notice.textContent = submitting ? "Sending documents…" : `Session ends in ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")} without activity`;
  }
  async function sync(activity) {
    if (ended || submitting || inFlight || !base) return;
    inFlight = true;
    try {
      const response = await fetch(base + (activity ? "/phone-activity" : "/phone-status"), activity
        ? {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({csrf})}
        : {cache:"no-store"});
      if (response.status === 410 || response.status === 401 || response.status === 403) { expire(false); return; }
      if (response.ok) {
        const data = await response.json();
        if (!pendingActivity) idleExpiry = Math.min(hardExpiry,data.idleExpiresAt);
      }
    } catch { /* Local absolute deadline remains effective if disconnected. */ }
    finally { inFlight = false; }
  }
  for (const event of ["pointerdown","keydown","input","change","touchstart","wheel"]) {
    window.addEventListener(event, () => {
      check();
      if (ended || submitting) return;
      const previousExpiry = idleExpiry;
      idleExpiry = Math.min(hardExpiry,Date.now()+idleMs);
      pendingActivity = true;
      if (base && !inFlight && (Date.now()-lastSent>=5000 || previousExpiry-Date.now()<=5000)) {
        lastSent=Date.now();pendingActivity=false;void sync(true);
      }
      check();
    }, {capture:true,passive:true});
  }
  setInterval(() => {
    check();
    if (ended || inFlight || Date.now()-lastSent<5000) return;
    lastSent = Date.now();
    const activity = pendingActivity; pendingActivity = false;
    void sync(activity);
  },1000);
  document.addEventListener("visibilitychange", () => {check();if(!ended)void sync(false);});
  window.addEventListener("pageshow",check);
  check();
}
