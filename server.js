const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");
const QRCode = require("qrcode");
const { WebSocketServer } = require("ws");
const { loadEnv } = require("./load-env");

loadEnv();
const rdsStore = require("./rds-store");

// Last-resort safety net: an error thrown outside the request handler's own
// try/catch (e.g. inside a setInterval tick, a WebSocket event, or a
// fire-and-forget promise) would otherwise crash the entire process and take
// down every kiosk at once. Log and keep running instead.
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception (process kept alive):", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (process kept alive):", reason);
});

const PORT = Number(process.env.PORT || 5080);
const HOST = process.env.HOST || "";
const DISABLE_ADMIN_ACCESS = process.env.DISABLE_ADMIN_ACCESS === "true";
// Separate from DISABLE_ADMIN_ACCESS (which blocks both /admin and
// /super-admin together, e.g. for a fully locked-down customer-kiosk
// deployment) - this blocks only /super-admin, leaving /admin (Kiosk Admin)
// reachable. Off by default so existing deployments are unaffected unless
// explicitly opted in.
const DISABLE_SUPER_ADMIN_ACCESS = process.env.DISABLE_SUPER_ADMIN_ACCESS === "true";
const RAZORPAY_API_BASE = "api.razorpay.com";
const SETTINGS_PATH = process.env.SETTINGS_PATH ? path.resolve(process.env.SETTINGS_PATH) : path.join(__dirname, "settings.json");
const DATA_PATH = process.env.DATA_PATH ? path.resolve(process.env.DATA_PATH) : path.join(__dirname, "data.json");
const ADMIN_SESSIONS_PATH = process.env.ADMIN_SESSIONS_PATH ? path.resolve(process.env.ADMIN_SESSIONS_PATH) : path.join(__dirname, "admin-sessions.json");
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const FRONTEND_DIR = path.join(__dirname, "../frontend");
const FRONTEND_ASSET_DIR = path.join(FRONTEND_DIR, "assets");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const SERVICE_IMAGE_DIR = path.join(UPLOADS_DIR, "service-images");
const CLIENT_LOGO_DIR = path.join(UPLOADS_DIR, "client-logos");
const IDLE_IMAGE_DIR = path.join(UPLOADS_DIR, "idle-images");
const IDLE_VIDEO_DIR = path.join(UPLOADS_DIR, "idle-videos");
const MAX_FILES_PER_JOB = 10;
// Must match MAX_UPLOAD_PAGES_PER_DOCUMENT in frontend/app.js.
const MAX_UPLOAD_PAGES_PER_DOCUMENT = 10;
const MAX_UPLOAD_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const CUSTOMER_UPLOAD_EXTENSIONS = new Set(["PDF", "JPG", "JPEG", "PNG"]);
const KIOSK_PRINTER_STALE_MS = 10 * 60 * 1000;
const KIOSK_UPDATE_STATUSES = new Set([
  "current",
  "available",
  "downloading",
  "deferred",
  "installing",
  "updated",
  "failed",
  "rollback"
]);
const mobileUploadSessions = new Map();
const adminSessions = new Map();
loadAdminSessions();
const processedRazorpayWebhookEvents = new Set();
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const LOCAL_ONLY_ADMIN_EMAIL = "admin@gmail.com";
const LOCAL_ONLY_SUPER_ADMIN_EMAIL = "superadmin@printingkiosk.local";
const LOCAL_ONLY_ADMIN_PASSWORD = "local-admin-password";
const LOCAL_ONLY_SUPER_ADMIN_PASSWORD = "local-super-admin-password";
const UNSAFE_PRODUCTION_VALUES = new Set([
  "",
  "demo1234",
  "superdemo1234",
  "change-this-admin-password",
  "change-this-super-admin-password",
  "change-this-kiosk-admin-password",
  "change-this-client-password",
  "local-admin-password",
  "local-super-admin-password",
  "admin@printingkiosk.local",
  "superadmin@printingkiosk.local"
]);

function firstEnvValue(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && String(value).trim()) {
      return String(value).trim();
    }
  }

  return "";
}

function requiredProductionValue(label, value) {
  if (!IS_PRODUCTION) return value;

  const normalized = String(value || "").trim();
  if (UNSAFE_PRODUCTION_VALUES.has(normalized.toLowerCase())) {
    throw new Error(`${label} must be set to a real production value before starting the backend.`);
  }

  return normalized;
}

function configValue(names, developmentFallback, label) {
  const value = firstEnvValue(names) || developmentFallback;
  return requiredProductionValue(label, value);
}

function defaultKioskId() {
  const configured = firstEnvValue(["KIOSK_ID"]);
  if (configured) return configured.toUpperCase();

  const hostId = os.hostname()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);

  return `KIOSK-${hostId || "UNASSIGNED"}`;
}

const ADMIN_CREDENTIALS = {
  email: configValue(["CLIENT_EMAIL", "KIOSK_ADMIN_EMAIL", "ADMIN_EMAIL"], LOCAL_ONLY_ADMIN_EMAIL, "CLIENT_EMAIL"),
  password: configValue(["CLIENT_PASSWORD", "KIOSK_ADMIN_PASSWORD", "ADMIN_PASSWORD"], LOCAL_ONLY_ADMIN_PASSWORD, "CLIENT_PASSWORD")
};
const SUPER_ADMIN_CREDENTIALS = {
  email: configValue(["SUPER_ADMIN_EMAIL", "SUPER_EMAIL"], LOCAL_ONLY_SUPER_ADMIN_EMAIL, "SUPER_ADMIN_EMAIL"),
  password: configValue(["SUPER_ADMIN_PASSWORD", "SUPER_PASSWORD"], LOCAL_ONLY_SUPER_ADMIN_PASSWORD, "SUPER_ADMIN_PASSWORD")
};
const DEFAULT_KIOSK_ADMIN_ID = process.env.CLIENT_ID || process.env.KIOSK_ADMIN_ID || "default-admin";
const FRONTEND_FILES = new Set([
  "index.html",
  "admin.html",
  "super-admin.html",
  "styles.css",
  "ui-icons.js",
  "app.js",
  "super-admin.js"
]);
const FRONTEND_ASSETS = new Set(["printhub-logo.png", "printhub-mark.png"]);
const ADMIN_FRONTEND_FILES = new Set(["admin.html", "super-admin.html", "super-admin.js"]);
const SUPER_ADMIN_FRONTEND_FILES = new Set(["super-admin.html", "super-admin.js"]);

const DEFAULT_SERVICES = [
  {
    id: "print",
    icon: "PR",
    title: "Print Document",
    description: "Upload PDF, Word, or image files and print after preview.",
    defaultPages: 5,
    mode: "upload",
    imageUrl: "",
    enabled: true,
    kioskIds: [],
    pricing: { bw: 2, color: 10 },
    templates: []
  },
  {
    id: "scan",
    icon: "SC",
    title: "Scan Document",
    description: "Scan paper documents to PDF with receipt and admin tracking.",
    defaultPages: 3,
    mode: "upload",
    imageUrl: "",
    enabled: true,
    kioskIds: [],
    pricing: { bw: 4, color: 8 },
    templates: []
  },
  {
    id: "copy",
    icon: "CP",
    title: "Copy Document",
    description: "Create quick photocopies with B/W or color pricing.",
    defaultPages: 2,
    mode: "upload",
    imageUrl: "",
    enabled: true,
    kioskIds: [],
    pricing: { bw: 2, color: 10 },
    templates: []
  },
  {
    id: "govt-form",
    icon: "GP",
    title: "Govt Form Print",
    description: "Print blank government form templates without upload.",
    defaultPages: 1,
    mode: "template",
    imageUrl: "",
    enabled: true,
    kioskIds: [],
    pricing: { bw: 3, color: 12 },
    templates: [
      { id: "birth-certificate", title: "Birth Certificate Form", description: "Blank Form No. 5 birth certificate template.", pages: 1, fields: ["Name", "Sex", "Date of birth", "Place of birth", "Mother name", "Father name"], imageUrl: "" },
      { id: "voter-form-6", title: "Form 6", description: "Blank voter registration application template.", pages: 1, fields: ["Applicant", "Age / DOB", "Address", "Constituency", "Mobile"] },
      { id: "voter-form-8", title: "Form 8", description: "Blank voter correction or shifting application template.", pages: 1, fields: ["Applicant", "EPIC No.", "Correction type", "Correct details", "Mobile"] },
      { id: "domicile-certificate", title: "Domicile Certificate Form", description: "Blank domicile certificate application format.", pages: 1, fields: ["Applicant", "DOB", "Address", "Years of residence", "Mobile"] },
      { id: "income-certificate", title: "Income Certificate Form", description: "Blank income certificate request template.", pages: 1, fields: ["Applicant", "Occupation", "Annual income", "Purpose", "Mobile"] },
      { id: "caste-certificate", title: "Caste Certificate Form", description: "Blank caste certificate application template.", pages: 1, fields: ["Applicant", "Caste", "Sub caste", "Address", "Mobile"] }
    ]
  },
  {
    id: "college-form",
    icon: "CF",
    title: "College Form Print",
    description: "Print admission, exam, certificate, and fee forms.",
    defaultPages: 1,
    mode: "template",
    imageUrl: "",
    enabled: true,
    kioskIds: [],
    pricing: { bw: 3, color: 12 },
    templates: [
      { id: "admission-form", title: "Admission Form", description: "Student admission details and guardian section.", pages: 1, fields: ["Student", "Course", "DOB", "Mobile", "Signature"] },
      { id: "exam-registration", title: "Exam Registration Form", description: "Semester exam subject and fee declaration.", pages: 1, fields: ["Student", "Roll No.", "Semester", "Subjects", "Mobile"] },
      { id: "scholarship-form", title: "Scholarship Form", description: "Student scholarship request and document list.", pages: 1, fields: ["Student", "Course", "Income", "Category", "Mobile"] },
      { id: "bonafide-request", title: "Bonafide Certificate Request", description: "Certificate request form for college office.", pages: 1, fields: ["Student", "Roll No.", "Course", "Purpose", "Mobile"] }
    ]
  },
  {
    id: "certificate",
    icon: "CT",
    title: "Certificate Print",
    description: "Print certificates and supporting documents safely.",
    defaultPages: 1,
    mode: "upload",
    imageUrl: "",
    enabled: true,
    kioskIds: [],
    pricing: { bw: 5, color: 15 },
    templates: []
  }
];

const DEFAULT_PRICING = Object.fromEntries(
  DEFAULT_SERVICES.map((service) => [service.id, service.pricing])
);

const SERVICE_CATALOG = DEFAULT_SERVICES.map((service) => ({
  id: service.id,
  title: service.title
}));

let db;
let databaseSaveQueue = Promise.resolve();

function numericPrice(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function createDefaultPricing() {
  return Object.fromEntries(
    DEFAULT_SERVICES.map((service) => [
      service.id,
      { ...service.pricing }
    ])
  );
}

function slug(value, fallback = "service") {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || fallback;
}

function normalizeKioskCode(value, maxLength = 32) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
}

function kioskIdInUse(kioskId = "", ignoreKioskId = "") {
  const normalized = normalizeKioskCode(kioskId);
  const ignored = normalizeKioskCode(ignoreKioskId);
  if (!normalized) return false;
  return (db?.kiosks || []).some((kiosk) => {
    const existingId = normalizeKioskCode(kiosk.kioskId);
    return existingId === normalized && existingId !== ignored;
  });
}

function setupCodeInUse(setupCode = "", ignoreKioskId = "") {
  const normalized = normalizeKioskCode(setupCode);
  const ignored = normalizeKioskCode(ignoreKioskId);
  if (!normalized) return false;
  return (db?.kiosks || []).some((kiosk) => {
    const existingId = normalizeKioskCode(kiosk.kioskId);
    return existingId !== ignored && normalizeKioskCode(kiosk.setupCode) === normalized;
  });
}

function nextUniqueKioskId(seed = "") {
  const preferred = normalizeKioskCode(seed);
  if (preferred && !kioskIdInUse(preferred)) return preferred;

  const used = new Set((db?.kiosks || []).map((kiosk) => normalizeKioskCode(kiosk.kioskId)).filter(Boolean));
  const numbers = [...used]
    .map((id) => /^KIOSK-(\d+)$/i.exec(id)?.[1])
    .filter(Boolean)
    .map((value) => Number(value))
    .filter(Number.isFinite);
  let nextNumber = numbers.length ? Math.max(...numbers) + 1 : used.size + 1;

  for (let attempt = 0; attempt < 10000; attempt += 1) {
    const candidate = `KIOSK-${String(nextNumber + attempt).padStart(2, "0")}`;
    if (!used.has(candidate)) return candidate;
  }

  return `KIOSK-${Date.now().toString().slice(-8)}`;
}

function generateKioskSetupCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function uniqueKioskSetupCode(seed = "", ignoreKioskId = "") {
  const preferred = normalizeKioskCode(seed, 16);
  if (preferred && !setupCodeInUse(preferred, ignoreKioskId)) return preferred;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = generateKioskSetupCode();
    if (!setupCodeInUse(candidate, ignoreKioskId)) return candidate;
  }

  return crypto.randomBytes(6).toString("hex").toUpperCase();
}

function normalizeFields(fields) {
  if (Array.isArray(fields)) {
    return fields.map((field) => String(field || "").trim()).filter(Boolean).slice(0, 8);
  }

  return String(fields || "")
    .split(/\r?\n|,/)
    .map((field) => field.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeTemplates(templates) {
  if (!Array.isArray(templates)) return [];

  return templates
    .map((template, index) => {
      const title = String(template?.title || `Template ${index + 1}`).trim();
      const id = slug(template?.id || title, `template-${index + 1}`);
      const imageUrl = String(template?.imageUrl || "").trim();
      const documentTypeSource = String(template?.documentType || imageUrl).toLowerCase();
      const documentType = documentTypeSource === "pdf" || documentTypeSource.includes(".pdf") ? "pdf" : "image";

      return {
        id,
        title,
        description: String(template?.description || "Blank printable template.").trim(),
        pages: Math.max(1, Math.min(20, Number(template?.pages || 1))),
        paperSize: ["Auto", "A4", "A3", "Letter", "Legal"].find((size) => size.toLowerCase() === String(template?.paperSize || "Auto").trim().toLowerCase()) || "Auto",
        orientation: String(template?.orientation || "portrait").toLowerCase() === "landscape" ? "landscape" : "portrait",
        fields: normalizeFields(template?.fields),
        imageUrl,
        documentType
      };
    })
    .filter((template) => template.title);
}

const DEFAULT_SERVICE_CUSTOMER_SETTINGS = Object.freeze({
  bw: true,
  color: true,
  copies: true
});

const DEFAULT_SERVICE_PRINT_DEFAULTS = Object.freeze({
  colorMode: "bw",
  copies: 1,
  paperSize: "A4",
  sides: "single",
  orientation: "portrait",
  range: "all"
});

function normalizeServiceCustomerSettings(settings = {}, existing = {}) {
  const source = {
    ...DEFAULT_SERVICE_CUSTOMER_SETTINGS,
    ...(existing && typeof existing === "object" ? existing : {}),
    ...(settings && typeof settings === "object" ? settings : {})
  };
  const normalized = Object.fromEntries(
    Object.keys(DEFAULT_SERVICE_CUSTOMER_SETTINGS).map((key) => [key, source[key] !== false])
  );

  if (!normalized.bw && !normalized.color) {
    normalized.bw = true;
  }

  return normalized;
}

function normalizeServicePrintDefaults(defaults = {}, existing = {}) {
  const source = {
    ...DEFAULT_SERVICE_PRINT_DEFAULTS,
    ...(existing && typeof existing === "object" ? existing : {}),
    ...(defaults && typeof defaults === "object" ? defaults : {})
  };
  const paperSize = ["A4", "A3", "Letter", "Legal"].find((size) => size.toLowerCase() === String(source.paperSize || "").trim().toLowerCase()) || "A4";

  return {
    colorMode: String(source.colorMode || "").toLowerCase() === "color" ? "color" : "bw",
    copies: Math.max(1, Math.min(99, Number(source.copies || 1))),
    paperSize,
    sides: String(source.sides || "").toLowerCase() === "duplex" ? "duplex" : "single",
    orientation: String(source.orientation || "").toLowerCase() === "landscape" ? "landscape" : "portrait",
    range: String(source.range || "all").trim() || "all"
  };
}

function normalizeServices(services) {
  const source = Array.isArray(services) && services.length ? services : DEFAULT_SERVICES;
  const seen = new Set();

  return source
    .map((service, index) => {
      const title = String(service?.title || `Service ${index + 1}`).trim();
      let id = slug(service?.id || title, `service-${index + 1}`);

      if (id === "bank-form") id = "govt-form";
      while (seen.has(id)) {
        id = `${id}-${index + 1}`;
      }
      seen.add(id);

      const fallback = DEFAULT_SERVICES.find((item) => item.id === id) || {};
      const mode = service?.mode === "template" ? "template" : "upload";

      return {
        id,
        icon: String(service?.icon || fallback.icon || title.slice(0, 2) || "SV").trim().toUpperCase().slice(0, 3),
        title,
        titleHi: String(service?.titleHi || fallback.titleHi || "").trim(),
        titleMr: String(service?.titleMr || fallback.titleMr || "").trim(),
        description: String(service?.description || fallback.description || "Customer service.").trim(),
        descriptionHi: String(service?.descriptionHi || fallback.descriptionHi || "").trim(),
        descriptionMr: String(service?.descriptionMr || fallback.descriptionMr || "").trim(),
        defaultPages: Math.max(1, Math.min(99, Number(service?.defaultPages || fallback.defaultPages || 1))),
        mode,
        imageUrl: String(service?.imageUrl || fallback.imageUrl || "").trim(),
        enabled: service?.enabled !== false,
        projectIds: Array.isArray(service?.projectIds)
          ? service.projectIds.map((item) => slug(item, "")).filter(Boolean)
          : String(service?.projectIds || "").split(",").map((item) => slug(item, "")).filter(Boolean),
        kioskIds: Array.isArray(service?.kioskIds) ? service.kioskIds.map((item) => String(item).trim()).filter(Boolean) : [],
        customerSettings: normalizeServiceCustomerSettings(service?.customerSettings, fallback.customerSettings),
        printDefaults: normalizeServicePrintDefaults(service?.printDefaults, fallback.printDefaults),
        pricing: {
          bw: numericPrice(service?.pricing?.bw, fallback.pricing?.bw ?? DEFAULT_PRICING.print.bw),
          color: numericPrice(service?.pricing?.color, fallback.pricing?.color ?? DEFAULT_PRICING.print.color)
        },
        templates: mode === "template" ? normalizeTemplates(service?.templates || fallback.templates) : []
      };
    });
}

function normalizePricingPair(rates, fallback = { bw: 0, color: 0 }) {
  return {
    bw: numericPrice(rates?.bw, fallback.bw),
    color: numericPrice(rates?.color, fallback.color)
  };
}

function normalizePricing(pricing, services = DEFAULT_SERVICES) {
  const nextPricing = Object.fromEntries(
    normalizeServices(services).map((service) => [
      service.id,
      { ...service.pricing }
    ])
  );

  if (!pricing || typeof pricing !== "object") {
    return nextPricing;
  }

  if (pricing["bank-form"] && !pricing["govt-form"]) {
    pricing = {
      ...pricing,
      "govt-form": pricing["bank-form"]
    };
  }

  if ("bw" in pricing || "color" in pricing) {
    Object.keys(nextPricing).forEach((serviceId) => {
      nextPricing[serviceId] = {
        bw: numericPrice(pricing.bw, nextPricing[serviceId].bw),
        color: numericPrice(pricing.color, nextPricing[serviceId].color)
      };
    });
  }

  Object.keys(nextPricing).forEach((serviceId) => {
    const rates = pricing[serviceId];

    if (!rates || typeof rates !== "object") {
      return;
    }

    nextPricing[serviceId] = {
      bw: numericPrice(rates.bw, nextPricing[serviceId].bw),
      color: numericPrice(rates.color, nextPricing[serviceId].color)
    };
  });

  const kioskPricingSource = pricing.__kiosks || pricing.kiosks || pricing.byKiosk || {};
  const nextKioskPricing = {};

  if (kioskPricingSource && typeof kioskPricingSource === "object") {
    Object.entries(kioskPricingSource).forEach(([rawKioskId, kioskPricing]) => {
      const kioskId = normalizeKioskCode(rawKioskId);
      if (!kioskId || !kioskPricing || typeof kioskPricing !== "object") return;

      const scopedPricing = {};
      Object.keys(nextPricing).forEach((serviceId) => {
        const rates = kioskPricing[serviceId];
        if (!rates || typeof rates !== "object") return;
        scopedPricing[serviceId] = normalizePricingPair(rates, nextPricing[serviceId]);
      });

      if (Object.keys(scopedPricing).length) {
        nextKioskPricing[kioskId] = scopedPricing;
      }
    });
  }

  if (Object.keys(nextKioskPricing).length) {
    nextPricing.__kiosks = nextKioskPricing;
  }

  return nextPricing;
}

function normalizeAdminId(value, fallback = DEFAULT_KIOSK_ADMIN_ID) {
  return slug(value || fallback, fallback);
}

function defaultKioskAdmin() {
  return {
    adminId: normalizeAdminId(DEFAULT_KIOSK_ADMIN_ID),
    name: process.env.CLIENT_NAME || process.env.KIOSK_ADMIN_NAME || "Client",
    email: ADMIN_CREDENTIALS.email,
    password: ADMIN_CREDENTIALS.password,
    status: "active",
    logoUrl: normalizePublicAssetUrl(process.env.CLIENT_LOGO_URL || process.env.KIOSK_CLIENT_LOGO_URL || ""),
    kioskTitle: String(process.env.CLIENT_KIOSK_TITLE || process.env.KIOSK_CLIENT_TITLE || "").trim(),
    kioskSubtitle: String(process.env.CLIENT_KIOSK_SUBTITLE || process.env.KIOSK_CLIENT_SUBTITLE || "").trim(),
    projectIds: ["default-project"],
    kioskIds: []
  };
}

function normalizeKioskAdmin(record = {}, existing = {}) {
  const next = { ...existing, ...record };
  const adminId = normalizeAdminId(existing.adminId || next.adminId || next.email || DEFAULT_KIOSK_ADMIN_ID);
  const password = record.password === "" || record.password == null
    ? existing.password || next.password
    : record.password;

  return {
    ...next,
    adminId,
    name: String(next.name || "Client").trim(),
    email: String(next.email || "").trim().toLowerCase(),
    password: String(password || "").trim(),
    status: String(next.status || "active").trim().toLowerCase() === "disabled" ? "disabled" : "active",
    logoUrl: normalizePublicAssetUrl(next.logoUrl || next.logo || next.clientLogoUrl || ""),
    kioskTitle: String(next.kioskTitle || next.headingTitle || "").trim().slice(0, 120),
    kioskSubtitle: String(next.kioskSubtitle || next.headingDescription || next.description || "").trim().slice(0, 180),
    idleMediaMode: normalizeIdleMediaMode(next.idleMediaMode),
    idleImageUrls: normalizeIdleImageUrls(next.idleImageUrls),
    idleVideoUrl: normalizePublicAssetUrl(next.idleVideoUrl || ""),
    idleTimeoutSeconds: normalizeIdleTimeoutSeconds(next.idleTimeoutSeconds),
    projectIds: Array.isArray(next.projectIds)
      ? next.projectIds.map((item) => slug(item, "")).filter(Boolean)
      : String(next.projectIds || "").split(",").map((item) => slug(item, "")).filter(Boolean),
    kioskIds: Array.isArray(next.kioskIds)
      ? next.kioskIds.map((item) => normalizeKioskCode(item)).filter(Boolean)
      : []
  };
}

function normalizeSuperAdminProject(record = {}, existing = {}) {
  const next = { ...existing, ...record };
  const name = String(next.name || "New Project").trim();

  return {
    ...next,
    projectId: slug(existing.projectId || next.projectId || name, `project-${Date.now()}`),
    name,
    description: String(next.description || "").trim(),
    adminId: next.adminId ? normalizeAdminId(next.adminId, "") : "",
    status: String(next.status || "active").toLowerCase() === "inactive" ? "inactive" : "active",
    createdAt: existing.createdAt || next.createdAt || isoNow()
  };
}

function normalizeKioskAdmins(records) {
  const source = Array.isArray(records) && records.length ? records : [defaultKioskAdmin()];
  const admins = source
    .map((record) => normalizeKioskAdmin(record))
    .filter((admin) => admin.email && admin.password);

  if (!admins.some((admin) => admin.adminId === normalizeAdminId(DEFAULT_KIOSK_ADMIN_ID))) {
    admins.unshift(defaultKioskAdmin());
  }

  const seen = new Set();
  return admins.filter((admin) => {
    if (seen.has(admin.adminId)) return false;
    seen.add(admin.adminId);
    return true;
  });
}

function loadSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    return {
      pricing: settings.pricing || settings,
      config: settings.config || {}
    };
  } catch {
    return {
      pricing: createDefaultPricing(),
      config: {}
    };
  }
}

function loadData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function createRuntimeDb(persistedData = {}, persistedSettings = {}) {
  const persistedServices = normalizeServices(persistedData.services);
  const kioskAdmins = normalizeKioskAdmins(persistedData.kioskAdmins);
  const fallbackAdminId = kioskAdmins[0]?.adminId || DEFAULT_KIOSK_ADMIN_ID;
  const persistedKiosks = Array.isArray(persistedData.kiosks) && persistedData.kiosks.length
    ? persistedData.kiosks
    : [defaultKiosk()];
  const inferredProjectIds = [...new Set(persistedKiosks.map((kiosk) => slug(kiosk.projectId || "default-project", "default-project")))];
  const projects = Array.isArray(persistedData.projects) && persistedData.projects.length
    ? persistedData.projects.map((project) => normalizeSuperAdminProject(project))
    : inferredProjectIds.map((projectId, index) => normalizeSuperAdminProject({
        projectId,
        name: projectId === "default-project" ? "Default Project" : projectId,
        adminId: index === 0 ? fallbackAdminId : ""
      }));
  const kiosks = persistedKiosks.map((kiosk) => normalizeSuperAdminKiosk({
    projectId: kiosk.projectId || projects[0]?.projectId || "default-project",
    ...kiosk
  }));
  const kioskProjects = [...new Set(kiosks.map((kiosk) => slug(kiosk.projectId, "")).filter(Boolean))];
  const services = persistedServices.map((service) => {
    if (service.projectIds.length) return { ...service, kioskIds: [] };

    const legacyKioskIds = new Set(service.kioskIds.map((kioskId) => normalizeKioskCode(kioskId)));
    const legacyProjects = legacyKioskIds.size
      ? kioskProjects.filter((projectId) => kiosks.some((kiosk) => (
          projectId === kiosk.projectId && legacyKioskIds.has(normalizeKioskCode(kiosk.kioskId))
        )))
      : kioskProjects;

    return { ...service, projectIds: legacyProjects, kioskIds: [] };
  });

  return {
    jobs: Array.isArray(persistedData.jobs) ? persistedData.jobs : [],
    payments: Array.isArray(persistedData.payments) ? persistedData.payments : [],
    alertLogs: Array.isArray(persistedData.alertLogs) ? persistedData.alertLogs : [],
    services,
    pricing: normalizePricing(persistedData.pricing || persistedSettings.pricing, services),
    kiosks,
    projects,
    kioskAdmins,
    releases: Array.isArray(persistedData.releases)
      ? persistedData.releases.map((release) => normalizeKioskRelease(release)).filter(Boolean)
      : [],
    config: normalizeConfigMeta(persistedData.config || persistedSettings.config, persistedData.updatedAt)
  };
}

function defaultKiosk() {
  return {
    kioskId: defaultKioskId(),
    name: process.env.KIOSK_NAME || os.hostname(),
    branch: process.env.KIOSK_BRANCH || "Local Branch",
    projectId: process.env.KIOSK_PROJECT_ID || "default-project",
    adminId: process.env.CLIENT_ID || process.env.KIOSK_ADMIN_ID || "",
    status: "online",
    printer: "unknown",
    scanner: "unknown",
    appVersion: process.env.npm_package_version || "1.0.0",
    lastOnline: new Date().toISOString()
  };
}

function normalizeConfigMeta(config = {}, fallbackUpdatedAt = "") {
  const fallbackTime = Date.parse(fallbackUpdatedAt || "") || Date.now();
  const version = Number(config.version || config.servicesVersion || fallbackTime);
  const updatedAt = config.updatedAt || fallbackUpdatedAt || new Date(fallbackTime).toISOString();

  return {
    version: Number.isFinite(version) && version > 0 ? version : fallbackTime,
    updatedAt,
    reason: String(config.reason || "initial").trim()
  };
}

function touchConfig(reason = "config-updated") {
  const now = new Date();
  db.config = {
    version: Math.max(Number(db.config?.version || 0) + 1, now.getTime()),
    updatedAt: now.toISOString(),
    reason
  };
  return db.config;
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
}

function dataSnapshot() {
  return {
    jobs: db.jobs,
    payments: db.payments,
    services: db.services,
    pricing: db.pricing,
    kiosks: db.kiosks,
    projects: db.projects,
    kioskAdmins: db.kioskAdmins,
    releases: db.releases,
    config: db.config,
    alertLogs: db.alertLogs,
    updatedAt: new Date().toISOString()
  };
}

function clonedDataSnapshot() {
  return JSON.parse(JSON.stringify(dataSnapshot()));
}

// Resolves with { ok, error } instead of ever throwing/rejecting - a save
// that ultimately fails must never break databaseSaveQueue for every save
// after it (that chain is shared across the whole process), and every
// existing call site of saveData()/saveSettings() calls them without
// awaiting the result, so this must never produce an unhandled rejection
// either. Callers that care whether THIS specific save landed (see
// saveSuperAdminCollection() below) can await the returned promise and check
// .ok; callers that don't await it keep working exactly as before.
async function persistSnapshotWithRetry(snapshot, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rdsStore.saveSnapshot(snapshot);
      return { ok: true };
    } catch (error) {
      if (attempt === maxAttempts) {
        // Data (including alert logs) stays in the in-memory db either way and
        // will be included in the next successful save, so a transient failure
        // here isn't permanent data loss on its own - but log loudly since a
        // save that never recovers before a server restart would lose it.
        console.error(`RDS save failed after ${maxAttempts} attempts: ${error.message}`);
        return { ok: false, error };
      }
      console.warn(`RDS save attempt ${attempt} failed, retrying: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

function persistDatabaseSnapshot() {
  if (!rdsStore.enabled()) return Promise.resolve({ ok: true });

  const snapshot = clonedDataSnapshot();
  const attempt = databaseSaveQueue.then(() => persistSnapshotWithRetry(snapshot));
  databaseSaveQueue = attempt;
  return attempt;
}

function saveSettings() {
  if (rdsStore.enabled()) {
    return persistDatabaseSnapshot();
  }

  writeJsonAtomic(SETTINGS_PATH, {
    services: db.services,
    pricing: db.pricing,
    config: db.config,
    updatedAt: db.config.updatedAt
  });
  return Promise.resolve({ ok: true });
}

function saveData() {
  const result = rdsStore.enabled()
    ? persistDatabaseSnapshot()
    : (writeJsonAtomic(DATA_PATH, dataSnapshot()), Promise.resolve({ ok: true }));

  broadcastDataChanged();
  return result;
}

function serviceRates(serviceId, kioskId = "") {
  const service = db.services.find((item) => item.id === serviceId);
  const baseRates = normalizePricingPair(db.pricing[serviceId] || service?.pricing || DEFAULT_PRICING.print, DEFAULT_PRICING.print);
  const scopedKioskId = normalizeKioskCode(kioskId);
  const kioskRates = scopedKioskId ? db.pricing.__kiosks?.[scopedKioskId]?.[serviceId] : null;
  return kioskRates ? normalizePricingPair(kioskRates, baseRates) : baseRates;
}

function kioskForConfig(kioskId = "") {
  const id = normalizeKioskCode(kioskId);
  return db.kiosks.find((kiosk) => normalizeKioskCode(kiosk.kioskId) === id) || null;
}

function projectForKiosk(kiosk = {}) {
  const projectId = slug(kiosk?.projectId || "", "");
  return db.projects.find((project) => project.projectId === projectId) || null;
}

function clientForProject(project = null) {
  if (!project) return null;

  return db.kioskAdmins.find((admin) => (
    admin.adminId === project.adminId ||
    (Array.isArray(admin.projectIds) && admin.projectIds.includes(project.projectId))
  )) || null;
}

function clientForKiosk(kiosk = null) {
  if (!kiosk) return null;
  const directAdminId = normalizeAdminId(kiosk.adminId || "", "");
  if (directAdminId) {
    const directAdmin = db.kioskAdmins.find((admin) => admin.adminId === directAdminId);
    if (directAdmin) return directAdmin;
  }

  return clientForProject(projectForKiosk(kiosk));
}

function serviceAppliesToKiosk(service = {}, kiosk = null, kioskId = "") {
  const id = normalizeKioskCode(kioskId || kiosk?.kioskId);
  const projectId = slug(kiosk?.projectId || "", "");
  const projectIds = Array.isArray(service.projectIds) ? service.projectIds.map((item) => slug(item, "")).filter(Boolean) : [];
  const kioskIds = Array.isArray(service.kioskIds) ? service.kioskIds.map((item) => normalizeKioskCode(item)).filter(Boolean) : [];

  if (kioskIds.length === 0 && projectIds.length === 0) {
    return true;
  }

  const matchesKiosk = kioskIds.length > 0 && Boolean(id && kioskIds.includes(id));
  const matchesProject = projectIds.length > 0 && Boolean(projectId && projectIds.includes(projectId));

  return matchesKiosk || matchesProject;
}

function servicesForKiosk(kioskId = "") {
  const id = normalizeKioskCode(kioskId);
  const kiosk = kioskForConfig(id);
  return db.services.filter((service) => !id || serviceAppliesToKiosk(service, kiosk, id));
}

function findKioskAdminByPublicIdentifier(identifier = "") {
  const rawIdentifier = String(identifier || "").trim();
  if (!rawIdentifier) return null;

  const email = rawIdentifier.toLowerCase();
  const adminId = normalizeAdminId(rawIdentifier, "");

  return db.kioskAdmins.find((admin) => (
    admin.status !== "disabled" &&
    (String(admin.email || "").toLowerCase() === email || admin.adminId === adminId)
  )) || null;
}

function addPublicAdminProjectIds(projectIds, admin = {}) {
  if (!admin?.adminId) return;

  (admin.projectIds || []).forEach((projectId) => {
    const id = slug(projectId, "");
    if (id) projectIds.add(id);
  });

  db.projects
    .filter((project) => project.adminId === admin.adminId)
    .forEach((project) => {
      const id = slug(project.projectId, "");
      if (id) projectIds.add(id);
    });
}

function publicDemoAdminCandidates() {
  const defaultAdminId = normalizeAdminId(DEFAULT_KIOSK_ADMIN_ID);
  const activeAdmins = db.kioskAdmins.filter((admin) => admin.status !== "disabled");
  const adminsWithProjects = activeAdmins.filter((admin) => (
    (admin.projectIds || []).length ||
    db.projects.some((project) => project.adminId === admin.adminId)
  ));
  const nonDefaultAdmins = adminsWithProjects.filter((admin) => admin.adminId !== defaultAdminId);

  return nonDefaultAdmins.length ? nonDefaultAdmins : adminsWithProjects;
}

function serviceHasUploadedTemplateForProjects(service = {}, projectIds = new Set()) {
  const serviceProjectIds = Array.isArray(service.projectIds)
    ? service.projectIds.map((projectId) => slug(projectId, "")).filter(Boolean)
    : [];

  if (!serviceProjectIds.some((projectId) => projectIds.has(projectId))) {
    return false;
  }

  return Array.isArray(service.templates) && service.templates.some((template) => template.imageUrl);
}

function publicProjectIdsForScope(scope = {}) {
  const projectIds = new Set();
  const requestedProjectId = slug(scope.projectId || "", "");

  if (requestedProjectId) {
    projectIds.add(requestedProjectId);
  }

  const adminIdentifier = scope.adminId || scope.adminEmail || "";
  const requestedAdmin = findKioskAdminByPublicIdentifier(adminIdentifier);
  if (adminIdentifier && !requestedAdmin) {
    return projectIds;
  }

  if (requestedAdmin) {
    addPublicAdminProjectIds(projectIds, requestedAdmin);
  }

  const kiosk = kioskForConfig(scope.kioskId);
  if (kiosk?.projectId) {
    const kioskProjectId = slug(kiosk.projectId, "");
    if (kioskProjectId) projectIds.add(kioskProjectId);
  }

  if (projectIds.size || !scope.demo || adminIdentifier || scope.projectId) {
    return projectIds;
  }

  const demoAdmins = publicDemoAdminCandidates();
  const uploadedProjectIds = new Set();

  demoAdmins.forEach((admin) => {
    const adminProjectIds = new Set();
    addPublicAdminProjectIds(adminProjectIds, admin);
    if (db.services.some((service) => serviceHasUploadedTemplateForProjects(service, adminProjectIds))) {
      adminProjectIds.forEach((projectId) => uploadedProjectIds.add(projectId));
    }
  });

  if (uploadedProjectIds.size) {
    return uploadedProjectIds;
  }

  if (demoAdmins.length === 1) {
    addPublicAdminProjectIds(projectIds, demoAdmins[0]);
  }

  return projectIds;
}

function servicesForPublicScope(scope = {}) {
  const kioskId = normalizeKioskCode(scope.kioskId);
  const hasExplicitScope = Boolean(kioskId || scope.projectId || scope.adminId || scope.adminEmail);
  const hasRequestedAdmin = Boolean(scope.adminId || scope.adminEmail);
  const hasRequestedProject = Boolean(scope.projectId);
  const kiosk = kioskForConfig(kioskId);

  if (kioskId && kiosk) {
    return servicesForKiosk(kioskId);
  }

  const projectIds = publicProjectIdsForScope(scope);
  if (projectIds.size) {
    return db.services.filter((service) => {
      const serviceProjectIds = Array.isArray(service.projectIds)
        ? service.projectIds.map((projectId) => slug(projectId, "")).filter(Boolean)
        : [];
      const serviceKioskIds = Array.isArray(service.kioskIds)
        ? service.kioskIds.map((id) => normalizeKioskCode(id)).filter(Boolean)
        : [];

      if (serviceProjectIds.length) {
        return serviceProjectIds.some((projectId) => projectIds.has(projectId));
      }

      return !serviceKioskIds.length;
    });
  }

  if (!hasExplicitScope || (scope.demo && !hasRequestedAdmin && !hasRequestedProject)) {
    return db.services;
  }

  return kioskId ? servicesForKiosk(kioskId) : [];
}

const DEFAULT_KIOSK_CUSTOMER_SETTINGS = Object.freeze({
  bw: true,
  color: true,
  copies: true,
  paperSize: true,
  sides: true,
  orientation: true,
  pageRange: true
});

function normalizeKioskCustomerSettings(settings = {}, existing = {}) {
  const source = {
    ...DEFAULT_KIOSK_CUSTOMER_SETTINGS,
    ...(existing && typeof existing === "object" ? existing : {}),
    ...(settings && typeof settings === "object" ? settings : {})
  };

  const normalized = Object.fromEntries(
    Object.keys(DEFAULT_KIOSK_CUSTOMER_SETTINGS).map((key) => [key, source[key] !== false])
  );

  if (!normalized.bw && !normalized.color) {
    normalized.bw = true;
  }

  return normalized;
}

function kioskConfigResponse(kioskId = "") {
  const filteredServices = servicesForKiosk(kioskId).filter((s) => s.enabled !== false);
  const kiosk = kioskForConfig(kioskId);
  const clientBrand = publicKioskClientBrand(clientForKiosk(kiosk));
  const pricing = pricingForServices(filteredServices, kioskId ? [kioskId] : []);

  return {
    kioskId: kioskId || null,
    kiosk: kiosk ? {
      kioskId: kiosk.kioskId,
      name: kiosk.name,
      branch: kiosk.branch,
      projectId: kiosk.projectId,
      status: kiosk.status,
      printer: kiosk.printer,
      scanner: kiosk.scanner,
      appVersion: kiosk.appVersion,
      lastOnline: kiosk.lastOnline,
      customerSettings: normalizeKioskCustomerSettings(kiosk.customerSettings),
      clientBrand
    } : null,
    clientBrand,
    config: db.config,
    services: filteredServices.map((service) => ({
      ...service,
      pricing: serviceRates(service.id, kioskId)
    })),
    pricing
  };
}

function publicServiceRecord(service = {}) {
  const {
    projectIds,
    kioskIds,
    ...publicService
  } = service;

  return {
    ...publicService
  };
}

function publicServicesResponse(scope = {}) {
  const requestScope = typeof scope === "string" ? { kioskId: scope } : scope;
  const filteredServices = servicesForPublicScope(requestScope);
  const enabledServices = filteredServices.filter((service) => service.enabled !== false);
  const kiosk = kioskForConfig(requestScope.kioskId);
  const requestedAdmin = findKioskAdminByPublicIdentifier(requestScope.adminId || requestScope.adminEmail || "");
  const requestedProject = requestScope.projectId
    ? db.projects.find((project) => project.projectId === slug(requestScope.projectId, "")) || null
    : null;
  const clientBrand = publicKioskClientBrand(
    clientForKiosk(kiosk) ||
    requestedAdmin ||
    clientForProject(requestedProject)
  );
  const pricing = pricingForServices(enabledServices, requestScope.kioskId ? [requestScope.kioskId] : []);

  return {
    config: db.config,
    clientBrand,
    services: enabledServices.map((service) => publicServiceRecord({
      ...service,
      pricing: serviceRates(service.id, requestScope.kioskId)
    })),
    pricing
  };
}

function snapshotHasData(snapshot = {}) {
  return ["jobs", "payments", "services", "kiosks"].some((key) => Array.isArray(snapshot[key]) && snapshot[key].length);
}

async function initializePersistence() {
  if (!rdsStore.enabled()) {
    console.log("Using local JSON persistence.");
    return;
  }

  await rdsStore.initDatabase();
  const snapshot = await rdsStore.loadSnapshot();

  if (snapshotHasData(snapshot)) {
    db = createRuntimeDb(snapshot, {
      pricing: snapshot.pricing,
      config: snapshot.config
    });
    console.log("Loaded backend data from PostgreSQL/RDS.");
    return;
  }

  await rdsStore.saveSnapshot(clonedDataSnapshot());
  console.log("Seeded PostgreSQL/RDS from local default data.");
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Razorpay-Signature, X-Razorpay-Event-Id",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  });
  res.end(JSON.stringify(body, null, 2));
}

function html(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8"
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function binary(res, status, body, contentType, options = {}) {
  const headers = {
    "Content-Type": contentType || "application/octet-stream",
    "Access-Control-Allow-Origin": "*"
  };
  if (options.cacheControl) headers["Cache-Control"] = options.cacheControl;
  res.writeHead(status, headers);
  res.end(body);
}

// Streams a file from disk with HTTP Range support (RFC 7233) - needed for
// reliable <video> playback in Chromium/Electron. A plain <img> GET never
// sends a Range header, so binary() above (always a flat 200, whole body)
// works fine for every one of its other current callers (images, PDFs,
// logos) and is intentionally left untouched. But Chromium's <video> element
// issues a Range request to probe a video's metadata before committing to
// (auto)play, and a server that ignores it and always answers 200 instead of
// 206 is a well-documented cause of <video> silently stalling or never
// starting - exactly the idle-screensaver video symptom this fixes. Falls
// back to a full 200 response for anything other than a single, well-formed
// byte range, so it can never behave worse than the old always-200 code.
function sendFileWithRangeSupport(req, res, filePath, contentType, options = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return json(res, 404, { error: "File not found" });
  }

  const totalSize = stat.size;
  const headers = {
    "Content-Type": contentType || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*"
  };
  if (options.cacheControl) headers["Cache-Control"] = options.cacheControl;

  const sendFull = () => {
    res.writeHead(200, { ...headers, "Content-Length": totalSize });
    fs.createReadStream(filePath).pipe(res);
  };

  const range = String(req.headers.range || "").trim();
  if (!range) return sendFull();

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const hasStart = Boolean(match?.[1]);
  const hasEnd = Boolean(match?.[2]);
  if (!match || (!hasStart && !hasEnd)) return sendFull();

  let start;
  let end;
  if (hasStart) {
    start = parseInt(match[1], 10);
    end = hasEnd ? parseInt(match[2], 10) : totalSize - 1;
  } else {
    start = Math.max(0, totalSize - parseInt(match[2], 10));
    end = totalSize - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= totalSize) {
    return sendFull();
  }

  res.writeHead(206, {
    ...headers,
    "Content-Range": `bytes ${start}-${end}/${totalSize}`,
    "Content-Length": end - start + 1
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

// Uploaded client-logo/service-image/idle-media filenames are already
// unique per upload (timestamp + random suffix - see
// safeUploadedAssetName()), so the same URL can never point to different
// content later; safe to cache for a long time. Without this, the browser
// re-requests the image on every re-render (the customer screen does a full
// innerHTML rebuild, not DOM diffing), which is fine online but means any
// re-render while offline fails the request and falls back to the generic
// placeholder branding - even though the correct image loaded fine earlier
// in the same session.
const IMMUTABLE_UPLOAD_CACHE_CONTROL = "public, max-age=31536000, immutable";

function frontendContentType(filename) {
  const extension = path.extname(filename).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8"
  }[extension] || "application/octet-stream";
}

function serveFrontendFile(res, filename) {
  const safeName = path.basename(filename);
  const filePath = path.join(FRONTEND_DIR, safeName);

  if (!FRONTEND_FILES.has(safeName) || !filePath.startsWith(FRONTEND_DIR) || !fs.existsSync(filePath)) {
    return json(res, 404, { error: "Frontend file not found." });
  }

  return binary(res, 200, fs.readFileSync(filePath), frontendContentType(safeName));
}

function serveFrontendAsset(res, requestPathname) {
  const assetRoot = path.resolve(FRONTEND_ASSET_DIR);
  let relativePath = String(requestPathname || "").replace(/^\/assets\/?/, "");

  try {
    relativePath = decodeURIComponent(relativePath);
  } catch {
    return json(res, 404, { error: "Frontend asset not found." });
  }

  const filePath = path.resolve(assetRoot, relativePath);

  if (
    filePath !== assetRoot &&
    !filePath.startsWith(assetRoot + path.sep) ||
    !fs.existsSync(filePath) ||
    !fs.statSync(filePath).isFile()
  ) {
    return json(res, 404, { error: "Frontend asset not found." });
  }

  return binary(res, 200, fs.readFileSync(filePath), imageContentType(filePath));
}

function ensureUploadDirs() {
  fs.mkdirSync(SERVICE_IMAGE_DIR, { recursive: true });
  fs.mkdirSync(CLIENT_LOGO_DIR, { recursive: true });
  fs.mkdirSync(IDLE_IMAGE_DIR, { recursive: true });
  fs.mkdirSync(IDLE_VIDEO_DIR, { recursive: true });
}

function publicOrigin(req) {
  return (process.env.PUBLIC_BASE_URL || process.env.BACKEND_URL || `http://${req.headers.host || `localhost:${PORT}`}`).replace(/\/+$/, "");
}

function publicFrontendOrigin(req) {
  const configuredUrl = (
    process.env.PUBLIC_FRONTEND_URL ||
    process.env.FRONTEND_PUBLIC_URL ||
    process.env.FRONTEND_URL ||
    process.env.KIOSK_URL ||
    ""
  ).replace(/\/+$/, "");

  if (configuredUrl) {
    try {
      const url = new URL(configuredUrl);
      if (/^https?:$/.test(url.protocol)) return configuredUrl;
    } catch {
      // Fall back to the backend origin below.
    }
  }

  return publicOrigin(req);
}

function uploadBaseUrl(req, session = null) {
  return (session?.publicBaseUrl || publicOrigin(req)).replace(/\/+$/, "");
}

// Server-rendered pages (mobile upload, etc.) have no request context tying them
// to a frontend origin, and in production the backend (this API host) does not
// serve /assets/* itself — the frontend is hosted separately (e.g. Vercel). Point
// asset URLs there when configured; otherwise fall back to a relative path for
// setups where the backend does serve the frontend directly (local/mini-pc).
function frontendAssetOrigin() {
  const configuredUrl = (
    process.env.PUBLIC_FRONTEND_URL ||
    process.env.FRONTEND_PUBLIC_URL ||
    process.env.FRONTEND_URL ||
    process.env.KIOSK_URL ||
    ""
  ).replace(/\/+$/, "");

  if (!configuredUrl) return "";

  try {
    const url = new URL(configuredUrl);
    return /^https?:$/.test(url.protocol) ? configuredUrl : "";
  } catch {
    return "";
  }
}

function imageContentType(filename) {
  const extension = path.extname(filename).toLowerCase();
  return {
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".pdf": "application/pdf",
    ".webp": "image/webp"
  }[extension] || "application/octet-stream";
}

function safeUploadedAssetName(filename, fallbackBase = "asset", allowedExtensions = [".gif", ".jpg", ".jpeg", ".png", ".webp"]) {
  const extension = path.extname(filename).toLowerCase();
  const allowed = new Set(allowedExtensions);
  const normalizedExtension = allowed.has(extension) ? extension : allowedExtensions[0] || ".bin";
  const base = path.basename(filename, extension)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || fallbackBase;

  return `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${base}${normalizedExtension}`;
}

function safeUploadedImageName(filename) {
  return safeUploadedAssetName(filename, "service-image", [".gif", ".jpg", ".jpeg", ".png", ".webp", ".pdf"]);
}

function safeUploadedClientLogoName(filename) {
  return safeUploadedAssetName(filename, "client-logo", [".png", ".jpg", ".jpeg", ".webp", ".gif"]);
}

function safeUploadedIdleImageName(filename) {
  return safeUploadedAssetName(filename, "idle-image", [".png", ".jpg", ".jpeg", ".webp", ".gif"]);
}

function safeUploadedIdleVideoName(filename) {
  return safeUploadedAssetName(filename, "idle-video", [".mp4", ".webm"]);
}

function videoContentType(filename) {
  const extension = path.extname(filename).toLowerCase();
  return {
    ".mp4": "video/mp4",
    ".webm": "video/webm"
  }[extension] || "application/octet-stream";
}

function normalizePublicAssetUrl(value = "") {
  const url = String(value || "").trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url.slice(0, 2048);
  if (url.startsWith("/uploads/") || url.startsWith("./assets/") || url.startsWith("/assets/")) return url.slice(0, 2048);
  return "";
}

const IDLE_MEDIA_MODES = new Set(["none", "image", "video"]);
const IDLE_MAX_IMAGES = 10;
const IDLE_TIMEOUT_MIN_SECONDS = 15;
const IDLE_TIMEOUT_MAX_SECONDS = 600;
const IDLE_TIMEOUT_DEFAULT_SECONDS = 60;

function normalizeIdleMediaMode(value = "") {
  const mode = String(value || "").trim().toLowerCase();
  return IDLE_MEDIA_MODES.has(mode) ? mode : "none";
}

function normalizeIdleImageUrls(value) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((item) => normalizePublicAssetUrl(item))
    .filter(Boolean)
    .slice(0, IDLE_MAX_IMAGES);
}

function normalizeIdleTimeoutSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return IDLE_TIMEOUT_DEFAULT_SECONDS;
  return Math.min(IDLE_TIMEOUT_MAX_SECONDS, Math.max(IDLE_TIMEOUT_MIN_SECONDS, Math.round(seconds)));
}

function s3UploadConfig() {
  const bucket = firstEnvValue(["AWS_S3_BUCKET", "S3_BUCKET", "AWS_BUCKET_NAME"]);
  const region = firstEnvValue(["AWS_REGION", "AWS_DEFAULT_REGION", "S3_REGION"]) || "ap-south-1";
  const accessKeyId = firstEnvValue(["AWS_ACCESS_KEY_ID", "S3_ACCESS_KEY_ID"]);
  const secretAccessKey = firstEnvValue(["AWS_SECRET_ACCESS_KEY", "S3_SECRET_ACCESS_KEY"]);
  const sessionToken = firstEnvValue(["AWS_SESSION_TOKEN", "S3_SESSION_TOKEN"]);
  const publicBaseUrl = firstEnvValue(["S3_PUBLIC_BASE_URL", "AWS_S3_PUBLIC_BASE_URL", "CLOUDFRONT_URL", "AWS_CLOUDFRONT_URL"]).replace(/\/+$/, "");
  const prefix = firstEnvValue(["S3_UPLOAD_PREFIX", "AWS_S3_PREFIX", "S3_PREFIX"]).replace(/^\/+|\/+$/g, "");
  const requested = Boolean(bucket || accessKeyId || secretAccessKey || sessionToken);

  return {
    enabled: Boolean(bucket && region && accessKeyId && secretAccessKey),
    requested,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    publicBaseUrl,
    prefix,
    host: bucket ? `${bucket}.s3.${region}.amazonaws.com` : ""
  };
}

function hashHex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function s3CanonicalUri(key) {
  return `/${String(key || "").split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

function s3ObjectKey(folder, filename) {
  const prefix = s3UploadConfig().prefix;
  return [prefix, folder, filename]
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/");
}

function s3PublicUrl(config, key) {
  const encodedKey = String(key || "").split("/").map((part) => encodeURIComponent(part)).join("/");
  if (config.publicBaseUrl) return `${config.publicBaseUrl}/${encodedKey}`;
  return `https://${config.host}/${encodedKey}`;
}

// S3/CloudFront-hosted assets (client logos when S3 upload is enabled) are
// plain "public read" objects - fine for an <img> tag, but a browser fetch()
// from the admin panel's own origin fails because the bucket has no CORS
// policy, so PDF export (which needs to read image bytes into a canvas) gets
// nothing back. Fetching the same URL from the SERVER has no such
// restriction - CORS is a browser-only mechanism - so this proxies exactly
// those known asset hosts through our own already-CORS-open response.
function assetProxyAllowedHost(targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;

  const s3Config = s3UploadConfig();
  const allowedHosts = new Set();
  if (s3Config.host) allowedHosts.add(s3Config.host);
  if (s3Config.publicBaseUrl) {
    try { allowedHosts.add(new URL(s3Config.publicBaseUrl).host); } catch {}
  }

  return allowedHosts.has(parsed.host);
}

function fetchRemoteBinary(targetUrl, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      reject(new Error("Invalid URL."));
      return;
    }

    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.get(parsed, { timeout: 15000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirectsLeft > 0) {
        response.resume();
        fetchRemoteBinary(new URL(response.headers.location, parsed).toString(), redirectsLeft - 1).then(resolve, reject);
        return;
      }

      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Remote asset request failed (${response.statusCode}).`));
          return;
        }
        resolve({
          contentType: response.headers["content-type"] || "application/octet-stream",
          body: Buffer.concat(chunks)
        });
      });
    });

    req.on("timeout", () => req.destroy(new Error("Remote asset request timed out.")));
    req.on("error", reject);
  });
}

function s3SigningKey(secretAccessKey, dateStamp, region) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function putS3Object(config, key, content, contentType) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hashHex(content);
  const canonicalUri = s3CanonicalUri(key);
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const headers = {
    "content-type": contentType || "application/octet-stream",
    host: config.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate
  };

  if (config.sessionToken) {
    headers["x-amz-security-token"] = config.sessionToken;
  }

  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashHex(canonicalRequest)
  ].join("\n");
  const signature = hmac(s3SigningKey(config.secretAccessKey, dateStamp, config.region), stringToSign, "hex");
  const requestHeaders = {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "Content-Length": content.length
  };

  return new Promise((resolve, reject) => {
    const request = https.request({
      method: "PUT",
      hostname: config.host,
      path: canonicalUri,
      headers: requestHeaders
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
          return;
        }

        const message = Buffer.concat(chunks).toString("utf8").slice(0, 240);
        reject(new Error(`S3 upload failed (${response.statusCode || "unknown"}). ${message}`.trim()));
      });
    });

    request.on("error", reject);
    request.write(content);
    request.end();
  });
}

async function storeClientLogoUpload(req, file) {
  const filename = safeUploadedClientLogoName(file.filename);
  const contentType = file.mimeType && file.mimeType.startsWith("image/") ? file.mimeType : imageContentType(filename);
  const config = s3UploadConfig();

  if (config.enabled) {
    const key = s3ObjectKey("client-logos", filename);
    await putS3Object(config, key, file.content, contentType);
    return {
      imageUrl: s3PublicUrl(config, key),
      filename,
      storage: "s3",
      size: file.content.length
    };
  }

  if (config.requested) {
    throw new Error("S3 logo upload is not fully configured. Set AWS_S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY.");
  }

  ensureUploadDirs();
  fs.writeFileSync(path.join(CLIENT_LOGO_DIR, filename), file.content);

  return {
    imageUrl: `${publicOrigin(req)}/uploads/client-logos/${encodeURIComponent(filename)}`,
    filename,
    storage: "local",
    size: file.content.length
  };
}

async function storeIdleImageUpload(req, file) {
  const filename = safeUploadedIdleImageName(file.filename);
  const contentType = file.mimeType && file.mimeType.startsWith("image/") ? file.mimeType : imageContentType(filename);
  const config = s3UploadConfig();

  if (config.enabled) {
    const key = s3ObjectKey("idle-images", filename);
    await putS3Object(config, key, file.content, contentType);
    return {
      imageUrl: s3PublicUrl(config, key),
      filename,
      storage: "s3",
      size: file.content.length
    };
  }

  if (config.requested) {
    throw new Error("S3 idle-image upload is not fully configured. Set AWS_S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY.");
  }

  ensureUploadDirs();
  fs.writeFileSync(path.join(IDLE_IMAGE_DIR, filename), file.content);

  return {
    imageUrl: `${publicOrigin(req)}/uploads/idle-images/${encodeURIComponent(filename)}`,
    filename,
    storage: "local",
    size: file.content.length
  };
}

async function storeIdleVideoUpload(req, file) {
  const filename = safeUploadedIdleVideoName(file.filename);
  const contentType = file.mimeType && file.mimeType.startsWith("video/") ? file.mimeType : videoContentType(filename);
  const config = s3UploadConfig();

  if (config.enabled) {
    const key = s3ObjectKey("idle-videos", filename);
    await putS3Object(config, key, file.content, contentType);
    return {
      videoUrl: s3PublicUrl(config, key),
      filename,
      storage: "s3",
      size: file.content.length
    };
  }

  if (config.requested) {
    throw new Error("S3 idle-video upload is not fully configured. Set AWS_S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY.");
  }

  ensureUploadDirs();
  fs.writeFileSync(path.join(IDLE_VIDEO_DIR, filename), file.content);

  return {
    videoUrl: `${publicOrigin(req)}/uploads/idle-videos/${encodeURIComponent(filename)}`,
    filename,
    storage: "local",
    size: file.content.length
  };
}

function credentialIdentifier(body = {}) {
  return String(body.identifier || body.email || body.username || body.adminId || body.ownerId || body.id || "").trim();
}

function credentialsMatch(body, expected) {
  const identifier = credentialIdentifier(body).toLowerCase();
  const password = String(body?.password || "");

  const expectedEmail = String(expected.email || "").trim().toLowerCase();
  const expectedPassword = String(expected.password || "");

  // Only the actually-configured email (and its username-only shorthand,
  // e.g. "owner" for "owner@example.com") are valid identifiers. When no
  // SUPER_ADMIN_EMAIL/PASSWORD env var is set, `expected` itself already
  // falls back to LOCAL_ONLY_SUPER_ADMIN_EMAIL/PASSWORD, so the local-dev
  // login keeps working with no extra entries needed here.
  const validIdentifiers = new Set([expectedEmail, expectedEmail.split("@")[0]].filter(Boolean));

  return Boolean(expectedPassword) && validIdentifiers.has(identifier) && password === expectedPassword;
}

function kioskAdminBrandFields(admin = {}) {
  return {
    logoUrl: normalizePublicAssetUrl(admin.logoUrl || admin.logo || admin.clientLogoUrl || ""),
    kioskTitle: String(admin.kioskTitle || admin.headingTitle || "").trim(),
    kioskSubtitle: String(admin.kioskSubtitle || admin.headingDescription || admin.description || "").trim()
  };
}

function kioskAdminIdleScreensaverFields(admin = {}) {
  return {
    idleMediaMode: normalizeIdleMediaMode(admin.idleMediaMode),
    idleImageUrls: normalizeIdleImageUrls(admin.idleImageUrls),
    idleVideoUrl: normalizePublicAssetUrl(admin.idleVideoUrl || ""),
    idleTimeoutSeconds: normalizeIdleTimeoutSeconds(admin.idleTimeoutSeconds)
  };
}

function publicKioskAdmin(admin = {}) {
  const brand = kioskAdminBrandFields(admin);
  const idle = kioskAdminIdleScreensaverFields(admin);

  return {
    adminId: admin.adminId,
    name: admin.name,
    email: admin.email,
    status: admin.status,
    logoUrl: brand.logoUrl,
    kioskTitle: brand.kioskTitle,
    kioskSubtitle: brand.kioskSubtitle,
    idleMediaMode: idle.idleMediaMode,
    idleImageUrls: idle.idleImageUrls,
    idleVideoUrl: idle.idleVideoUrl,
    idleTimeoutSeconds: idle.idleTimeoutSeconds,
    projectIds: Array.isArray(admin.projectIds) ? admin.projectIds : [],
    kioskIds: Array.isArray(admin.kioskIds) ? admin.kioskIds : []
  };
}

function publicIdleScreensaver(admin = {}) {
  const idle = kioskAdminIdleScreensaverFields(admin);

  return {
    mode: idle.idleMediaMode,
    imageUrls: idle.idleMediaMode === "image" ? idle.idleImageUrls : [],
    videoUrl: idle.idleMediaMode === "video" ? idle.idleVideoUrl : "",
    timeoutSeconds: idle.idleTimeoutSeconds
  };
}

function publicKioskClientBrand(admin = {}) {
  if (!admin) return null;
  const brand = kioskAdminBrandFields(admin);
  const logoUrl = brand.logoUrl;
  const title = brand.kioskTitle;
  const subtitle = brand.kioskSubtitle;
  const idleScreensaver = publicIdleScreensaver(admin);

  if (!logoUrl && !title && !subtitle && idleScreensaver.mode === "none") return null;

  return {
    clientId: admin.adminId || "",
    name: admin.name || "",
    title: title || String(admin.name || "").trim(),
    subtitle,
    logoUrl,
    idleScreensaver
  };
}

function findKioskAdminByCredentials(body = {}) {
  const identifier = credentialIdentifier(body);
  const normalizedIdentifier = identifier.toLowerCase();
  const adminId = normalizeAdminId(identifier, "");
  const password = String(body.password || "");

  return db.kioskAdmins.find((admin) => (
    admin.status !== "disabled" &&
    (admin.email === normalizedIdentifier || admin.adminId === adminId) &&
    admin.password === password
  )) || null;
}

function findKioskAdminById(adminId = "") {
  const id = normalizeAdminId(adminId);
  return db.kioskAdmins.find((admin) => admin.adminId === id) || null;
}

function authenticatedAdminResponse(body = {}) {
  const kioskAdmin = findKioskAdminByCredentials(body);
  const superAdminMatches = credentialsMatch(body, SUPER_ADMIN_CREDENTIALS);

  if (kioskAdmin && superAdminMatches) {
    return {
      status: 409,
      body: {
        error: "These credentials match both admin roles. Use different super admin and client credentials."
      }
    };
  }

  if (superAdminMatches) {
    return {
      status: 200,
      body: {
        ok: true,
        role: "super-admin",
        admin: {
          name: "Super Admin",
          email: String(body.email || "").trim().toLowerCase()
        },
        token: createAdminSession("super-admin", {
          name: "Super Admin",
          email: String(body.email || "").trim().toLowerCase()
        })
      }
    };
  }

  if (kioskAdmin) {
    kioskAdmin.lastLoginAt = isoNow();
    saveData();
    return {
      status: 200,
      body: {
        ok: true,
        role: "kiosk-admin",
        admin: publicKioskAdmin(kioskAdmin),
        token: createAdminSession("kiosk-admin", kioskAdmin)
      }
    };
  }

  return {
    status: 401,
    body: {
      error: "Invalid admin credentials."
    }
  };
}

function kioskAdminUnlockResponse(body = {}) {
  const kioskId = normalizeKioskCode(body.kioskId);
  const kiosk = kioskId ? kioskForConfig(kioskId) : null;
  const kioskAdmin = findKioskAdminByCredentials(body);
  const superAdminMatches = credentialsMatch(body, SUPER_ADMIN_CREDENTIALS);

  if (!kioskId) {
    return {
      status: 400,
      body: {
        error: "Kiosk ID is required."
      }
    };
  }

  if (!kiosk) {
    return {
      status: 404,
      body: {
        error: "Kiosk was not found."
      }
    };
  }

  if (kioskAdmin && superAdminMatches) {
    return {
      status: 409,
      body: {
        error: "These credentials match both admin roles. Use different super admin and client credentials."
      }
    };
  }

  if (superAdminMatches) {
    return {
      status: 200,
      body: {
        ok: true,
        role: "super-admin",
        kioskId,
        admin: {
          name: "Super Admin",
          email: credentialIdentifier(body).toLowerCase()
        }
      }
    };
  }

  if (kioskAdmin) {
    const session = {
      role: "kiosk-admin",
      adminId: kioskAdmin.adminId
    };

    if (!adminCanAccessKiosk(session, kioskId)) {
      return {
        status: 403,
        body: {
          error: "This client is not assigned to this kiosk."
        }
      };
    }

    kioskAdmin.lastLoginAt = isoNow();
    saveData();
    return {
      status: 200,
      body: {
        ok: true,
        role: "kiosk-admin",
        kioskId,
        admin: publicKioskAdmin(kioskAdmin)
      }
    };
  }

  return {
    status: 401,
    body: {
      error: "Invalid admin credentials."
    }
  };
}

// adminSessions is persisted to disk (see loadAdminSessions/saveAdminSessions
// below) so logins survive a backend restart - without this, every deploy
// (or crash/process-manager restart) silently logged everyone out, since a
// plain in-memory Map is wiped on process exit. Sessions also use a sliding
// expiry (refreshed on every valid request, see readAdminSession) rather
// than a fixed 8h-from-login window, so an admin actively using the panel
// is never logged out mid-session - only genuinely idle sessions expire.
function createAdminSession(role, account = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, {
    role,
    adminId: account.adminId || "",
    email: account.email || "",
    name: account.name || "",
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS
  });
  saveAdminSessions();
  return token;
}

function readAdminSession(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  const token = match?.[1] || "";
  const session = token ? adminSessions.get(token) : null;

  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    adminSessions.delete(token);
    return null;
  }

  session.expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  return session;
}

function loadAdminSessions() {
  try {
    if (!fs.existsSync(ADMIN_SESSIONS_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(ADMIN_SESSIONS_PATH, "utf8"));
    const now = Date.now();
    Object.entries(raw || {}).forEach(([token, session]) => {
      if (session && Number(session.expiresAt) > now) {
        adminSessions.set(token, session);
      }
    });
  } catch (error) {
    console.error(`Could not load admin sessions: ${error.message}`);
  }
}

function saveAdminSessions() {
  try {
    writeJsonAtomic(ADMIN_SESSIONS_PATH, Object.fromEntries(adminSessions));
  } catch (error) {
    console.error(`Could not save admin sessions: ${error.message}`);
  }
}

// Periodic sweep: flushes sliding-expiry refreshes to disk and drops
// entries that expired between requests, without writing to disk on every
// single authenticated API call (those happen every few seconds per open
// admin tab via snapshot polling).
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [token, session] of adminSessions) {
    if (session.expiresAt < now) {
      adminSessions.delete(token);
      changed = true;
    }
  }
  if (changed || adminSessions.size) saveAdminSessions();
}, 5 * 60 * 1000);

function requireAdminSession(req, res, role) {
  const session = readAdminSession(req);

  if (!session || session.role !== role) {
    json(res, 401, { error: "Admin login required." });
    return false;
  }

  return true;
}

function projectIdsForAdmin(session = {}) {
  if (session.role === "super-admin") return new Set(db.projects.map((project) => project.projectId));
  const account = findKioskAdminById(session.adminId);
  if (!account || account.status === "disabled") return new Set();
  return new Set([
    ...(account.projectIds || []).map((id) => String(id || "").trim()),
    ...db.projects.filter((project) => project.adminId === account.adminId).map((project) => project.projectId)
  ].filter(Boolean));
}

function projectIdsWithKiosks() {
  return new Set(db.kiosks.map((kiosk) => slug(kiosk.projectId, "")).filter(Boolean));
}

function projectIdsWithKiosksForAdmin(session = {}) {
  const allowedProjects = projectIdsForAdmin(session);
  return new Set(
    db.kiosks
      .map((kiosk) => slug(kiosk.projectId, ""))
      .filter((projectId) => projectId && allowedProjects.has(projectId))
  );
}

function kioskIdsForAdmin(session = {}) {
  if (session.role === "super-admin") {
    return new Set(db.kiosks.map((kiosk) => normalizeKioskCode(kiosk.kioskId)).filter(Boolean));
  }

  const account = findKioskAdminById(session.adminId);
  if (!account || account.status === "disabled") return new Set();

  const assignedProjectIds = projectIdsForAdmin(session);
  const explicitKioskIds = new Set(
    (Array.isArray(account.kioskIds) ? account.kioskIds : [])
      .map((kioskId) => normalizeKioskCode(kioskId))
      .filter(Boolean)
  );
  if (explicitKioskIds.size) return explicitKioskIds;

  const projectKiosks = db.kiosks
    .filter((kiosk) => assignedProjectIds.has(slug(kiosk.projectId, "")))
    .map((kiosk) => normalizeKioskCode(kiosk.kioskId))
    .filter(Boolean);

  return new Set(projectKiosks);
}

function projectsForAdmin(session = {}) {
  const allowed = projectIdsForAdmin(session);
  return db.projects.filter((project) => allowed.has(project.projectId));
}

function adminCanAccessProject(session = {}, projectId = "") {
  return projectIdsForAdmin(session).has(slug(projectId, ""));
}

function kiosksForAdmin(session = {}) {
  const allowed = kioskIdsForAdmin(session);
  return db.kiosks.filter((kiosk) => allowed.has(normalizeKioskCode(kiosk.kioskId)));
}

function adminCanAccessKiosk(session = {}, kioskId = "") {
  return kioskIdsForAdmin(session).has(normalizeKioskCode(kioskId));
}

function jobsForAdmin(session = {}) {
  const allowed = kioskIdsForAdmin(session);
  return db.jobs.filter((job) => allowed.has(normalizeKioskCode(job.kioskId)));
}

function alertLogsForAdmin(session = {}) {
  const allowed = kioskIdsForAdmin(session);
  return db.alertLogs.filter((log) => allowed.has(normalizeKioskCode(log.kioskId)));
}


function paymentsForJobs(jobs = []) {
  const jobIds = new Set(jobs.map((job) => String(job.jobId || "")));
  return db.payments.filter((payment) => jobIds.has(String(payment.jobId || "")));
}

function servicesForAdmin(session = {}, kioskId = "") {
  const allowed = kioskIdsForAdmin(session);
  const allowedProjects = projectIdsForAdmin(session);
  const requestedKioskId = normalizeKioskCode(kioskId);

  if (requestedKioskId) {
    if (!allowed.has(requestedKioskId)) return [];
    const kiosk = db.kiosks.find((item) => normalizeKioskCode(item.kioskId) === requestedKioskId) || null;
    return db.services.filter((service) => serviceAppliesToKiosk(service, kiosk, requestedKioskId));
  }

  return db.services.filter((service) => {
    const projectIds = Array.isArray(service.projectIds) ? service.projectIds.map((item) => slug(item, "")).filter(Boolean) : [];
    const kioskIds = Array.isArray(service.kioskIds) ? service.kioskIds.map((id) => normalizeKioskCode(id)).filter(Boolean) : [];

    if (projectIds.length) return projectIds.some((id) => allowedProjects.has(id));
    if (kioskIds.length) return kioskIds.some((id) => allowed.has(id));
    return true;
  });
}

function pricingForServices(serviceList = [], kioskIds = null) {
  const pricing = Object.fromEntries(serviceList.map((service) => [
    service.id,
    normalizePricingPair(db.pricing[service.id] || service.pricing || DEFAULT_PRICING.print, DEFAULT_PRICING.print)
  ]));
  const requestedKioskIds = Array.isArray(kioskIds)
    ? kioskIds.map((id) => normalizeKioskCode(id)).filter(Boolean)
    : [];
  if (!requestedKioskIds.length) {
    return pricing;
  }

  const serviceIds = new Set(serviceList.map((service) => service.id));
  const allowedKioskIds = new Set(requestedKioskIds);
  const scopedKioskPricing = {};

  Object.entries(db.pricing.__kiosks || {}).forEach(([rawKioskId, kioskPricing]) => {
    const kioskId = normalizeKioskCode(rawKioskId);
    if (!kioskId || (allowedKioskIds.size && !allowedKioskIds.has(kioskId))) return;

    const scopedPricing = {};
    Object.entries(kioskPricing || {}).forEach(([serviceId, rates]) => {
      if (!serviceIds.has(serviceId)) return;
      scopedPricing[serviceId] = normalizePricingPair(rates, pricing[serviceId]);
    });

    if (Object.keys(scopedPricing).length) {
      scopedKioskPricing[kioskId] = scopedPricing;
    }
  });

  if (Object.keys(scopedKioskPricing).length) {
    pricing.__kiosks = scopedKioskPricing;
  }

  return pricing;
}

function mergeAdminServices(session = {}, incomingServices = [], incomingPricing = null) {
  const allowedKioskIds = kioskIdsForAdmin(session);
  const allowedProjectIds = projectIdsForAdmin(session);
  if (!allowedProjectIds.size) {
    return null;
  }

  const allowedExistingIds = new Set(servicesForAdmin(session).map((service) => service.id));
  const normalizedIncoming = normalizeServices(incomingServices)
    .map((service) => {
      const existing = db.services.find((item) => item.id === service.id) || {};
      const requestedProjects = Array.isArray(service.projectIds) ? service.projectIds.map((id) => String(id || "").trim()).filter(Boolean) : [];
      const scopedProjectIds = requestedProjects.length
        ? requestedProjects.filter((id) => allowedProjectIds.has(id))
        : (Array.isArray(existing.projectIds) && existing.projectIds.length
          ? existing.projectIds.filter((id) => allowedProjectIds.has(id))
          : [...allowedProjectIds]);
      const requestedIds = Array.isArray(service.kioskIds) ? service.kioskIds.map((id) => normalizeKioskCode(id)) : [];
      const scopedIds = requestedIds.length
        ? requestedIds.filter((id) => allowedKioskIds.has(id))
        : [];

      return {
        ...service,
        projectIds: scopedProjectIds,
        kioskIds: requestedIds.length ? scopedIds : []
      };
    })
    .filter((service) => {
      if (service.projectIds?.length) return service.projectIds.some((id) => allowedProjectIds.has(String(id || "").trim()));
      if (!allowedExistingIds.has(service.id)) return true;
      if (!service.kioskIds.length) return true;
      return service.kioskIds.some((id) => allowedKioskIds.has(normalizeKioskCode(id)));
    });

  const incomingIds = new Set(normalizedIncoming.map((service) => service.id));
  db.services = [
    ...db.services.filter((service) => !allowedExistingIds.has(service.id)),
    ...normalizedIncoming
  ];

  const scopedPricing = pricingForServices(normalizedIncoming);
  const requestedScopedPricing = {};
  if (incomingPricing && typeof incomingPricing === "object") {
    Object.entries(incomingPricing).forEach(([serviceId, rates]) => {
      if (incomingIds.has(serviceId)) {
        requestedScopedPricing[serviceId] = rates;
      }
    });
  }
  db.pricing = normalizePricing({
    ...db.pricing,
    ...scopedPricing,
    ...requestedScopedPricing
  }, db.services);
  db.services = db.services.map((service) => ({
    ...service,
    pricing: db.pricing[service.id] || service.pricing
  }));

  return normalizedIncoming;
}

function isAllowedServiceImage(file) {
  if (!file?.content?.length || !file.filename) return false;
  const extension = path.extname(file.filename).toLowerCase();
  const allowedExtensions = new Set([".gif", ".jpg", ".jpeg", ".png", ".webp", ".pdf"]);
  return file.mimeType.startsWith("image/") || file.mimeType === "application/pdf" || allowedExtensions.has(extension);
}

function isAllowedClientLogo(file) {
  if (!file?.content?.length || !file.filename) return false;
  const extension = path.extname(file.filename).toLowerCase();
  const allowedExtensions = new Set([".gif", ".jpg", ".jpeg", ".png", ".webp"]);
  return file.mimeType.startsWith("image/") || allowedExtensions.has(extension);
}

function isAllowedIdleImage(file) {
  if (!file?.content?.length || !file.filename) return false;
  const extension = path.extname(file.filename).toLowerCase();
  const allowedExtensions = new Set([".gif", ".jpg", ".jpeg", ".png", ".webp"]);
  return file.mimeType.startsWith("image/") || allowedExtensions.has(extension);
}

function isAllowedIdleVideo(file) {
  if (!file?.content?.length || !file.filename) return false;
  const extension = path.extname(file.filename).toLowerCase();
  const allowedExtensions = new Set([".mp4", ".webm"]);
  return file.mimeType.startsWith("video/") || allowedExtensions.has(extension);
}

// Generous backstop, well above the largest legitimate body today (a
// MAX_FILES_PER_JOB x MAX_UPLOAD_FILE_SIZE_BYTES print upload tops out
// around 100MB) - only rejects bodies far beyond anything a real client
// sends, so normal uploads are unaffected.
const MAX_REQUEST_BODY_BYTES = 150 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let bytes = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        settled = true;
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        // JSON.parse("null")/("42")/("\"x\"") succeed but aren't usable as a
        // body object - callers do body.someField everywhere, which would
        // throw on a non-object. Fall back to the same { raw } shape already
        // used for unparseable bodies instead of letting that throw escape.
        resolve(parsed && typeof parsed === "object" ? parsed : { raw });
      } catch {
        resolve({ raw });
      }
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function parseJsonBuffer(buffer) {
  const raw = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer || "");

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        settled = true;
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function normalizedEnv(names) {
  return firstEnvValue(names);
}

function razorpayModeFromKeyId(keyId = "") {
  const match = String(keyId || "").trim().match(/^rzp_(test|live)_/i);
  return match ? match[1].toLowerCase() : "unknown";
}

function razorpayConfig() {
  const keyId = normalizedEnv(["RAZORPAY_KEY_ID", "RAZORPAY_KEY"]);

  return {
    keyId,
    keySecret: normalizedEnv(["RAZORPAY_KEY_SECRET", "RAZORPAY_SECRET"]),
    webhookSecret: normalizedEnv(["RAZORPAY_WEBHOOK_SECRET"]),
    mode: keyId ? razorpayModeFromKeyId(keyId) : "not-configured"
  };
}

function razorpayIsConfigured() {
  const config = razorpayConfig();
  return Boolean(config.keyId && config.keySecret);
}

function razorpayStatus() {
  const config = razorpayConfig();
  return {
    gateway: "razorpay",
    razorpayConfigured: Boolean(config.keyId && config.keySecret),
    razorpayMode: config.mode,
    webhookConfigured: Boolean(config.webhookSecret)
  };
}

function amountToPaise(amount) {
  return Math.round(Number(amount || 0) * 100);
}

function safeReceipt(jobId) {
  return String(jobId || `JOB-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
}

function backendOrigin(req) {
  return (process.env.BACKEND_URL || publicOrigin(req)).replace(/\/+$/, "");
}

function paymentPageUrl(req, paymentId) {
  const pageOrigin = publicFrontendOrigin(req);
  const url = new URL(pageOrigin);
  const lastSegment = url.pathname.split("/").pop() || "";
  if (url.pathname === "/" || !lastSegment.includes(".")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/index.html`;
  }
  url.search = "";
  url.hash = "";
  url.searchParams.set("mobilePayment", paymentId);
  url.searchParams.set("backendUrl", backendOrigin(req));
  return url.toString();
}

function checkoutPayload(payment, job, req = null) {
  const config = razorpayConfig();
  return {
    paymentId: payment.paymentId,
    key: config.keyId,
    orderId: payment.razorpayOrderId,
    amount: payment.amountInPaise,
    currency: payment.currency || "INR",
    name: "Smart Printing Kiosk",
    description: `${job.fileName} | ${job.pageCount} page(s)`,
    prefill: {
      name: "Kiosk Customer",
      contact: "",
      email: ""
    },
    notes: {
      jobId: job.jobId,
      kioskId: job.kioskId,
      service: job.service
    },
    paymentUrl: req ? paymentPageUrl(req, payment.paymentId) : ""
  };
}

const QR_CODE_EXPIRY_SECONDS = 15 * 60;

// A UPI QR code any payment app can scan and pay directly - no browser hop.
// Falls back to Razorpay Orders + Checkout (see /api/payment/create) if the
// merchant account isn't enabled for the QR Codes product yet.
async function createRazorpayQrCode(amount, job) {
  return razorpayRequest("POST", "/v1/payments/qr_codes", {
    type: "upi_qr",
    name: "Smart Printing Kiosk",
    usage: "single_use",
    fixed_amount: true,
    payment_amount: amount,
    description: `${job.fileName} | ${job.pageCount} page(s)`,
    close_by: Math.floor(Date.now() / 1000) + QR_CODE_EXPIRY_SECONDS,
    notes: {
      jobId: job.jobId,
      kioskId: job.kioskId,
      service: job.service
    }
  });
}

function secureCompare(expected, actual) {
  const expectedBuffer = Buffer.from(String(expected || ""), "hex");
  const actualBuffer = Buffer.from(String(actual || ""), "hex");

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function razorpayRequest(method, apiPath, body) {
  const { keyId, keySecret } = razorpayConfig();

  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = https.request(
      {
        hostname: RAZORPAY_API_BASE,
        path: apiPath,
        method,
        auth: `${keyId}:${keySecret}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 20000
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = {};

          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = { raw };
            }
          }

          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(parsed);
            return;
          }

          const message = parsed?.error?.description || parsed?.error?.reason || raw || `Razorpay HTTP ${response.statusCode}`;
          reject(new Error(message));
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Razorpay request timed out."));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function rememberRazorpayWebhookEvent(eventId) {
  if (!eventId) return false;

  if (processedRazorpayWebhookEvents.has(eventId)) {
    return true;
  }

  processedRazorpayWebhookEvents.add(eventId);

  if (processedRazorpayWebhookEvents.size > 1000) {
    const [oldest] = processedRazorpayWebhookEvents;
    processedRazorpayWebhookEvents.delete(oldest);
  }

  return false;
}

function titleStatus(value, fallback = "Webhook Received") {
  const normalized = String(value || "").trim().replace(/[_-]+/g, " ");
  if (!normalized) return fallback;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function razorpayWebhookStatus(event, paymentEntity = {}, orderEntity = {}) {
  const eventName = String(event || "").toLowerCase();
  const paymentStatus = String(paymentEntity.status || "").toLowerCase();
  const orderStatus = String(orderEntity.status || "").toLowerCase();

  if (eventName === "payment.failed" || paymentStatus === "failed") return "Failed";
  if (
    eventName === "payment.captured" ||
    eventName === "order.paid" ||
    eventName === "qr_code.credited" ||
    paymentStatus === "captured" ||
    orderStatus === "paid"
  ) {
    return "Success";
  }
  if (eventName === "payment.authorized" || paymentStatus === "authorized") return "Authorized";
  if (eventName === "order.created" || paymentStatus === "created" || orderStatus === "created") return "Pending";

  return titleStatus(paymentStatus || orderStatus || eventName);
}

function razorpayWebhookDetails(body = {}, req = { headers: {} }) {
  const payload = body.payload || {};
  const paymentEntity = payload.payment?.entity || body.payment?.entity || body.payment || {};
  const orderEntity = payload.order?.entity || body.order?.entity || body.order || {};
  const qrCodeEntity = payload.qr_code?.entity || body.qr_code?.entity || {};
  const event = String(body.event || "").trim();
  const status = razorpayWebhookStatus(event, paymentEntity, orderEntity);
  const amountInPaise = Number(paymentEntity.amount || paymentEntity.base_amount || orderEntity.amount_paid || orderEntity.amount || 0);
  const acquirerData = paymentEntity.acquirer_data || {};

  return {
    event,
    eventId: String(req.headers["x-razorpay-event-id"] || body.id || "").trim(),
    accountId: String(body.account_id || "").trim(),
    status,
    orderId: String(paymentEntity.order_id || orderEntity.id || body.razorpay_order_id || body.order_id || "").trim(),
    razorpayPaymentId: String(paymentEntity.id || body.razorpay_payment_id || "").trim(),
    qrCodeId: String(qrCodeEntity.id || "").trim(),
    kioskPaymentId: String(body.paymentId || body.payment_id || "").trim(),
    amountInPaise: Number.isFinite(amountInPaise) && amountInPaise > 0 ? amountInPaise : 0,
    currency: String(paymentEntity.currency || orderEntity.currency || body.currency || "INR").trim().toUpperCase(),
    method: String(paymentEntity.method || "").trim(),
    upiReferenceId: String(acquirerData.upi_transaction_id || acquirerData.rrn || body.upiReferenceId || "").trim(),
    failureReason: String(paymentEntity.error_description || paymentEntity.error_reason || paymentEntity.error_code || "").trim()
  };
}

function findRazorpayPaymentRecord(details = {}) {
  return db.payments.find((payment) => (
    (details.kioskPaymentId && String(payment.paymentId || "") === details.kioskPaymentId) ||
    (details.orderId && String(payment.razorpayOrderId || "") === details.orderId) ||
    (details.razorpayPaymentId && String(payment.razorpayPaymentId || "") === details.razorpayPaymentId) ||
    (details.qrCodeId && String(payment.razorpayQrCodeId || "") === details.qrCodeId)
  ));
}

function shouldQueueAfterPayment(job = {}) {
  const printStatus = String(job.printStatus || "");
  return !["Printing", "Completed"].includes(printStatus);
}

function applyRazorpayWebhookUpdate(payment, details = {}) {
  const now = new Date().toISOString();

  if (details.orderId) payment.razorpayOrderId = details.orderId;
  if (details.razorpayPaymentId) {
    payment.razorpayPaymentId = details.razorpayPaymentId;
    payment.gatewayTransactionId = details.razorpayPaymentId;
  }
  if (details.amountInPaise) {
    payment.amountInPaise = details.amountInPaise;
    payment.amount = details.amountInPaise / 100;
  }
  if (details.currency) payment.currency = details.currency;
  if (details.method) payment.razorpayMethod = details.method;
  if (details.upiReferenceId) payment.upiReferenceId = details.upiReferenceId;

  payment.status = details.status || payment.status || "Webhook Received";
  payment.razorpayWebhookEvent = details.event || payment.razorpayWebhookEvent;
  payment.razorpayWebhookEventId = details.eventId || payment.razorpayWebhookEventId;
  payment.razorpayWebhookReceivedAt = now;

  const job = findJob(payment.jobId);

  if (payment.status === "Success") {
    payment.paidAt = payment.paidAt || now;
    if (job) {
      job.paymentStatus = "Payment Success";
      if (shouldQueueAfterPayment(job)) {
        job.printStatus = "In Queue";
      }
    }
  } else if (payment.status === "Failed") {
    payment.failedAt = payment.failedAt || now;
    payment.failureReason = details.failureReason || payment.failureReason || "Razorpay payment failed.";
    if (job && job.paymentStatus !== "Payment Success") {
      job.paymentStatus = "Payment Failed";
    }
  }

  return job;
}

function verifyRazorpayWebhookBody(req, rawBody) {
  const { webhookSecret } = razorpayConfig();
  const provided = String(req.headers["x-razorpay-signature"] || "").trim();

  if (!webhookSecret) {
    return { ok: false, status: 503, error: "Razorpay webhook secret is not configured." };
  }

  if (!provided) {
    return { ok: false, status: 400, error: "Razorpay webhook signature is missing." };
  }

  const signature = provided.replace(/^sha256=/i, "");
  const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");

  if (!secureCompare(expected, signature)) {
    return { ok: false, status: 400, error: "Razorpay webhook signature verification failed." };
  }

  return { ok: true, verified: true };
}

function handlePaymentWebhook(req, res, rawBody, body = {}) {
  if (body.raw !== undefined) {
    return json(res, 400, { error: "Invalid Razorpay webhook JSON." });
  }

  const signature = verifyRazorpayWebhookBody(req, rawBody);
  if (!signature.ok) {
    return json(res, signature.status, { error: signature.error });
  }

  const details = razorpayWebhookDetails(body, req);
  if (details.eventId && processedRazorpayWebhookEvents.has(details.eventId)) {
    return json(res, 200, { ok: true, duplicate: true, event: details.event });
  }

  const payment = findRazorpayPaymentRecord(details);

  if (!payment) {
    return json(res, 202, {
      ok: true,
      matched: false,
      event: details.event,
      orderId: details.orderId || null,
      razorpayPaymentId: details.razorpayPaymentId || null
    });
  }

  rememberRazorpayWebhookEvent(details.eventId);
  const job = applyRazorpayWebhookUpdate(payment, details);
  saveData();

  return json(res, 200, {
    ok: true,
    verified: signature.verified,
    event: details.event,
    payment,
    job
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function localUploadHost() {
  if (process.env.KIOSK_UPLOAD_HOST) {
    return process.env.KIOSK_UPLOAD_HOST;
  }

  const ignoredAdapters = /virtual|vmware|vbox|loopback|docker|hyper-v|vEthernet|npcap/i;

  for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
    if (ignoredAdapters.test(name)) continue;

    for (const item of interfaces || []) {
      if (item.family === "IPv4" && !item.internal && !item.address.startsWith("169.254.")) {
        return item.address;
      }
    }
  }

  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces || []) {
      if (item.family === "IPv4" && !item.internal && !item.address.startsWith("169.254.")) {
        return item.address;
      }
    }
  }

  return "localhost";
}

function localAgentUrl() {
  return process.env.LOCAL_AGENT_URL || `http://localhost:${process.env.AGENT_PORT || 5077}`;
}

async function createMobileUploadSession(req) {
  const token = crypto.randomBytes(4).toString("hex").toUpperCase();
  const publicBaseUrl = process.env.PUBLIC_BASE_URL
    ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, "")
    : process.env.BACKEND_URL
      ? process.env.BACKEND_URL.replace(/\/+$/, "")
      : `http://${localUploadHost()}:${PORT}`;
  const uploadUrl = `${publicBaseUrl}/mobile-upload/${token}`;
  const qrSvg = await QRCode.toString(uploadUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    type: "svg",
    width: 230
  });

  const session = {
    token,
    publicBaseUrl,
    uploadUrl,
    qrSvg,
    status: "waiting",
    file: null,
    files: [],
    createdAt: new Date().toISOString()
  };

  mobileUploadSessions.set(token, session);
  return session;
}

function uploadSessionResponse(session, req = null) {
  if (!session) return null;
  const baseUrl = req ? uploadBaseUrl(req, session) : (session.publicBaseUrl || `http://${localUploadHost()}:${PORT}`).replace(/\/+$/, "");
  const files = Array.isArray(session.files) && session.files.length
    ? session.files
    : session.file ? [session.file] : [];

  const publicFiles = files.map((file, index) => ({
    name: file.name,
    size: file.size,
    mimeType: file.mimeType,
    pages: file.pages,
    previewUrl: `${baseUrl}/mobile-upload/${session.token}/file/${index}`
  }));

  return {
    token: session.token,
    uploadUrl: session.uploadUrl,
    qrSvg: session.qrSvg,
    status: session.status,
    file: publicFiles[0] || null,
    files: publicFiles
  };
}

function parseMultipartParts(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) return [];

  const boundaryText = boundaryMatch[1] || boundaryMatch[2];
  const boundary = Buffer.from(`--${boundaryText}`);
  const nextBoundary = Buffer.from(`\r\n--${boundaryText}`);
  const headerDivider = Buffer.from("\r\n\r\n");
  const crlf = Buffer.from("\r\n");
  let start = buffer.indexOf(boundary);
  const parts = [];

  while (start !== -1) {
    let headerStart = start + boundary.length;
    const finalBoundary = buffer.slice(headerStart, headerStart + 2).toString("utf8") === "--";
    if (finalBoundary) break;

    if (buffer.slice(headerStart, headerStart + 2).equals(crlf)) {
      headerStart += 2;
    }

    const headerEnd = buffer.indexOf(headerDivider, headerStart);
    if (headerEnd === -1) break;

    const headers = buffer.slice(headerStart, headerEnd).toString("utf8");
    const filenameMatch = headers.match(/filename="([^"]+)"/i);
    const nameMatch = headers.match(/name="([^"]+)"/i);
    const typeMatch = headers.match(/content-type:\s*([^\r\n]+)/i);

    const contentStart = headerEnd + 4;
    let end = buffer.indexOf(nextBoundary, contentStart);
    if (end === -1) end = buffer.length;

    if (nameMatch) {
      parts.push({
        name: nameMatch[1],
        filename: filenameMatch?.[1] || "",
        mimeType: typeMatch?.[1]?.trim() || "application/octet-stream",
        content: buffer.slice(contentStart, end)
      });
    }

    start = end < buffer.length ? end + 2 : -1;
  }

  return parts;
}

function parseMultipartFile(buffer, contentType, fieldName = "document") {
  const part = parseMultipartParts(buffer, contentType)
    .find((item) => item.filename && (!fieldName || item.name === fieldName));

  if (!part) return null;

  const extension = part.filename.includes(".") ? part.filename.split(".").pop().toUpperCase() : "";
  const pages = part.mimeType.startsWith("image/") || ["PNG", "JPG", "JPEG"].includes(extension) ? 1 : 1;

  return {
    name: part.filename,
    mimeType: part.mimeType,
    size: part.content.length,
    pages,
    content: part.content
  };
}

// Lightweight, dependency-free page-count heuristic used as a server-side
// backstop behind the mobile-upload page's own pdf.js check (which a client
// could bypass by skipping JS / calling this endpoint directly). Prefers the
// authoritative /Count on the /Pages root; falls back to counting individual
// /Type /Page objects.
function estimatePdfPageCount(buffer) {
  try {
    const text = buffer.toString("latin1");
    const countMatches = [...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)];
    if (countMatches.length) {
      const max = Math.max(...countMatches.map((match) => Number(match[1]) || 0));
      if (max > 0) return max;
    }

    const pageMatches = text.match(/\/Type\s*\/Page(?!s)\b/g);
    return pageMatches ? pageMatches.length : null;
  } catch {
    return null;
  }
}

function parseMultipartFiles(buffer, contentType) {
  return parseMultipartParts(buffer, contentType)
    .filter((part) => part.filename && ["document", "documents"].includes(part.name))
    .slice(0, MAX_FILES_PER_JOB + 1)
    .map((part) => {
      const extension = part.filename.includes(".") ? part.filename.split(".").pop().toUpperCase() : "";
      return {
        name: part.filename,
        extension,
        mimeType: part.mimeType,
        size: part.content.length,
        pages: part.mimeType.startsWith("image/") || ["PNG", "JPG", "JPEG"].includes(extension) ? 1 : 1,
        content: part.content
      };
    });
}

// Embedded as a data URI (not a URL to /assets/...) so the logo always
// renders regardless of PUBLIC_FRONTEND_URL config or whether this backend's
// deployment happens to serve the frontend's static files alongside itself.
let cachedMobileUploadLogoDataUri = null;
function mobileUploadLogoDataUri() {
  if (cachedMobileUploadLogoDataUri !== null) return cachedMobileUploadLogoDataUri;

  // Read from backend/assets (bundled with this file) rather than
  // FRONTEND_ASSET_DIR - standalone backend-only deployments (no sibling
  // frontend/ checkout) would otherwise always fail this read.
  try {
    const logoPath = path.join(__dirname, "assets", "mobile-upload-logo.png");
    const buffer = fs.readFileSync(logoPath);
    cachedMobileUploadLogoDataUri = `data:image/png;base64,${buffer.toString("base64")}`;
  } catch {
    cachedMobileUploadLogoDataUri = "";
  }

  return cachedMobileUploadLogoDataUri;
}

// Full wordmark (logo + "Aarya Innovtech Pvt. Ltd.") for the page header -
// kept separate from the compact mark-only favicon above.
let cachedMobileUploadFullLogoDataUri = null;
function mobileUploadFullLogoDataUri() {
  if (cachedMobileUploadFullLogoDataUri !== null) return cachedMobileUploadFullLogoDataUri;

  try {
    const logoPath = path.join(__dirname, "assets", "mobile-upload-full-logo.png");
    const buffer = fs.readFileSync(logoPath);
    cachedMobileUploadFullLogoDataUri = `data:image/png;base64,${buffer.toString("base64")}`;
  } catch {
    cachedMobileUploadFullLogoDataUri = "";
  }

  return cachedMobileUploadFullLogoDataUri;
}

function renderMobileUploadShell({ title, eyebrow, heading, description, content, script = "" }) {
  const logoUrl = mobileUploadLogoDataUri();
  const brandLogoUrl = mobileUploadFullLogoDataUri() || logoUrl;
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#1769f5" />
        <title>${escapeHtml(title)} | Print Kiosk</title>
        <link rel="icon" type="image/png" href="${logoUrl}" />
        <style>
          :root{--blue:#1769f5;--blue-dark:#0d47ae;--ink:#14213d;--muted:#64748b;--line:#dbe4ef;--soft:#f3f7fd;--green:#15a669;--red:#c2413b;}
          *{box-sizing:border-box;}
          html{min-height:100%;background:#eef4ff;}
          body{min-height:100vh;margin:0;background:radial-gradient(circle at 8% 4%,rgba(23,105,245,.17),transparent 30%),radial-gradient(circle at 95% 90%,rgba(21,166,105,.11),transparent 32%),linear-gradient(160deg,#f8fbff 0%,#eef4ff 100%);color:var(--ink);font-family:"Segoe UI",Inter,Arial,sans-serif;}
          body:before{background:linear-gradient(90deg,var(--blue),#20a7f7,var(--green));content:"";height:5px;left:0;position:fixed;right:0;top:0;z-index:2;}
          .page{align-items:center;display:flex;justify-content:center;min-height:100vh;padding:max(28px,env(safe-area-inset-top)) 18px max(28px,env(safe-area-inset-bottom));}
          .shell{max-width:480px;width:100%;}
          .brand{align-items:center;background:#fff;border-radius:18px;box-shadow:0 10px 26px rgba(31,74,140,.14);display:flex;justify-content:center;margin:0 auto 18px;padding:14px 20px;}
          .brand img{display:block;height:auto;width:200px;}
          .card{background:rgba(255,255,255,.96);border:1px solid rgba(205,219,238,.92);border-radius:24px;box-shadow:0 26px 70px rgba(31,74,140,.16);overflow:hidden;}
          .card-head{background:linear-gradient(145deg,#fafdff,#f1f6ff);border-bottom:1px solid var(--line);padding:28px 26px 24px;text-align:center;}
          .eyebrow{align-items:center;background:#eaf2ff;border:1px solid #cfe0ff;border-radius:999px;color:var(--blue);display:inline-flex;font-size:12px;font-weight:800;letter-spacing:.08em;padding:7px 11px;text-transform:uppercase;}
          h1{font-size:clamp(27px,7vw,34px);letter-spacing:-.035em;line-height:1.1;margin:14px 0 9px;}
          .lead{color:var(--muted);font-size:15px;line-height:1.55;margin:0 auto;max-width:370px;}
          .card-body{padding:24px 26px 28px;}
          .steps{display:grid;gap:8px;grid-template-columns:repeat(3,1fr);margin-bottom:20px;}
          .step{align-items:center;color:var(--muted);display:flex;font-size:11px;font-weight:700;gap:6px;justify-content:center;text-align:center;}
          .step span{align-items:center;background:#edf3fb;border-radius:50%;color:var(--blue);display:inline-flex;flex:0 0 22px;height:22px;justify-content:center;}
          form{display:grid;gap:16px;}
          .upload-zone{align-items:center;background:var(--soft);border:2px dashed #afc8ec;border-radius:18px;cursor:pointer;display:flex;flex-direction:column;min-height:190px;padding:26px 18px;text-align:center;transition:border-color .18s,background .18s,transform .18s;}
          .upload-zone:active,.upload-zone.selected{background:#edf5ff;border-color:var(--blue);transform:scale(.99);}
          .upload-zone input{height:1px;opacity:0;overflow:hidden;position:absolute;width:1px;}
          .upload-icon{align-items:center;background:linear-gradient(145deg,var(--blue),#34a8f4);border-radius:16px;box-shadow:0 10px 24px rgba(23,105,245,.24);color:white;display:flex;font-size:29px;font-weight:400;height:58px;justify-content:center;margin-bottom:15px;width:58px;}
          .upload-zone strong{font-size:18px;margin-bottom:5px;}
          .upload-zone small{color:var(--muted);font-size:13px;line-height:1.45;}
          .camera-button{align-items:center;background:#fff;border:1.5px solid var(--line);border-radius:14px;color:var(--blue-dark);cursor:pointer;display:flex;font-size:14px;font-weight:700;gap:9px;justify-content:center;min-height:50px;padding:0 16px;transition:border-color .18s,background .18s,transform .18s;}
          .camera-button:active{background:var(--soft);border-color:var(--blue);transform:scale(.99);}
          .camera-button input{height:1px;opacity:0;overflow:hidden;position:absolute;width:1px;}
          .camera-icon{font-size:18px;}
          .selection{background:#f8fafc;border:1px solid var(--line);border-radius:14px;padding:14px;}
          .selection[hidden],.message[hidden]{display:none;}
          .selection-head{align-items:center;display:flex;gap:10px;justify-content:space-between;margin-bottom:9px;}
          .selection-head strong{font-size:14px;}
          .selection-head button{background:none;border:0;color:var(--blue);font:inherit;font-size:13px;font-weight:700;padding:3px;}
          .file-list{display:grid;gap:7px;list-style:none;margin:0;padding:0;}
          .file-list li{align-items:center;color:#40516d;display:flex;font-size:12px;gap:8px;min-width:0;}
          .file-list li:before{background:var(--blue);border-radius:50%;content:"";flex:0 0 6px;height:6px;width:6px;}
          .file-list span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
          .message{border-radius:12px;font-size:13px;font-weight:650;line-height:1.45;padding:11px 13px;}
          .message.error{background:#fff0ef;border:1px solid #fac9c5;color:var(--red);}
          .privacy{align-items:flex-start;color:var(--muted);display:flex;font-size:12px;gap:8px;line-height:1.45;margin:0;}
          .privacy:before{color:var(--green);content:"\\2713";font-weight:900;}
          .submit{background:linear-gradient(135deg,var(--blue),var(--blue-dark));border:0;border-radius:14px;box-shadow:0 13px 26px rgba(23,105,245,.22);color:#fff;font:inherit;font-size:16px;font-weight:800;min-height:54px;padding:0 20px;transition:opacity .18s,transform .18s;width:100%;}
          .submit:not(:disabled):active{transform:translateY(1px);}
          .submit:disabled{box-shadow:none;cursor:not-allowed;opacity:.45;}
          .footer{color:#718096;font-size:11px;line-height:1.5;margin:15px auto 0;max-width:390px;text-align:center;}
          .status{align-items:center;display:flex;flex-direction:column;padding:12px 0 4px;text-align:center;}
          .status-icon{align-items:center;background:#e8f8f1;border:1px solid #b9ead3;border-radius:50%;color:var(--green);display:flex;font-size:34px;font-weight:800;height:76px;justify-content:center;margin-bottom:18px;width:76px;}
          .status-icon.warn{background:#fff5e8;border-color:#f3d3a5;color:#a15c10;}
          .status h2{font-size:24px;margin:0 0 9px;}
          .status p{color:var(--muted);line-height:1.55;margin:0;max-width:340px;}
          .status-note{background:var(--soft);border-radius:12px;color:#40516d;font-size:13px;font-weight:650;margin-top:20px;padding:13px 15px;width:100%;}
          .status .camera-button{margin-top:20px;width:100%;}
          .scan-overlay{align-items:center;background:rgba(10,18,36,.92);bottom:0;display:none;flex-direction:column;justify-content:center;left:0;padding:22px;position:fixed;right:0;top:0;z-index:20;}
          .scan-overlay.open{display:flex;}
          .scan-frame{background:#000;border-radius:18px;max-width:360px;overflow:hidden;position:relative;width:100%;}
          .scan-frame video{display:block;height:auto;width:100%;}
          .scan-frame:after{border:3px solid rgba(255,255,255,.55);border-radius:16px;bottom:14px;content:"";left:14px;position:absolute;right:14px;top:14px;}
          .scan-hint{color:#fff;font-size:13px;font-weight:650;margin:16px 0 0;text-align:center;}
          .scan-hint.error{color:#ffb4ae;}
          .scan-cancel{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.3);border-radius:12px;color:#fff;font:inherit;font-size:14px;font-weight:700;margin-top:18px;min-height:46px;padding:0 22px;}
          @media(max-width:380px){.page{padding-left:12px;padding-right:12px}.card-head{padding:24px 19px 20px}.card-body{padding:20px 19px 23px}.brand img{width:170px}.step{display:grid;justify-items:center}.upload-zone{min-height:175px}}
        </style>
      </head>
      <body>
        <main class="page">
          <div class="shell">
            <a class="brand" href="#" aria-label="Print Kiosk"><img src="${brandLogoUrl}" alt="Aarya Innovtech Pvt. Ltd." /></a>
            <section class="card">
              <header class="card-head">
                <span class="eyebrow">${escapeHtml(eyebrow)}</span>
                <h1>${escapeHtml(heading)}</h1>
                <p class="lead">${escapeHtml(description)}</p>
              </header>
              <div class="card-body">${content}</div>
            </section>
            <p class="footer">Your documents are used only for this print session. Complete payment and printing on the kiosk screen.</p>
          </div>
        </main>
        ${script ? `<script>${script}</script>` : ""}
      </body>
    </html>
  `;
}

function scanAgainScript() {
  return `
    (function () {
      var btn      = document.getElementById('scan-again-btn');
      var overlay  = document.getElementById('scan-overlay');
      var video    = document.getElementById('scan-video');
      var hint     = document.getElementById('scan-hint');
      var cancel   = document.getElementById('scan-cancel');
      if (!btn) return;

      var stream = null;
      var detector = null;
      var rafId = null;

      function setHint(text, isError) {
        if (!hint) return;
        hint.textContent = text || '';
        hint.classList.toggle('error', Boolean(isError));
      }

      function stopScan() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
        if (stream) {
          stream.getTracks().forEach(function (track) { track.stop(); });
          stream = null;
        }
        if (overlay) overlay.classList.remove('open');
      }

      function isSafeMobileUploadUrl(value) {
        try {
          var url = new URL(value, window.location.href);
          return url.origin === window.location.origin && /^\\/mobile-upload\\/[^/]+\\/?$/.test(url.pathname);
        } catch (err) {
          return false;
        }
      }

      function tick() {
        if (!detector || !video) return;
        detector.detect(video).then(function (codes) {
          if (codes && codes.length) {
            var value = codes[0].rawValue || '';
            if (isSafeMobileUploadUrl(value)) {
              setHint('New QR code found. Opening upload page...', false);
              stopScan();
              window.location.href = value;
              return;
            }
            setHint('That QR code is not a Print Kiosk upload code. Point the camera at the kiosk screen.', true);
          }
          rafId = requestAnimationFrame(tick);
        }).catch(function () {
          rafId = requestAnimationFrame(tick);
        });
      }

      btn.addEventListener('click', function () {
        if (!('BarcodeDetector' in window) || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setHint('Your browser cannot scan QR codes on this page. Open your phone\\'s Camera app and point it at the new QR code on the kiosk screen.', true);
          if (overlay) overlay.classList.add('open');
          var frame = document.querySelector('.scan-frame');
          if (frame) frame.style.display = 'none';
          return;
        }

        setHint('Starting camera...', false);
        if (overlay) overlay.classList.add('open');

        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function (mediaStream) {
          stream = mediaStream;
          video.srcObject = stream;
          video.play();
          detector = new window.BarcodeDetector({ formats: ['qr_code'] });
          setHint('Point the camera at the new QR code on the kiosk screen.', false);
          rafId = requestAnimationFrame(tick);
        }).catch(function () {
          setHint('Camera permission is needed to scan. Open your phone\\'s Camera app instead and point it at the new QR code on the kiosk screen.', true);
        });
      });

      if (cancel) cancel.addEventListener('click', stopScan);
      window.addEventListener('pagehide', stopScan);
    })();
  `;
}

function renderMobileStatusPage({ title, heading, description, note, warning = false }) {
  return renderMobileUploadShell({
    title,
    eyebrow: warning ? "Session notice" : "Upload complete",
    heading,
    description,
    content: `
      <div class="status">
        <div class="status-icon ${warning ? "warn" : ""}">${warning ? "!" : "&#10003;"}</div>
        <h2>${warning ? "Scan again" : "You are all set"}</h2>
        <p>${escapeHtml(note)}</p>
        <div class="status-note">${warning ? "Return to the Print Kiosk and generate a new QR code." : "Return to the kiosk to preview your documents and continue to payment."}</div>
        ${warning ? `<button type="button" id="scan-again-btn" class="camera-button"><span class="camera-icon" aria-hidden="true">&#128247;</span> Scan New QR Code</button>` : ""}
      </div>
      ${warning ? `
        <div class="scan-overlay" id="scan-overlay">
          <div class="scan-frame"><video id="scan-video" muted playsinline autoplay></video></div>
          <p class="scan-hint" id="scan-hint"></p>
          <button type="button" class="scan-cancel" id="scan-cancel">Cancel</button>
        </div>
      ` : ""}
    `,
    script: warning ? scanAgainScript() : ""
  });
}

function renderMobileUploadPage(session) {
  if (!session) {
    return renderMobileStatusPage({
      title: "Upload link expired",
      heading: "This upload link has expired",
      description: "For your privacy, each Print Kiosk QR code works for one short upload session.",
      note: "No files were uploaded. Use the kiosk screen to create a fresh upload code.",
      warning: true
    });
  }

  // Session already used: block as soon as status=uploaded.
  // Do NOT wait for session.claimed — that requires the kiosk to poll first.
  // Blocking immediately closes the race window where a fast user could
  // re-visit and re-upload before the kiosk had a chance to poll.
  if (session.status === "uploaded") {
    return renderMobileStatusPage({
      title: "Session used",
      heading: "This upload session is no longer active",
      description: "The kiosk has already received your documents and moved to the preview screen.",
      note: "Go back to the kiosk and tap Back to get a new QR code if you want to upload a different file.",
      warning: true
    });
  }

  const token = escapeHtml(session.token);

  // Inline script: AJAX submit + instant UI swap + real-time polling
  const script = `
    (function () {
      var TOKEN   = ${JSON.stringify(session.token)};
      var MAX     = ${MAX_FILES_PER_JOB};
      var POLL_MS = 2500;
      var supported = /\\.(pdf|jpe?g|png)$/i;
      var MAX_FILE_SIZE_BYTES = ${MAX_UPLOAD_FILE_SIZE_BYTES};

      var form         = document.getElementById('upload-form');
      var input        = document.getElementById('documents');
      var zone         = document.getElementById('upload-zone');
      var selection    = document.getElementById('selection');
      var count        = document.getElementById('selection-count');
      var list         = document.getElementById('file-list');
      var message      = document.getElementById('message');
      var clearButton  = document.getElementById('clear-files');
      var submitButton = document.getElementById('submit-button');
      var cardHead     = document.querySelector('.card-head');
      var cardBody     = document.querySelector('.card-body');
      var poller       = null;

      /* ── helpers ─────────────────────────────── */
      function showError(text) {
        message.textContent = text;
        message.hidden = !text;
      }

      function resetFiles() {
        input.value = '';
        selection.hidden = true;
        zone.classList.remove('selected');
        submitButton.disabled = true;
        list.replaceChildren();
      }

      /* ── PDF page-count limit (must match MAX_UPLOAD_PAGES_PER_DOCUMENT in
         frontend/app.js) - rejected here, on the phone, before the file is
         ever sent to the kiosk. ─────────────────── */
      var MAX_PDF_PAGES = 10;
      var pdfjsPromise = null;
      function loadPdfJs() {
        if (!pdfjsPromise) {
          pdfjsPromise = import('/assets/vendor/pdfjs/pdf.min.mjs').then(function (lib) {
            lib.GlobalWorkerOptions.workerSrc = '/assets/vendor/pdfjs/pdf.worker.min.mjs';
            return lib;
          });
        }
        return pdfjsPromise;
      }

      function checkPdfPageLimits(files) {
        var pdfFiles = files.filter(function (f) { return /\.pdf$/i.test(f.name); });
        if (!pdfFiles.length) return Promise.resolve(null);

        return loadPdfJs().then(function (pdfjsLib) {
          return Promise.all(pdfFiles.map(function (f) {
            return f.arrayBuffer()
              .then(function (buf) { return pdfjsLib.getDocument({ data: buf }).promise; })
              .then(function (pdf) { return { name: f.name, pages: pdf.numPages }; })
              .catch(function () { return { name: f.name, pages: null }; });
          }));
        }).then(function (results) {
          var tooMany = results.find(function (r) { return r.pages && r.pages > MAX_PDF_PAGES; });
          if (!tooMany) return null;
          return tooMany.name + ' has ' + tooMany.pages + ' pages. This kiosk allows up to ' + MAX_PDF_PAGES + ' pages per document.';
        }).catch(function () { return null; });
      }

      function finalizeSelection(files) {
        count.textContent = files.length + (files.length === 1 ? ' file selected' : ' files selected');
        list.replaceChildren();
        files.slice(0, 4).forEach(function (f) {
          var li = document.createElement('li');
          var sp = document.createElement('span');
          sp.textContent = f.name;
          li.appendChild(sp);
          list.appendChild(li);
        });
        if (files.length > 4) {
          var li = document.createElement('li');
          var sp = document.createElement('span');
          sp.textContent = '+ ' + (files.length - 4) + ' more file(s)';
          li.appendChild(sp);
          list.appendChild(li);
        }
        selection.hidden = false;
        zone.classList.add('selected');
        submitButton.disabled = false;
      }

      /* ── file picker ─────────────────────────── */
      function applySelectedFiles(files) {
        showError('');

        if (files.length > MAX) {
          resetFiles();
          showError('Choose no more than ' + MAX + ' files.');
          return;
        }
        if (files.some(function (f) { return !supported.test(f.name); })) {
          resetFiles();
          showError('Only PDF, JPG, JPEG, and PNG files are supported.');
          return;
        }
        var oversizedFile = files.find(function (f) { return f.size > MAX_FILE_SIZE_BYTES; });
        if (oversizedFile) {
          resetFiles();
          showError(oversizedFile.name + ' is too large (' + (oversizedFile.size / (1024 * 1024)).toFixed(1) + ' MB). This kiosk allows up to 10 MB per document.');
          return;
        }
        if (!files.length) { resetFiles(); return; }

        submitButton.disabled = true;
        showError('Checking document…');

        checkPdfPageLimits(files).then(function (pageError) {
          if (pageError) {
            resetFiles();
            showError(pageError);
            return;
          }
          showError('');
          finalizeSelection(files);
        });
      }

      input.addEventListener('change', function () {
        applySelectedFiles(Array.from(input.files || []));
      });

      clearButton.addEventListener('click', resetFiles);

      /* ── sent view ───────────────────────────── */
      function showSentView(fileCount) {
        // Swap header
        cardHead.innerHTML =
          '<span class="eyebrow">Upload complete</span>' +
          '<h1>Documents Sent!</h1>' +
          '<p class="lead">Your ' + (fileCount === 1 ? 'file is' : fileCount + ' files are') +
          ' ready on the Print Kiosk screen.</p>';

        // Swap body to scan-again state
        cardBody.innerHTML =
          '<div class="status">' +
            '<div class="status-icon" id="sent-icon">&#10003;</div>' +
            '<h2 id="sent-title">You are all set</h2>' +
            '<p id="sent-msg">Continue on the kiosk to review and pay.</p>' +
            '<div class="status-note" id="sent-note">' +
              'This QR session is now closed. To upload more files, go back to the kiosk and tap <strong>Back</strong> to get a new QR code.' +
            '</div>' +
          '</div>';

        startPolling();
      }

      /* ── real-time polling ───────────────────── */
      function startPolling() {
        if (poller) return;
        poller = setInterval(function () {
          fetch('/api/mobile-upload/' + TOKEN + '/status')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
              if (!data) { clearInterval(poller); return; }
              // Session not found means the kiosk has started fresh — show scan-again
              if (data.error) {
                clearInterval(poller);
                showScanAgain();
              }
            })
            .catch(function () {});
        }, POLL_MS);
      }

      function showScanAgain() {
        var icon  = document.getElementById('sent-icon');
        var title = document.getElementById('sent-title');
        var msg   = document.getElementById('sent-msg');
        var note  = document.getElementById('sent-note');
        if (icon)  { icon.classList.add('warn'); icon.textContent = '!'; }
        if (title) title.textContent = 'Scan a new QR code';
        if (msg)   msg.textContent   = 'The kiosk has moved on. Your previous session is closed.';
        if (note)  note.innerHTML    = 'Return to the kiosk and tap <strong>Back</strong> to generate a fresh QR code, then scan it with your phone.';
      }

      /* ── AJAX submit ─────────────────────────── */
      form.addEventListener('submit', function (e) {
        e.preventDefault();

        var files = Array.from(input.files || []);
        if (!files.length) { showError('Please choose at least one file.'); return; }

        submitButton.disabled = true;
        submitButton.textContent = 'Sending securely\u2026';
        showError('');

        var fd = new FormData(form);

        fetch('/mobile-upload/' + TOKEN + '/upload', {
          method: 'POST',
          body: fd
        })
        .then(function (r) {
          if (r.ok || r.status === 409) {
            // 200 = accepted, 409 = already used (treat both as done)
            showSentView(files.length);
          } else {
            return r.text().then(function () {
              showError('Upload failed. Please try again.');
              submitButton.disabled = false;
              submitButton.textContent = 'Send to Print Kiosk';
            });
          }
        })
        .catch(function () {
          showError('Network error. Check your connection and try again.');
          submitButton.disabled = false;
          submitButton.textContent = 'Send to Print Kiosk';
        });
      });
    })();
  `;

  return renderMobileUploadShell({
    title: "Upload documents",
    eyebrow: "Secure kiosk upload",
    heading: "Upload your documents",
    description: `Send up to ${MAX_FILES_PER_JOB} files directly to the Print Kiosk you just scanned.`,
    content: `
      <div class="steps" aria-label="Upload steps">
        <div class="step"><span>1</span>Choose</div>
        <div class="step"><span>2</span>Send</div>
        <div class="step"><span>3</span>Preview</div>
      </div>
      <form id="upload-form" enctype="multipart/form-data">
        <label class="upload-zone" id="upload-zone" for="documents">
          <input id="documents" name="documents" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" multiple required />
          <span class="upload-icon" aria-hidden="true">&#8593;</span>
          <strong>Choose documents</strong>
          <small>Tap to browse PDF, JPG, or PNG files<br />Maximum ${MAX_FILES_PER_JOB} files</small>
        </label>
        <div class="message error" id="message" role="alert" hidden></div>
        <div class="selection" id="selection" hidden>
          <div class="selection-head"><strong id="selection-count"></strong><button id="clear-files" type="button">Clear</button></div>
          <ul class="file-list" id="file-list"></ul>
        </div>
        <p class="privacy">Files are securely linked to this kiosk session and are not shown to other users.</p>
        <button class="submit" id="submit-button" type="submit" disabled>Send to Print Kiosk</button>
      </form>
    `,
    script
  });
}

function normalizeJobPrintOptions(body = {}, existingJob = {}) {
  const source = { ...(existingJob && typeof existingJob === "object" ? existingJob : {}), ...(body && typeof body === "object" ? body : {}) };

  return {
    kioskId: normalizeKioskCode(source.kioskId || defaultKioskId()),
    copies: Math.max(1, Number(source.copies || 1)),
    colorMode: String(source.colorMode || "").toLowerCase() === "color" ? "color" : "bw",
    paperSize: String(source.paperSize || "A4").trim() || "A4",
    sides: String(source.sides || "").toLowerCase() === "duplex" ? "duplex" : "single",
    orientation: String(source.orientation || "").toLowerCase() === "landscape" ? "landscape" : "portrait",
    pageRange: String(source.pageRange || source.range || "all").trim() || "all"
  };
}

function validateCustomerJobOptions(body = {}, existingJob = null) {
  const options = normalizeJobPrintOptions(body, existingJob || {});
  const kioskSettings = normalizeKioskCustomerSettings(kioskForConfig(options.kioskId)?.customerSettings);
  const serviceId = String(body.service || existingJob?.service || "").trim();
  const service = db.services.find((item) => item.id === serviceId) || null;
  const serviceSettings = normalizeServiceCustomerSettings(service?.customerSettings);
  const settings = {
    ...kioskSettings,
    bw: kioskSettings.bw && serviceSettings.bw,
    color: kioskSettings.color && serviceSettings.color,
    copies: kioskSettings.copies && serviceSettings.copies
  };

  if (options.colorMode === "color" && !settings.color) {
    return "Color printing is disabled by Super Admin for this kiosk.";
  }

  if (options.colorMode === "bw" && !settings.bw) {
    return "B/W printing is disabled by Super Admin for this kiosk.";
  }

  if (options.copies > 1 && !settings.copies) {
    return "Multiple copies are disabled by Super Admin for this kiosk.";
  }

  if (options.sides === "duplex" && !settings.sides) {
    return "Both-side printing is disabled by Super Admin for this kiosk.";
  }

  if (options.orientation === "landscape" && !settings.orientation) {
    return "Landscape orientation is disabled by Super Admin for this kiosk.";
  }

  if (options.pageRange.toLowerCase() !== "all" && !settings.pageRange) {
    return "Page range selection is disabled by Super Admin for this kiosk.";
  }

  return "";
}

function createJob(body) {
  const printOptions = normalizeJobPrintOptions(body);
  const job = {
    jobId: body.jobId || `JOB-${Date.now()}`,
    kioskId: printOptions.kioskId,
    service: body.service || "print",
    fileName: body.fileName || "pending-upload.pdf",
    fileType: body.fileType || "PDF",
    templateId: body.templateId || "",
    pageCount: Number(body.pageCount || 1),
    copies: printOptions.copies,
    colorMode: printOptions.colorMode,
    paperSize: printOptions.paperSize,
    sides: printOptions.sides,
    orientation: printOptions.orientation,
    pageRange: printOptions.pageRange,
    amount: 0,
    paymentStatus: "Draft",
    printStatus: "Draft",
    createdAt: new Date().toISOString(),
    completedAt: null
  };

  db.jobs.push(job);
  saveData();
  return job;
}

function computePriceAmount(job) {
  const pages = Math.max(1, Number(job.pageCount) || 1);
  const copies = Math.max(1, Number(job.copies) || 1);
  const rates = serviceRates(job.service, job.kioskId);
  const rate = job.colorMode === "color" ? rates.color : rates.bw;
  return { amount: pages * copies * rate, rate };
}

function calculatePrice(job) {
  const { amount, rate } = computePriceAmount(job);
  job.amount = amount;
  job.rate = rate;
  job.printStatus = "Price Calculated";
  saveData();
  return amount;
}

function findJob(jobId) {
  return db.jobs.find((job) => job.jobId === jobId);
}

function upsertPaymentJob(body) {
  const job = findJob(body.jobId) || createJob(body);
  const printOptions = normalizeJobPrintOptions(body, job);

  Object.assign(job, {
    kioskId: printOptions.kioskId,
    service: body.service || job.service,
    fileName: body.fileName || job.fileName,
    fileType: body.fileType || job.fileType,
    templateId: body.templateId || job.templateId || "",
    pageCount: Number(body.pageCount || job.pageCount || 1),
    copies: printOptions.copies,
    colorMode: printOptions.colorMode,
    paperSize: printOptions.paperSize,
    sides: printOptions.sides,
    orientation: printOptions.orientation,
    pageRange: printOptions.pageRange,
    printStatus: "Price Calculated"
  });

  calculatePrice(job);
  return job;
}

function setJobPrintStatus(job, printStatus, extra = {}) {
  job.printStatus = printStatus || job.printStatus;

  if (/completed/i.test(job.printStatus)) {
    job.completedAt = new Date().toISOString();
    // Whether the local print agent actually observed this job reach the
    // printer queue and clear it, vs. just gave up waiting after never
    // seeing it (still reported as a completed job either way - see
    // waitForWindowsPrintCompletion() in local-agent/printerAgent.js -
    // but this flag lets an operator tell the two apart if a customer
    // reports a job that never physically printed).
    if (typeof extra.completionConfirmed === "boolean") {
      job.completionConfirmed = extra.completionConfirmed;
    }
  }

  if (/failed/i.test(job.printStatus)) {
    job.failedAt = new Date().toISOString();
    job.failureReason = extra.failureReason || job.failureReason || "Print failed";
  }

  // Clear any "stuck in queue" alert (see checkStaleJobs()) the moment the
  // job actually reaches a terminal state, even if that happened after the
  // sweep already flagged it as stale - otherwise the alert would stay
  // "active" forever once it's no longer true.
  if (/completed|failed/i.test(job.printStatus)) {
    const staleAlertTitle = `${job.kioskId || "Kiosk"} - Print Job Stuck (${job.jobId})`;
    const staleAlert = db.alertLogs.find((a) => a.title === staleAlertTitle && a.status === "active");
    if (staleAlert) {
      staleAlert.status = "resolved";
      staleAlert.resolvedAt = new Date().toISOString();
    }
  }

  saveData();
  return job;
}

function isoNow() {
  return new Date().toISOString();
}

function normalizeActivationDeviceId(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 128);
}

function validateKioskActivationRequest(body = {}) {
  const kioskId = normalizeKioskCode(body.kioskId);
  const setupCode = normalizeKioskCode(body.setupCode, 16);
  const activationDeviceId = normalizeActivationDeviceId(body.deviceId || body.activationDeviceId || body.machineId || "");
  const kiosk = db.kiosks.find((item) => normalizeKioskCode(item.kioskId) === kioskId);

  if (!kioskId || !setupCode || !activationDeviceId) {
    return {
      status: 400,
      error: "Kiosk ID, setup code, and device identity are required. Use the latest mini-PC installer."
    };
  }

  if (!kiosk || normalizeKioskCode(kiosk.setupCode, 16) !== setupCode) {
    return {
      status: 403,
      error: "Invalid kiosk ID or setup code."
    };
  }

  const existingDeviceId = normalizeActivationDeviceId(kiosk.activationDeviceId || kiosk.deviceId || "");
  if (kiosk.activatedAt && existingDeviceId && existingDeviceId !== activationDeviceId) {
    return {
      status: 409,
      error: `Kiosk ${kiosk.kioskId} is already activated on another mini PC. Create a new kiosk ID or reset this kiosk before installing it on different hardware.`
    };
  }

  return {
    kiosk,
    kioskId,
    setupCode,
    activationDeviceId,
    existingDeviceId
  };
}

function normalizeReleaseVersion(value = "") {
  return String(value || "")
    .trim()
    .replace(/^v/i, "")
    .replace(/[^0-9A-Za-z.+-]/g, "")
    .slice(0, 64);
}

function compareReleaseVersions(left, right) {
  const parse = (value) => {
    const [core, prerelease = ""] = normalizeReleaseVersion(value).split("-", 2);
    return {
      core: core.split(".").map((part) => Number(part) || 0),
      prerelease
    };
  };
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.core.length, b.core.length, 3);

  for (let index = 0; index < length; index += 1) {
    const difference = (a.core[index] || 0) - (b.core[index] || 0);
    if (difference) return difference > 0 ? 1 : -1;
  }

  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function normalizeKioskRelease(record = {}, existing = {}) {
  const next = { ...existing, ...record };
  const version = normalizeReleaseVersion(next.version || existing.version);
  if (!version) return null;

  const channel = String(next.channel || "production").trim().toLowerCase() === "staging"
    ? "staging"
    : "production";
  const rolloutPercentage = Math.max(0, Math.min(100, Number(next.rolloutPercentage ?? 100) || 0));

  return {
    ...next,
    releaseId: String(existing.releaseId || next.releaseId || `REL-${channel}-${version}`).trim(),
    version,
    channel,
    downloadUrl: String(next.downloadUrl || "").trim(),
    sha256: String(next.sha256 || "").trim().toLowerCase(),
    signature: String(next.signature || "").trim(),
    signatureAlgorithm: "RSA-SHA256",
    signingKeyId: String(next.signingKeyId || "primary").trim().slice(0, 64),
    sizeBytes: Math.max(0, Math.round(Number(next.sizeBytes || 0))),
    rolloutPercentage,
    targetKioskIds: [...new Set((Array.isArray(next.targetKioskIds)
      ? next.targetKioskIds
      : String(next.targetKioskIds || "").split(","))
      .map((item) => String(item || "").trim().toUpperCase())
      .filter(Boolean))],
    mandatory: next.mandatory === true || String(next.mandatory).toLowerCase() === "true",
    active: next.active !== false && String(next.active).toLowerCase() !== "false",
    notes: String(next.notes || "").trim().slice(0, 2000),
    publishedAt: next.publishedAt || existing.publishedAt || isoNow(),
    createdAt: existing.createdAt || next.createdAt || isoNow(),
    updatedAt: isoNow()
  };
}

function validateReleaseRecord(release) {
  if (!release?.version) return "Release version is required.";
  if (!/^https:\/\//i.test(release.downloadUrl)) return "Release download URL must use HTTPS.";
  if (!/^[a-f0-9]{64}$/i.test(release.sha256)) return "Release SHA-256 must contain 64 hexadecimal characters.";
  if (!release.signature) return "A build signature is required.";
  if (!Number.isFinite(release.sizeBytes) || release.sizeBytes < 1000000) return "Release size must be at least 1 MB.";
  return "";
}

function validateKioskDevice(input = {}) {
  const kioskId = normalizeKioskCode(input.kioskId);
  const deviceId = normalizeActivationDeviceId(input.deviceId || "");
  const kiosk = db.kiosks.find((item) => normalizeKioskCode(item.kioskId) === kioskId);

  if (!kioskId || !deviceId) return { status: 400, error: "Kiosk ID and device identity are required." };
  if (!kiosk || !kiosk.activatedAt) return { status: 403, error: "This kiosk has not been activated." };
  if (normalizeActivationDeviceId(kiosk.activationDeviceId) !== deviceId) {
    return { status: 403, error: "Device identity does not match this kiosk activation." };
  }

  return { kiosk, kioskId, deviceId };
}

function releaseRolloutIncludesKiosk(release, kioskId) {
  const targetKioskIds = Array.isArray(release.targetKioskIds) ? release.targetKioskIds : [];
  if (targetKioskIds.length) return targetKioskIds.includes(kioskId);

  const rolloutPercentage = Number.isFinite(release.rolloutPercentage) ? release.rolloutPercentage : 100;
  if (rolloutPercentage >= 100) return true;
  if (rolloutPercentage <= 0) return false;

  const bucket = Number.parseInt(
    crypto.createHash("sha256").update(`${release.releaseId}:${kioskId}`).digest("hex").slice(0, 8),
    16
  ) % 10000;
  return bucket < Math.round(rolloutPercentage * 100);
}

function releaseForKiosk(kiosk, currentVersion, requestedChannel = "") {
  const channel = String(requestedChannel || kiosk.updateChannel || "production").trim().toLowerCase() === "staging"
    ? "staging"
    : "production";

  return db.releases
    .filter((release) => release.active && release.channel === channel)
    .filter((release) => compareReleaseVersions(release.version, currentVersion) > 0)
    .filter((release) => releaseRolloutIncludesKiosk(release, kiosk.kioskId))
    .sort((left, right) => compareReleaseVersions(right.version, left.version))[0] || null;
}

function publicReleaseManifest(release) {
  if (!release) return null;
  return {
    releaseId: release.releaseId,
    version: release.version,
    channel: release.channel,
    downloadUrl: release.downloadUrl,
    sha256: release.sha256,
    signature: release.signature,
    signatureAlgorithm: release.signatureAlgorithm,
    signingKeyId: release.signingKeyId,
    sizeBytes: release.sizeBytes,
    mandatory: release.mandatory,
    notes: release.notes,
    publishedAt: release.publishedAt
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function decodeSegment(value = "") {
  try {
    return decodeURIComponent(value);
  } catch {
    return String(value || "");
  }
}

function normalizeSuperAdminJob(record = {}, existing = {}) {
  const next = { ...existing, ...record };
  const createdAt = next.createdAt || existing.createdAt || isoNow();

  return {
    ...next,
    jobId: String(existing.jobId || next.jobId || `JOB-${Date.now()}`).trim(),
    kioskId: normalizeKioskCode(next.kioskId || defaultKioskId()) || defaultKioskId(),
    service: String(next.service || "print").trim(),
    fileName: String(next.fileName || "admin-created-job.pdf").trim(),
    fileType: String(next.fileType || "PDF").trim().toUpperCase(),
    pageCount: Math.max(1, Number(next.pageCount || 1)),
    copies: Math.max(1, Number(next.copies || 1)),
    colorMode: next.colorMode === "color" ? "color" : "bw",
    paperSize: String(next.paperSize || "A4").trim(),
    amount: numericPrice(next.amount, 0),
    paymentStatus: String(next.paymentStatus || "Draft").trim(),
    printStatus: String(next.printStatus || "Draft").trim(),
    createdAt,
    completedAt: next.completedAt || null
  };
}

function normalizeSuperAdminPayment(record = {}, existing = {}) {
  const next = { ...existing, ...record };
  const amount = numericPrice(next.amount, 0);

  return {
    ...next,
    paymentId: String(existing.paymentId || next.paymentId || `PAY-${Date.now()}`).trim(),
    gateway: String(next.gateway || "manual").trim(),
    jobId: String(next.jobId || "").trim(),
    amount,
    amountInPaise: Math.round(Number(next.amountInPaise || amount * 100)),
    currency: String(next.currency || "INR").trim().toUpperCase(),
    paymentMethod: String(next.paymentMethod || "Manual").trim(),
    status: String(next.status || "Pending").trim(),
    createdAt: next.createdAt || existing.createdAt || isoNow()
  };
}

function normalizeSuperAdminKiosk(record = {}, existing = {}) {
  const next = { ...existing, ...record };
  const kioskId = normalizeKioskCode(existing.kioskId || next.kioskId) || nextUniqueKioskId();
  const setupCode = normalizeKioskCode(next.setupCode || existing.setupCode, 16) || uniqueKioskSetupCode("", kioskId);
  const customerSettings = normalizeKioskCustomerSettings(next.customerSettings, existing.customerSettings);

  return {
    ...next,
    kioskId,
    name: String(next.name || "New Kiosk").trim(),
    branch: String(next.branch || "Unassigned Branch").trim(),
    projectId: slug(next.projectId || existing.projectId || "default-project", "default-project"),
    adminId: next.adminId ? normalizeAdminId(next.adminId, "") : "",
    status: ["online", "offline", "maintenance"].includes(String(next.status || "").toLowerCase())
      ? String(next.status).toLowerCase()
      : "offline",
    printer: String(next.printer || "unknown").trim(),
    scanner: String(next.scanner || "unknown").trim(),
    appVersion: String(next.appVersion || "1.0.0").trim(),
    updateChannel: String(next.updateChannel || existing.updateChannel || "production").trim().toLowerCase() === "staging" ? "staging" : "production",
    updateStatus: KIOSK_UPDATE_STATUSES.has(String(next.updateStatus || "").toLowerCase())
      ? String(next.updateStatus).toLowerCase()
      : "current",
    updateTargetVersion: normalizeReleaseVersion(next.updateTargetVersion || ""),
    updateLastCheckAt: next.updateLastCheckAt || null,
    updateLastAttemptAt: next.updateLastAttemptAt || null,
    updateCompletedAt: next.updateCompletedAt || null,
    updateLastError: String(next.updateLastError || "").trim().slice(0, 1000),
    updateMessage: String(next.updateMessage || "").trim().slice(0, 1000),
    setupCode,
    customerSettings,
    activatedAt: next.activatedAt || existing.activatedAt || null,
    activationDeviceId: normalizeActivationDeviceId(next.activationDeviceId || existing.activationDeviceId || next.deviceId || ""),
    lastOnline: next.lastOnline || isoNow()
  };
}

function normalizeKioskPrinterHealth(record = {}) {
  const source = record && typeof record === "object" ? record : {};
  const snmpSource = source.snmp && typeof source.snmp === "object" ? source.snmp : null;
  const snmp = snmpSource ? {
    enabled: Boolean(snmpSource.enabled),
    host: String(snmpSource.host || "").trim().slice(0, 160),
    configured: Boolean(snmpSource.configured),
    autoDetected: Boolean(snmpSource.autoDetected),
    autoDetect: Boolean(snmpSource.autoDetect),
    required: Boolean(snmpSource.required),
    ok: Boolean(snmpSource.ok),
    ready: Boolean(snmpSource.ready),
    offline: Boolean(snmpSource.offline),
    paperJam: Boolean(snmpSource.paperJam),
    noPaper: Boolean(snmpSource.noPaper),
    paperLow: Boolean(snmpSource.paperLow),
    doorOpen: Boolean(snmpSource.doorOpen),
    tonerEmpty: Boolean(snmpSource.tonerEmpty),
    tonerLow: Boolean(snmpSource.tonerLow),
    outputBinFull: Boolean(snmpSource.outputBinFull),
    serviceRequested: Boolean(snmpSource.serviceRequested),
    paperStatus: String(snmpSource.paperStatus || "").trim().slice(0, 80),
    tonerStatus: String(snmpSource.tonerStatus || "").trim().slice(0, 80),
    printerStatus: Number(snmpSource.printerStatus || 0),
    errorMessage: String(snmpSource.errorMessage || "").trim().slice(0, 500),
    lastCheckedAt: snmpSource.lastCheckedAt || null
  } : null;

  return {
    available: source.available !== false,
    online: Boolean(source.online),
    ready: Boolean(source.ready),
    busy: Boolean(source.busy),
    checking: Boolean(source.checking),
    paper: source.paper !== false,
    paperLow: Boolean(source.paperLow),
    paperJam: Boolean(source.paperJam),
    doorOpen: Boolean(source.doorOpen),
    tonerLow: Boolean(source.tonerLow),
    tonerEmpty: Boolean(source.tonerEmpty),
    queueError: Boolean(source.queueError),
    outputBinFull: Boolean(source.outputBinFull),
    serviceRequested: Boolean(source.serviceRequested),
    printing: Boolean(source.printing),
    workOffline: Boolean(source.workOffline),
    errorMessage: String(source.errorMessage || "").trim().slice(0, 500),
    printerName: String(source.printerName || "").trim().slice(0, 160),
    queueLength: Math.max(0, Number(source.queueLength || 0)),
    paperStatus: String(source.paperStatus || "Unknown").trim().slice(0, 80),
    tonerStatus: String(source.tonerStatus || "Unknown").trim().slice(0, 80),
    detectedErrorState: Number(source.detectedErrorState || 0),
    detectedErrorText: String(source.detectedErrorText || "Unknown").trim().slice(0, 80),
    printerStatus: Number(source.printerStatus || 0),
    observedStatus: String(source.observedStatus || "").trim().slice(0, 40),
    observedErrorMessage: String(source.observedErrorMessage || "").trim().slice(0, 500),
    snmp,
    lastUpdated: source.lastUpdated || isoNow()
  };
}

function normalizeSuperAdminService(record = {}, existing = {}) {
  return normalizeServices([{ ...existing, ...record, id: existing.id || record.id }])[0];
}

function superAdminCollectionConfig(collection) {
  return {
    projects: {
      key: "projectId",
      get: () => db.projects,
      set: (items) => {
        db.projects = items.map((project) => normalizeSuperAdminProject(project));
      },
      normalize: normalizeSuperAdminProject
    },
    jobs: {
      key: "jobId",
      get: () => db.jobs,
      set: (items) => {
        db.jobs = items;
      },
      normalize: normalizeSuperAdminJob
    },
    payments: {
      key: "paymentId",
      get: () => db.payments,
      set: (items) => {
        db.payments = items;
      },
      normalize: normalizeSuperAdminPayment
    },
    kiosks: {
      key: "kioskId",
      get: () => db.kiosks,
      set: (items) => {
        db.kiosks = items;
      },
      normalize: normalizeSuperAdminKiosk
    },
    kioskAdmins: {
      key: "adminId",
      get: () => db.kioskAdmins,
      set: (items) => {
        db.kioskAdmins = normalizeKioskAdmins(items);
      },
      normalize: normalizeKioskAdmin
    },
    services: {
      key: "id",
      get: () => db.services,
      set: (items) => {
        db.services = normalizeServices(items);
      },
      normalize: normalizeSuperAdminService
    },
    releases: {
      key: "releaseId",
      get: () => db.releases,
      set: (items) => {
        db.releases = items.map((release) => normalizeKioskRelease(release)).filter(Boolean);
      },
      normalize: normalizeKioskRelease
    }
  }[collection];
}

function syncServicePricing() {
  db.pricing = normalizePricing(db.pricing, db.services);
  db.services = db.services.map((service) => ({
    ...service,
    pricing: db.pricing[service.id] || service.pricing
  }));
}

function pricingFromServices(services = db.services) {
  return Object.fromEntries(
    normalizeServices(services).map((service) => [
      service.id,
      { ...service.pricing }
    ])
  );
}

function syncServiceSavePricing(pricing = null) {
  const servicePricing = pricingFromServices(db.services);
  const source = pricing && typeof pricing === "object"
    ? { ...servicePricing, ...pricing }
    : { ...db.pricing, ...servicePricing };

  db.pricing = normalizePricing(source, db.services);
  db.services = db.services.map((service) => ({
    ...service,
    pricing: db.pricing[service.id] || service.pricing
  }));
}

// Returns { ok, error } from the final, most complete save (saveData()'s
// snapshot already includes everything saveSettings() would have captured),
// so a caller can await this and know whether the edit it just made actually
// persisted - see handleSuperAdminCollection() below, which rolls back and
// reports an error to the admin instead of a false "saved" when it didn't.
async function saveSuperAdminCollection(collection) {
  if (collection === "services" || collection === "pricing" || collection === "kiosks") {
    if (collection === "services") {
      syncServiceSavePricing();
    } else if (collection === "pricing") {
      syncServicePricing();
    }
    touchConfig(`${collection}-updated`);
    if (collection === "services" || collection === "pricing") {
      await saveSettings();
    }
  } else if (collection === "admins") {
    // Bump config version when client brand/logo/name changes so kiosks refresh in real time.
    touchConfig("brand-updated");
    await saveSettings();
  }

  return saveData();
}

function superAdminSummary() {
  const gross = db.jobs.reduce((sum, job) => sum + (job.paymentStatus === "Payment Success" ? Number(job.amount || 0) : 0), 0);
  const templates = db.services.reduce((sum, service) => sum + (service.templates?.length || 0), 0);

  return {
    kioskAdmins: db.kioskAdmins.length,
    projects: db.projects.length,
    kiosks: db.kiosks.length,
    services: db.services.length,
    templates,
    jobs: db.jobs.length,
    payments: db.payments.length,
    releases: db.releases.length,
    gross,
    net: gross,
    failedJobs: db.jobs.filter((job) => /failed/i.test(job.printStatus || "")).length,
    activeKiosks: db.kiosks.filter((kiosk) => kiosk.status === "online").length
  };
}

function buildSuperAdminHierarchy() {
  return db.kiosks.map((kiosk) => {
    const project = db.projects.find((item) => item.projectId === kiosk.projectId) || null;
    const kioskAdmin = db.kioskAdmins.find((admin) => (
      admin.adminId === project?.adminId ||
      (admin.projectIds || []).includes(kiosk.projectId)
    )) || null;
    const kioskCode = normalizeKioskCode(kiosk.kioskId);
    const kioskJobs = db.jobs.filter((job) => normalizeKioskCode(job.kioskId) === kioskCode);
    const jobIds = new Set(kioskJobs.map((job) => job.jobId));
    const serviceIds = new Set(kioskJobs.map((job) => job.service));
    const kioskServices = db.services
      .filter((service) => serviceAppliesToKiosk(service, kiosk, kiosk.kioskId) || serviceIds.has(service.id))
      .map((service) => {
        const serviceJobs = kioskJobs.filter((job) => job.service === service.id);
        const revenue = serviceJobs.reduce((sum, job) => sum + (job.paymentStatus === "Payment Success" ? Number(job.amount || 0) : 0), 0);

        return {
          ...service,
          jobCount: serviceJobs.length,
          revenue,
          failedJobs: serviceJobs.filter((job) => /failed/i.test(job.printStatus || "")).length
        };
      });

    return {
      ...kiosk,
      project,
      admin: kioskAdmin ? publicKioskAdmin(kioskAdmin) : null,
      services: kioskServices,
      jobs: kioskJobs,
      payments: db.payments.filter((payment) => jobIds.has(payment.jobId)),
      totals: {
        jobs: kioskJobs.length,
        payments: db.payments.filter((payment) => jobIds.has(payment.jobId)).length,
        revenue: kioskJobs.reduce((sum, job) => sum + (job.paymentStatus === "Payment Success" ? Number(job.amount || 0) : 0), 0),
        failedJobs: kioskJobs.filter((job) => /failed/i.test(job.printStatus || "")).length
      }
    };
  });
}

function superAdminSnapshot() {
  return {
    summary: superAdminSummary(),
    hierarchy: buildSuperAdminHierarchy(),
    data: {
      jobs: db.jobs,
      payments: db.payments,
      services: db.services,
      pricing: db.pricing,
      kiosks: db.kiosks,
      projects: db.projects,
      kioskAdmins: db.kioskAdmins.map(publicKioskAdmin),
      releases: db.releases,
      config: db.config,
      alertLogs: db.alertLogs
    },
    config: db.config,
    updatedAt: isoNow()
  };
}

function findCollectionItem(config, itemId) {
  return config.get().find((item) => String(item[config.key]) === itemId);
}

function validateSuperAdminRecord(collection, record, existing = null) {
  if (collection === "releases") {
    return validateReleaseRecord(record);
  }

  if (collection === "projects") {
    if (!record.adminId) return "Select a client before saving this project.";
    if (!db.kioskAdmins.some((admin) => admin.adminId === record.adminId)) {
      return "Select an existing client for this project.";
    }
  }

  if (collection === "kiosks") {
    const kioskId = normalizeKioskCode(record.kioskId);
    const setupCode = normalizeKioskCode(record.setupCode, 16);
    const ignoreKioskId = normalizeKioskCode(existing?.kioskId || "");

    if (!kioskId) return "Kiosk ID is required.";
    if (kioskIdInUse(kioskId, ignoreKioskId)) return "Kiosk ID already exists. Use a unique kiosk ID.";
    if (!setupCode) return "Mini PC setup code is required.";
    // Setup codes are intentionally allowed to repeat across kiosks - the
    // kiosk ID (always unique, checked above) is what the installer/backend
    // actually key activation off of, so the same code can be reused as a
    // standard install PIN for every kiosk instead of tracking one per kiosk.
    if (!db.projects.some((project) => project.projectId === record.projectId)) {
      return "Select an existing project before creating the kiosk.";
    }
  }

  if (collection === "kioskAdmins") {
    const invalidProject = (record.projectIds || []).find((projectId) => !db.projects.some((project) => project.projectId === projectId));
    if (invalidProject) return `Project ${invalidProject} does not exist.`;
  }

  if (collection === "services") {
    if (!(record.projectIds || []).length) {
      return "Select at least one existing project before assigning this service.";
    }
    const invalidProject = (record.projectIds || []).find((projectId) => !db.projects.some((project) => project.projectId === projectId));
    if (invalidProject) return `Project ${invalidProject} does not exist.`;
  }

  return "";
}

function handleSuperAdminTemplate(req, res, parts, body) {
  const serviceId = decodeSegment(parts[3]);
  const templateId = decodeSegment(parts[5] || "");
  const service = db.services.find((item) => item.id === serviceId);

  if (!service) {
    return json(res, 404, { error: "Service not found" });
  }

  service.templates = Array.isArray(service.templates) ? service.templates : [];

  if (req.method === "GET" && !templateId) {
    return json(res, 200, { templates: service.templates });
  }

  if (req.method === "POST" && !templateId) {
    const template = normalizeTemplates([{ ...(body.template || body) }])[0];
    if (!template) return json(res, 400, { error: "Template title is required." });
    if (service.templates.some((item) => item.id === template.id)) {
      return json(res, 409, { error: "Template already exists." });
    }
    service.mode = "template";
    service.templates.push(template);
    saveSuperAdminCollection("services");
    return json(res, 201, { template, service });
  }

  const index = service.templates.findIndex((item) => item.id === templateId);

  if (index === -1) {
    return json(res, 404, { error: "Template not found" });
  }

  if (req.method === "GET") {
    return json(res, 200, { template: service.templates[index] });
  }

  if (req.method === "PUT" || req.method === "PATCH") {
    const updated = normalizeTemplates([{ ...service.templates[index], ...(body.template || body), id: service.templates[index].id }])[0];
    service.templates[index] = updated;
    saveSuperAdminCollection("services");
    return json(res, 200, { template: updated, service });
  }

  if (req.method === "DELETE") {
    const [template] = service.templates.splice(index, 1);
    saveSuperAdminCollection("services");
    return json(res, 200, { deleted: template, service });
  }

  return json(res, 405, { error: "Unsupported template operation." });
}

// Async so POST/PUT/PATCH/DELETE below can await the actual persist before
// telling the admin it worked - see saveSuperAdminCollection() and the
// comment on persistSnapshotWithRetry() for why this matters: a save used to
// report success to the admin regardless of whether it actually reached
// RDS, so a transient failure could silently revert an edit (like a kiosk's
// assigned services) the next time the backend process restarted, with
// nothing in the meantime showing anything was ever wrong.
async function handleSuperAdminCollection(req, res, collection, itemId, body) {
  const config = superAdminCollectionConfig(collection);

  if (!config) {
    return json(res, 404, { error: `Unknown super admin collection: "${collection}".` });
  }

  const items = config.get();

  if (req.method === "GET" && !itemId) {
    return json(res, 200, { [collection]: items, count: items.length });
  }

  if (req.method === "GET" && itemId) {
    const item = findCollectionItem(config, itemId);
    if (!item) return json(res, 404, { error: "Record not found" });
    return json(res, 200, { [collection.slice(0, -1) || "record"]: item });
  }

  if (req.method === "POST" && !itemId) {
    const record = config.normalize(body[collection.slice(0, -1)] || body);
    const validationError = validateSuperAdminRecord(collection, record);
    if (validationError) return json(res, 400, { error: validationError });
    const id = String(record[config.key]);
    if (!id) return json(res, 400, { error: `${config.key} is required.` });
    if (items.some((item) => String(item[config.key]).toUpperCase() === id.toUpperCase())) {
      return json(res, 409, { error: "Record already exists." });
    }
    const previousItems = items.slice();
    items.push(record);
    config.set(items);
    const saveResult = await saveSuperAdminCollection(collection);
    if (!saveResult?.ok) {
      config.set(previousItems);
      return json(res, 502, { error: "Could not save the new record. Please try again." });
    }
    return json(res, 201, { record, [collection]: config.get() });
  }

  if ((req.method === "PUT" || req.method === "PATCH") && itemId) {
    const index = items.findIndex((item) => String(item[config.key]) === itemId);
    if (index === -1) return json(res, 404, { error: "Record not found" });
    const record = config.normalize({ ...items[index], ...(body[collection.slice(0, -1)] || body), [config.key]: items[index][config.key] }, items[index]);
    const validationError = validateSuperAdminRecord(collection, record, items[index]);
    if (validationError) return json(res, 400, { error: validationError });
    const previousItems = items.slice();
    items[index] = record;
    config.set(items);
    const saveResult = await saveSuperAdminCollection(collection);
    if (!saveResult?.ok) {
      config.set(previousItems);
      return json(res, 502, { error: "Could not save the update. Please try again." });
    }
    return json(res, 200, { record, [collection]: config.get() });
  }

  if (req.method === "DELETE" && itemId) {
    const index = items.findIndex((item) => String(item[config.key]) === itemId);
    if (index === -1) return json(res, 404, { error: "Record not found" });
    if (collection === "services" && items.length <= 1) {
      return json(res, 409, { error: "At least one service must remain." });
    }
    if (collection === "projects" && db.kiosks.some((kiosk) => kiosk.projectId === itemId)) {
      return json(res, 409, { error: "Move this project's kiosks before deleting it." });
    }
    if (collection === "projects" && db.kioskAdmins.some((admin) => (admin.projectIds || []).includes(itemId))) {
      return json(res, 409, { error: "Remove this project from its client allocation before deleting it." });
    }
    if (collection === "kioskAdmins") {
      if (items.length <= 1) {
        return json(res, 409, { error: "At least one client must remain." });
      }
      if (db.projects.some((project) => project.adminId === normalizeAdminId(itemId)) || db.kiosks.some((kiosk) => kiosk.adminId && normalizeAdminId(kiosk.adminId) === normalizeAdminId(itemId))) {
        return json(res, 409, { error: "Move this admin's projects and kiosks to another admin before deleting." });
      }
    }
    const previousItems = items.slice();
    const previousPricingEntry = db.pricing[itemId];
    const [deleted] = items.splice(index, 1);
    config.set(items);
    if (collection === "services") {
      delete db.pricing[itemId];
    }
    const saveResult = await saveSuperAdminCollection(collection);
    if (!saveResult?.ok) {
      config.set(previousItems);
      if (collection === "services" && previousPricingEntry !== undefined) {
        db.pricing[itemId] = previousPricingEntry;
      }
      return json(res, 502, { error: "Could not save the deletion. Please try again." });
    }
    return json(res, 200, { deleted, [collection]: config.get() });
  }

  return json(res, 405, { error: "Unsupported super admin operation." });
}

// Serializes concurrent /api/payment/create calls per jobId (see usage
// below) so two near-simultaneous requests for the same job (double-tap,
// a retry after a slow response) can't both pass the "no pending payment
// yet" check and each create a separate Razorpay order/QR.
const paymentCreationLocks = new Map();

const server = http.createServer(async (req, res) => {
 try {
  if (req.method === "OPTIONS") return json(res, 200, { ok: true });

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/api/payment/webhook") {
    const rawBody = await readRawBody(req);
    return handlePaymentWebhook(req, res, rawBody, parseJsonBuffer(rawBody));
  }

  const isMultipart = req.headers["content-type"]?.includes("multipart/form-data");
  const shouldReadJsonBody = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !isMultipart;
  const body = shouldReadJsonBody ? await readBody(req) : {};

  if (req.method === "GET" && url.pathname === "/") {
    return redirect(res, "/index.html");
  }

  if (DISABLE_ADMIN_ACCESS && (
    url.pathname === "/admin" ||
    url.pathname === "/super-admin" ||
    url.pathname.startsWith("/api/admin/") ||
    url.pathname.startsWith("/api/super-admin/")
  )) {
    return json(res, 403, { error: "Admin access is disabled on this kiosk." });
  }

  if (DISABLE_SUPER_ADMIN_ACCESS && (
    url.pathname === "/super-admin" ||
    url.pathname.startsWith("/api/super-admin/")
  )) {
    return json(res, 403, { error: "Super Admin access is disabled on this domain." });
  }

  if (req.method === "GET" && url.pathname === "/admin") {
    return redirect(res, "/admin.html");
  }

  if (req.method === "GET" && url.pathname === "/super-admin") {
    return redirect(res, "/super-admin.html");
  }

  // Branded customer-facing alias for the QR/mobile-payment link (see
  // buildMobilePaymentUrl() in frontend/app.js) - normalizeIndexPageUrl()
  // there always appends "/index.html" to an extensionless configured URL,
  // so PUBLIC_FRONTEND_URL=".../printingkiosk" actually produces
  // ".../printingkiosk/index.html?mobilePayment=...&backendUrl=...";
  // both forms are handled here. The query string (mobilePayment/backendUrl)
  // is preserved on redirect - dropping it would break the "continue on
  // your phone" flow for anyone who scans the QR.
  if (req.method === "GET" && (url.pathname === "/printingkiosk" || url.pathname === "/printingkiosk/index.html")) {
    return redirect(res, `/index.html${url.search}`);
  }

  if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
    return serveFrontendAsset(res, url.pathname);
  }

  const frontendFilename = path.basename(url.pathname);
  if (req.method === "GET" && url.pathname === `/${frontendFilename}` && FRONTEND_FILES.has(frontendFilename)) {
    if (DISABLE_ADMIN_ACCESS && ADMIN_FRONTEND_FILES.has(frontendFilename)) {
      return json(res, 403, { error: "Admin access is disabled on this kiosk." });
    }
    if (DISABLE_SUPER_ADMIN_ACCESS && SUPER_ADMIN_FRONTEND_FILES.has(frontendFilename)) {
      return json(res, 403, { error: "Super Admin access is disabled on this domain." });
    }

    return serveFrontendFile(res, frontendFilename);
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, {
      ok: true,
      service: "printing-kiosk-backend",
      persistence: rdsStore.enabled() ? "postgresql" : "local-json",
      payments: razorpayStatus(),
      time: new Date().toISOString()
    });
  }

  if (req.method === "GET" && url.pathname === "/api/public/services") {
    return json(res, 200, publicServicesResponse({
      kioskId: url.searchParams.get("kioskId") || "",
      projectId: url.searchParams.get("projectId") || url.searchParams.get("project") || "",
      adminId: url.searchParams.get("adminId") || url.searchParams.get("clientId") || url.searchParams.get("ownerId") || "",
      adminEmail: url.searchParams.get("adminEmail") || url.searchParams.get("email") || "",
      demo: url.searchParams.get("demo") === "true" || url.searchParams.get("kioskDemo") === "true"
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const result = authenticatedAdminResponse(body);
    return json(res, result.status, result.body);
  }

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    const result = authenticatedAdminResponse(body);
    if (result.body.role !== "kiosk-admin") {
      return json(res, 401, { error: "Invalid client credentials." });
    }
    return json(res, result.status, result.body);
  }

  if (req.method === "POST" && url.pathname === "/api/super-admin/login") {
    const result = authenticatedAdminResponse(body);
    if (result.body.role !== "super-admin") {
      return json(res, 401, { error: "Invalid super admin credentials." });
    }
    return json(res, result.status, result.body);
  }

  if (url.pathname.startsWith("/api/admin/") && url.pathname !== "/api/admin/login") {
    if (!requireAdminSession(req, res, "kiosk-admin")) return;
  }

  // Narrow, explicit carve-out: idle-screensaver settings and this kiosk
  // admin's own pricing are the only things a client can self-manage from
  // the Admin panel today. /api/admin/pricing's handler (see below) already
  // filters both the service IDs and the __kiosks override keys down to
  // servicesForAdmin(adminSession)/kioskIdsForAdmin(adminSession) before
  // writing anything, so a kiosk admin can only ever move rates for their
  // own assigned services/kiosks, never anyone else's - added deliberately,
  // not by widening this blindly. Every other admin write path (projects,
  // kiosks, services, ...) stays Super-Admin-only exactly as before - do
  // not widen this set casually.
  const ADMIN_SELF_SERVICE_WRITE_PATHS = new Set([
    "/api/admin/idle-screensaver",
    "/api/admin/idle-image",
    "/api/admin/idle-video",
    "/api/admin/pricing"
  ]);

  if (
    url.pathname.startsWith("/api/admin/") &&
    url.pathname !== "/api/admin/login" &&
    req.method !== "GET" &&
    !ADMIN_SELF_SERVICE_WRITE_PATHS.has(url.pathname)
  ) {
    return json(res, 403, { error: "Create, update, and delete actions are available only in Super Admin." });
  }

  if (url.pathname.startsWith("/api/super-admin/") && url.pathname !== "/api/super-admin/login") {
    if (!requireAdminSession(req, res, "super-admin")) return;
  }

  if (req.method === "GET" && url.pathname === "/api/kiosk/update/manifest") {
    const validation = validateKioskDevice(Object.fromEntries(url.searchParams.entries()));
    if (validation.error) return json(res, validation.status, { error: validation.error });

    const currentVersion = normalizeReleaseVersion(url.searchParams.get("currentVersion") || validation.kiosk.appVersion || "0.0.0");
    const requestedChannel = url.searchParams.get("channel") || validation.kiosk.updateChannel || "production";
    const release = releaseForKiosk(validation.kiosk, currentVersion, requestedChannel);
    const checkedAt = isoNow();

    Object.assign(validation.kiosk, {
      appVersion: currentVersion || validation.kiosk.appVersion,
      updateChannel: String(requestedChannel).toLowerCase() === "staging" ? "staging" : "production",
      updateStatus: release ? "available" : "current",
      updateTargetVersion: release?.version || "",
      updateLastCheckAt: checkedAt,
      lastOnline: checkedAt
    });
    if (!release) validation.kiosk.updateLastError = "";
    saveData();

    return json(res, 200, {
      ok: true,
      updateAvailable: Boolean(release),
      currentVersion,
      manifest: publicReleaseManifest(release),
      checkedAt
    });
  }

  if (req.method === "POST" && url.pathname === "/api/kiosk/update/status") {
    const validation = validateKioskDevice(body);
    if (validation.error) return json(res, validation.status, { error: validation.error });

    const status = String(body.status || "current").trim().toLowerCase();
    if (!KIOSK_UPDATE_STATUSES.has(status)) {
      return json(res, 400, { error: "Unknown kiosk update status." });
    }

    const now = isoNow();
    const currentVersion = normalizeReleaseVersion(body.currentVersion || validation.kiosk.appVersion || "0.0.0");
    Object.assign(validation.kiosk, {
      appVersion: currentVersion || validation.kiosk.appVersion,
      updateChannel: String(body.channel || validation.kiosk.updateChannel || "production").toLowerCase() === "staging" ? "staging" : "production",
      updateStatus: status,
      updateTargetVersion: normalizeReleaseVersion(body.targetVersion || validation.kiosk.updateTargetVersion || ""),
      updateLastCheckAt: now,
      updateLastError: status === "failed" || status === "rollback" ? String(body.error || "Update failed.").slice(0, 1000) : "",
      updateMessage: String(body.error || "").slice(0, 1000),
      lastOnline: now
    });

    if (["downloading", "installing", "rollback"].includes(status)) validation.kiosk.updateLastAttemptAt = now;
    if (status === "updated") {
      validation.kiosk.updateCompletedAt = now;
      validation.kiosk.updateTargetVersion = "";
    }
    saveData();

    return json(res, 200, { ok: true, kiosk: validation.kiosk });
  }

function kioskPrinterHealthAlerts(kiosk = {}) {
  const printerHealth = kiosk.printerHealth && typeof kiosk.printerHealth === "object"
    ? kiosk.printerHealth
    : null;
  if (!printerHealth) return [];

  const kioskId = kiosk.kioskId || "Kiosk";
  const printerName = printerHealth.printerName || kiosk.printer || "Printer";
  const paperStatus = String(printerHealth.paperStatus || "").toLowerCase();
  const tonerStatus = String(printerHealth.tonerStatus || "").toLowerCase();
  const alerts = [];
  const add = (category, title, detail, tone = "bad") => {
    alerts.push({
      title: `${kioskId} - ${title}`,
      detail: `${printerName}: ${detail}`,
      tone,
      source: "printer",
      category,
      kioskId
    });
  };

  const paperJam = Boolean(printerHealth.paperJam) || paperStatus.includes("jam");
  const noPaper = printerHealth.paper === false || paperStatus.includes("no paper") || paperStatus.includes("out of paper") || paperStatus.includes("empty");
  const paperLow = Boolean(printerHealth.paperLow) || paperStatus.includes("low");
  const doorOpen = Boolean(printerHealth.doorOpen) || paperStatus.includes("door");
  const tonerEmpty = Boolean(printerHealth.tonerEmpty) || tonerStatus.includes("no toner") || tonerStatus.includes("empty") || tonerStatus.includes("replace");
  const tonerLow = Boolean(printerHealth.tonerLow) || tonerStatus.includes("low");
  const queueError = Boolean(printerHealth.queueError);

  if (paperJam) add("paper", "Paper jam detected", "clear the paper jam and close all trays");
  else if (noPaper) add("paper", "Paper empty", "load paper in the tray");
  else if (paperLow) add("paper", "Paper low", "refill paper soon", "warn");

  if (doorOpen) add("paper", "Printer door open", "close the printer door or tray");
  if (tonerEmpty) add("toner", "Toner empty", "replace the toner cartridge");
  else if (tonerLow) add("toner", "Toner low", "keep a replacement toner ready", "warn");
  if (printerHealth.outputBinFull) add("paper", "Output tray full", "remove printed pages from the output tray");
  if (printerHealth.serviceRequested) add("service", "Printer service required", printerHealth.errorMessage || "service intervention required");
  if (queueError) add("queue", "Print queue blocked", printerHealth.errorMessage || "clear the Windows print queue");

  if (alerts.length === 0 && !printerHealth.online && printerHealth.errorMessage) {
    add("queue", "Printer Offline", printerHealth.errorMessage);
  }

  return alerts;
}

  if (req.method === "GET" && url.pathname === "/api/kiosk/config") {
    return json(res, 200, kioskConfigResponse(url.searchParams.get("kioskId") || ""));
  }

  if (req.method === "POST" && url.pathname === "/api/kiosk/health") {
    const kioskId = normalizeKioskCode(body.kioskId);
    const kiosk = db.kiosks.find((item) => normalizeKioskCode(item.kioskId) === kioskId);
    if (!kiosk) return json(res, 404, { error: "Kiosk not found." });

    // Unlike its siblings (/api/kiosk/update/manifest, /status), this
    // heartbeat isn't sent with a deviceId today, so it can't be hard-gated
    // behind validateKioskDevice() without breaking every currently-deployed
    // kiosk. Only reject when a deviceId IS present and doesn't match the
    // activation on record - closes the "guess a kioskId, spoof its health"
    // gap for any future/updated caller without touching today's callers.
    if (body.deviceId && kiosk.activatedAt && normalizeActivationDeviceId(kiosk.activationDeviceId) !== normalizeActivationDeviceId(body.deviceId)) {
      return json(res, 403, { error: "Device identity does not match this kiosk activation." });
    }

    const printerHealth = normalizeKioskPrinterHealth(body.printerHealth || body.printer || {});
    const now = isoNow();
    // Use `ready` (printer physically ready) for printer readiness.
    // `available` just means the agent responded — it is always true.
    // A printer with a paper jam has available=true but ready=false, so
    // we must use ready to correctly flag printer hardware errors.
    const printerOnline = printerHealth.ready || (
      printerHealth.online &&
      printerHealth.paper !== false &&
      !printerHealth.paperJam &&
      !printerHealth.tonerEmpty &&
      !printerHealth.doorOpen &&
      !printerHealth.outputBinFull &&
      !printerHealth.serviceRequested &&
      !printerHealth.queueError &&
      !printerHealth.checking
    );

    // This request reaching the backend is itself proof the kiosk PC is online —
    // do not let a printer hardware issue (door open, paper jam, ...) mark the
    // whole kiosk "offline". That collapsed real printer errors into a generic
    // "Kiosk Offline" alert on the admin dashboard instead of the actual issue.
    // Kiosk network status is only ever set offline by the heartbeat timeout
    // sweep (checkKioskTimeouts) when this endpoint stops being called.
    Object.assign(kiosk, {
      status: "online",
      printerReady: printerOnline,
      printerErrorMessage: printerOnline ? null : (printerHealth.errorMessage || null),
      printer: printerHealth.printerName || kiosk.printer || "unknown",
      printerHealth,
      scanner: String(body.scannerStatus || kiosk.scanner || "unknown").trim(),
      // The kiosk PC reaching this endpoint only proves it can reach ITS OWN
      // backend (often just http://localhost on a standalone install) - not
      // that it has real internet. internetOnline is a separate signal the
      // kiosk's Electron main process measures against external hosts, kept
      // distinct from `status` above for exactly that reason. Older kiosk
      // builds that don't send it yet just keep whatever was last known.
      internetOnline: typeof body.internetOnline === "boolean" ? body.internetOnline : (kiosk.internetOnline !== false),
      lastOnline: now
    });

    const newAlerts = kioskPrinterHealthAlerts(kiosk);

    newAlerts.forEach(na => {
      const existingActive = db.alertLogs.find(a => a.kioskId === kiosk.kioskId && a.title === na.title && a.status === 'active');
      if (!existingActive) {
         db.alertLogs.push({
           id: "ALT-" + Date.now() + "-" + Math.floor(Math.random()*1000),
           kioskId: kiosk.kioskId,
           category: na.category,
           title: na.title,
           detail: na.detail,
           tone: na.tone,
           status: 'active',
           createdAt: now,
           resolvedAt: null
         });
      }
    });

    db.alertLogs.filter(a => a.kioskId === kiosk.kioskId && a.status === 'active').forEach(activeAlert => {
       const stillActive = newAlerts.find(na => na.title === activeAlert.title);
       if (!stillActive) {
          activeAlert.status = 'resolved';
          activeAlert.resolvedAt = now;
       }
    });

    saveData();

    return json(res, 200, { ok: true, kiosk });
  }

  if (req.method === "POST" && url.pathname === "/api/kiosk/admin-unlock") {
    const result = kioskAdminUnlockResponse(body);
    return json(res, result.status, result.body);
  }

  if (req.method === "POST" && url.pathname === "/api/kiosk/setup/check") {
    const validation = validateKioskActivationRequest(body);
    if (validation.error) {
      return json(res, validation.status, { error: validation.error });
    }

    return json(res, 200, {
      ok: true,
      kiosk: {
        kioskId: validation.kiosk.kioskId,
        name: validation.kiosk.name,
        branch: validation.kiosk.branch,
        status: validation.kiosk.status,
        activatedAt: validation.kiosk.activatedAt || null,
        alreadyActivated: Boolean(validation.kiosk.activatedAt),
        deviceLocked: Boolean(validation.existingDeviceId)
      }
    });
  }

  if (req.method === "POST" && url.pathname === "/api/kiosk/setup/activate") {
    const validation = validateKioskActivationRequest(body);
    if (validation.error) {
      return json(res, validation.status, { error: validation.error });
    }

    const { kiosk, activationDeviceId, existingDeviceId } = validation;
    kiosk.status = "online";
    kiosk.activatedAt = kiosk.activatedAt || isoNow();
    kiosk.activationDeviceId = existingDeviceId || activationDeviceId;
    kiosk.lastOnline = isoNow();
    saveData();

    return json(res, 200, {
      ok: true,
      kiosk: {
        kioskId: kiosk.kioskId,
        name: kiosk.name,
        branch: kiosk.branch,
        status: kiosk.status,
        activatedAt: kiosk.activatedAt,
        deviceLocked: true
      }
    });
  }

  if (req.method === "GET" && url.pathname.startsWith("/uploads/service-images/")) {
    const filename = path.basename(decodeURIComponent(url.pathname.split("/").pop() || ""));
    const filePath = path.join(SERVICE_IMAGE_DIR, filename);

    if (!filename || !filePath.startsWith(SERVICE_IMAGE_DIR) || !fs.existsSync(filePath)) {
      return json(res, 404, { error: "Service image not found" });
    }

    return binary(res, 200, fs.readFileSync(filePath), imageContentType(filename), { cacheControl: IMMUTABLE_UPLOAD_CACHE_CONTROL });
  }

  if (req.method === "GET" && url.pathname.startsWith("/uploads/client-logos/")) {
    const filename = path.basename(decodeURIComponent(url.pathname.split("/").pop() || ""));
    const filePath = path.join(CLIENT_LOGO_DIR, filename);

    if (!filename || !filePath.startsWith(CLIENT_LOGO_DIR) || !fs.existsSync(filePath)) {
      return json(res, 404, { error: "Client logo not found" });
    }

    return binary(res, 200, fs.readFileSync(filePath), imageContentType(filename), { cacheControl: IMMUTABLE_UPLOAD_CACHE_CONTROL });
  }

  if (req.method === "GET" && url.pathname === "/api/asset-proxy") {
    const targetUrl = url.searchParams.get("url") || "";

    if (!targetUrl || !assetProxyAllowedHost(targetUrl)) {
      return json(res, 403, { error: "That URL is not an allowed asset host." });
    }

    try {
      const asset = await fetchRemoteBinary(targetUrl);
      return binary(res, 200, asset.body, asset.contentType);
    } catch (error) {
      return json(res, 502, { error: error.message || "Could not fetch the asset." });
    }
  }

  if (req.method === "POST" && (url.pathname === "/api/admin/service-image" || url.pathname === "/api/super-admin/service-image")) {
    if (!isMultipart) {
      return json(res, 400, { error: "Upload must use multipart/form-data." });
    }

    const parts = parseMultipartParts(await readRawBody(req), req.headers["content-type"] || "");
    const file = parts.find((part) => part.filename && ["image", "serviceImage", "templateImage"].includes(part.name)) ||
      parts.find((part) => part.filename);

    if (!isAllowedServiceImage(file)) {
      return json(res, 400, { error: "Upload a PNG, JPG, GIF, WebP, or PDF template document." });
    }

    if (file.content.length > 8 * 1024 * 1024) {
      return json(res, 413, { error: "Template document must be 8 MB or smaller." });
    }

    ensureUploadDirs();
    const filename = safeUploadedImageName(file.filename);
    fs.writeFileSync(path.join(SERVICE_IMAGE_DIR, filename), file.content);

    return json(res, 201, {
      imageUrl: `${publicOrigin(req)}/uploads/service-images/${encodeURIComponent(filename)}`,
      documentType: path.extname(filename).toLowerCase() === ".pdf" ? "pdf" : "image",
      filename,
      size: file.content.length
    });
  }

  if (req.method === "POST" && url.pathname === "/api/super-admin/client-logo") {
    if (!isMultipart) {
      return json(res, 400, { error: "Upload must use multipart/form-data." });
    }

    const parts = parseMultipartParts(await readRawBody(req), req.headers["content-type"] || "");
    const file = parts.find((part) => part.filename && ["logo", "clientLogo", "clientLogoImage"].includes(part.name)) ||
      parts.find((part) => part.filename);

    if (!isAllowedClientLogo(file)) {
      return json(res, 400, { error: "Upload a PNG, JPG, GIF, or WebP client logo." });
    }

    if (file.content.length > 4 * 1024 * 1024) {
      return json(res, 413, { error: "Client logo must be 4 MB or smaller." });
    }

    try {
      const stored = await storeClientLogoUpload(req, file);
      return json(res, 201, {
        imageUrl: stored.imageUrl,
        storage: stored.storage,
        filename: stored.filename,
        size: stored.size
      });
    } catch (error) {
      return json(res, 500, { error: error.message || "Client logo upload failed." });
    }
  }

  if (req.method === "GET" && url.pathname.startsWith("/uploads/idle-images/")) {
    const filename = path.basename(decodeURIComponent(url.pathname.split("/").pop() || ""));
    const filePath = path.join(IDLE_IMAGE_DIR, filename);

    if (!filename || !filePath.startsWith(IDLE_IMAGE_DIR) || !fs.existsSync(filePath)) {
      return json(res, 404, { error: "Idle image not found" });
    }

    return binary(res, 200, fs.readFileSync(filePath), imageContentType(filename), { cacheControl: IMMUTABLE_UPLOAD_CACHE_CONTROL });
  }

  if (req.method === "GET" && url.pathname.startsWith("/uploads/idle-videos/")) {
    const filename = path.basename(decodeURIComponent(url.pathname.split("/").pop() || ""));
    const filePath = path.join(IDLE_VIDEO_DIR, filename);

    if (!filename || !filePath.startsWith(IDLE_VIDEO_DIR) || !fs.existsSync(filePath)) {
      return json(res, 404, { error: "Idle video not found" });
    }

    return sendFileWithRangeSupport(req, res, filePath, videoContentType(filename), { cacheControl: IMMUTABLE_UPLOAD_CACHE_CONTROL });
  }

  if (req.method === "POST" && (url.pathname === "/api/admin/idle-image" || url.pathname === "/api/super-admin/idle-image")) {
    if (!isMultipart) {
      return json(res, 400, { error: "Upload must use multipart/form-data." });
    }

    const parts = parseMultipartParts(await readRawBody(req), req.headers["content-type"] || "");
    const files = parts.filter((part) => part.filename && ["idleImage", "idleImages"].includes(part.name));

    if (!files.length) {
      return json(res, 400, { error: "Choose at least one idle-screen image to upload." });
    }

    if (files.length > IDLE_MAX_IMAGES) {
      return json(res, 400, { error: `Upload at most ${IDLE_MAX_IMAGES} images at a time.` });
    }

    const invalidFile = files.find((file) => !isAllowedIdleImage(file));
    if (invalidFile) {
      return json(res, 400, { error: "Upload PNG, JPG, GIF, or WebP images only." });
    }

    const oversizedFile = files.find((file) => file.content.length > 4 * 1024 * 1024);
    if (oversizedFile) {
      return json(res, 413, { error: "Each idle-screen image must be 4 MB or smaller." });
    }

    try {
      const stored = await Promise.all(files.map((file) => storeIdleImageUpload(req, file)));
      return json(res, 201, { imageUrls: stored.map((item) => item.imageUrl) });
    } catch (error) {
      return json(res, 500, { error: error.message || "Idle-screen image upload failed." });
    }
  }

  if (req.method === "POST" && (url.pathname === "/api/admin/idle-video" || url.pathname === "/api/super-admin/idle-video")) {
    if (!isMultipart) {
      return json(res, 400, { error: "Upload must use multipart/form-data." });
    }

    const parts = parseMultipartParts(await readRawBody(req), req.headers["content-type"] || "");
    const file = parts.find((part) => part.filename && ["idleVideo"].includes(part.name)) ||
      parts.find((part) => part.filename);

    if (!isAllowedIdleVideo(file)) {
      return json(res, 400, { error: "Upload an MP4 or WebM video." });
    }

    if (file.content.length > 50 * 1024 * 1024) {
      return json(res, 413, { error: "Idle-screen video must be 50 MB or smaller." });
    }

    try {
      const stored = await storeIdleVideoUpload(req, file);
      return json(res, 201, {
        videoUrl: stored.videoUrl,
        storage: stored.storage,
        filename: stored.filename,
        size: stored.size
      });
    } catch (error) {
      return json(res, 500, { error: error.message || "Idle-screen video upload failed." });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/mobile-upload/session") {
    const session = await createMobileUploadSession(req);
    return json(res, 200, uploadSessionResponse(session, req));
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/mobile-upload/") && url.pathname.endsWith("/status")) {
    const token = url.pathname.split("/")[3];
    const session = mobileUploadSessions.get(token);

    if (!session) {
      return json(res, 404, { error: "Upload session not found" });
    }

    // Mark session as claimed once the kiosk reads that the file was uploaded.
    // This signals the mobile page that this session is consumed and prevents
    // the user from re-submitting a file to a token the kiosk is no longer watching.
    if (session.status === "uploaded" && !session.claimed) {
      session.claimed = true;
    }

    return json(res, 200, uploadSessionResponse(session, req));
  }

  if (req.method === "GET" && /^\/mobile-upload\/[^/]+\/file(?:\/\d+)?$/.test(url.pathname)) {
    const pathParts = url.pathname.split("/");
    const token = pathParts[2];
    const fileIndex = Number(pathParts[4] || 0);
    const session = mobileUploadSessions.get(token);
    const files = Array.isArray(session?.files) && session.files.length ? session.files : session?.file ? [session.file] : [];
    const file = files[fileIndex];

    if (!file?.content) {
      return json(res, 404, { error: "Uploaded file not found" });
    }

    return binary(res, 200, file.content, file.mimeType);
  }

  if (req.method === "GET" && url.pathname.startsWith("/mobile-upload/")) {
    const token = url.pathname.split("/")[2];
    return html(res, 200, renderMobileUploadPage(mobileUploadSessions.get(token)));
  }

  if (req.method === "POST" && url.pathname.startsWith("/mobile-upload/") && url.pathname.endsWith("/upload")) {
    const token = url.pathname.split("/")[2];
    const session = mobileUploadSessions.get(token);

    if (!session) {
      return html(res, 404, renderMobileUploadPage(null));
    }

    // Hard-block re-uploads to an already-used session.
    // Once a file has been accepted this session is permanently locked.
    // A new QR scan is required to start a fresh upload session.
    if (session.status === "uploaded") {
      return html(res, 409, renderMobileStatusPage({
        title: "Session already used",
        heading: "This upload session has already been used",
        description: "Your documents were already sent to the Print Kiosk.",
        note: "Go back to the kiosk and tap Back to get a new QR code if you want to send different files.",
        warning: true
      }));
    }

    const files = parseMultipartFiles(await readRawBody(req), req.headers["content-type"] || "");

    if (!files.length || files.length > MAX_FILES_PER_JOB) {
      return html(res, 400, renderMobileStatusPage({
        title: "Upload failed",
        heading: "We could not send those files",
        description: `Choose between 1 and ${MAX_FILES_PER_JOB} valid documents and try again from a fresh kiosk QR code.`,
        note: "Nothing was added to the print session.",
        warning: true
      }));
    }

    const unsupportedFile = files.find((file) => !CUSTOMER_UPLOAD_EXTENSIONS.has(file.extension));
    if (unsupportedFile) {
      return html(res, 400, renderMobileStatusPage({
        title: "Unsupported file",
        heading: "That file type is not supported",
        description: "Print Kiosk accepts PDF, JPG, JPEG, and PNG documents from this mobile upload page.",
        note: "Nothing was added to the print session.",
        warning: true
      }));
    }

    const oversizedFile = files.find((file) => file.size > MAX_UPLOAD_FILE_SIZE_BYTES);
    if (oversizedFile) {
      return html(res, 400, renderMobileStatusPage({
        title: "File too large",
        heading: "That document is too large",
        description: `"${oversizedFile.name}" is ${(oversizedFile.size / (1024 * 1024)).toFixed(1)} MB. This kiosk allows up to 10 MB per document.`,
        note: "Nothing was added to the print session. Choose a smaller file and try again.",
        warning: true
      }));
    }

    const oversizedPdf = files.find((file) => {
      if (file.extension !== "PDF") return false;
      const pages = estimatePdfPageCount(file.content);
      return pages && pages > MAX_UPLOAD_PAGES_PER_DOCUMENT;
    });
    if (oversizedPdf) {
      return html(res, 400, renderMobileStatusPage({
        title: "Too many pages",
        heading: "That document has too many pages",
        description: `"${oversizedPdf.name}" has too many pages. This kiosk allows up to ${MAX_UPLOAD_PAGES_PER_DOCUMENT} pages per document.`,
        note: "Nothing was added to the print session. Choose a shorter document and try again.",
        warning: true
      }));
    }

    session.status = "uploaded";
    session.files = files;
    session.file = files[0];
    session.uploadedAt = new Date().toISOString();

    return html(res, 200, renderMobileStatusPage({
      title: "Documents sent",
      heading: `${files.length} file${files.length === 1 ? "" : "s"} sent successfully`,
      description: "Your documents are now ready on the Print Kiosk screen.",
      note: "You can close this page. Continue on the kiosk to review print options and pay."
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/create") {
    const settingsError = validateCustomerJobOptions(body);
    if (settingsError) return json(res, 400, { error: settingsError });

    const job = createJob(body);
    return json(res, 201, { job });
  }

  if (req.method === "POST" && url.pathname === "/api/files/upload") {
    const job = findJob(body.jobId) || createJob(body);
    job.fileName = body.fileName || job.fileName;
    job.fileType = body.fileType || job.fileType;
    job.pageCount = Number(body.pageCount || job.pageCount);
    job.printStatus = "File Uploaded";
    saveData();
    return json(res, 200, { job });
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/settings") {
    const job = findJob(body.jobId);
    if (!job) return json(res, 404, { error: "Job not found" });
    const settingsError = validateCustomerJobOptions(body, job);
    if (settingsError) return json(res, 400, { error: settingsError });

    const printOptions = normalizeJobPrintOptions(body, job);
    Object.assign(job, {
      copies: printOptions.copies,
      colorMode: printOptions.colorMode,
      paperSize: printOptions.paperSize,
      sides: printOptions.sides,
      orientation: printOptions.orientation,
      pageRange: printOptions.pageRange,
      printStatus: "Settings Selected"
    });
    saveData();
    return json(res, 200, { job });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/jobs/price/")) {
    const job = findJob(url.pathname.split("/").pop());
    if (!job) return json(res, 404, { error: "Job not found" });
    // Read-only lookup - must not mutate printStatus as a side effect of a
    // GET (that would regress an already-"Printing"/"Completed" job's status
    // on a mere re-fetch). Persisting the price happens via the real
    // write path, upsertPaymentJob() -> calculatePrice().
    return json(res, 200, { jobId: job.jobId, amount: computePriceAmount(job).amount, pricing: db.pricing });
  }

  if (req.method === "GET" && url.pathname === "/api/payment/qr") {
    const targetUrl = String(url.searchParams.get("url") || "").trim();

    if (!/^https?:\/\//i.test(targetUrl)) {
      return json(res, 400, { error: "A public http(s) payment URL is required." });
    }

    const qrSvg = await QRCode.toString(targetUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      type: "svg",
      width: 260
    });

    return json(res, 200, { url: targetUrl, qrSvg });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/payment/")) {
    const paymentId = decodeURIComponent(url.pathname.split("/").pop() || "");
    const payment = db.payments.find((item) => item.paymentId === paymentId);
    if (!payment) return json(res, 404, { error: "Payment not found." });

    const job = findJob(payment.jobId);
    if (!job) return json(res, 404, { error: "Payment job was not found." });

    return json(res, 200, {
      payment,
      job,
      checkout: checkoutPayload(payment, job, req)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/payment/create") {
    const existingJob = findJob(body.jobId);
    const settingsError = validateCustomerJobOptions(body, existingJob);
    if (settingsError) return json(res, 400, { error: settingsError });

    const job = upsertPaymentJob(body);
    const amount = amountToPaise(job.amount);

    if (Number.isFinite(amount) && amount <= 0) {
      job.amount = 0;
      job.paymentStatus = "Payment Success";
      job.printStatus = "In Queue";
      saveData();
      return json(res, 201, {
        job,
        payment: null,
        freePrint: true,
        checkout: null,
        qr: null
      });
    }

    const config = razorpayConfig();

    if (!razorpayIsConfigured()) {
      return json(res, 503, {
        error: "Razorpay keys are not configured.",
        setup: "Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET before starting the kiosk."
      });
    }

    if (!Number.isFinite(amount)) {
      return json(res, 400, { error: "Payment amount is invalid." });
    }

    // Serialize concurrent creation attempts for the same job (see
    // paymentCreationLocks declaration) before the reuse-check below, so two
    // near-simultaneous requests can't both see "no pending payment yet".
    while (paymentCreationLocks.has(job.jobId)) {
      await paymentCreationLocks.get(job.jobId);
    }
    let releasePaymentCreationLock;
    paymentCreationLocks.set(job.jobId, new Promise((resolve) => { releasePaymentCreationLock = resolve; }));

    try {
      // Avoid piling up duplicate "Pending" Razorpay orders/QR codes for the
      // same job every time this endpoint is called again (page refresh, a
      // retry after a slow response, re-scanning the mobile "continue on your
      // phone" QR) - reuse a still-valid pending payment for the identical
      // amount instead of creating a brand new one. Falls through to creating
      // a fresh order/QR exactly as before if there's no match (first
      // attempt, the previous one expired, or the job's amount changed since
      // it was created, e.g. the customer changed copies/pages).
      const reusablePending = db.payments.find((payment) => (
        payment.jobId === job.jobId &&
        payment.status === "Pending" &&
        payment.gateway === "razorpay" &&
        payment.amountInPaise === amount &&
        (Date.now() - new Date(payment.createdAt).getTime()) < QR_CODE_EXPIRY_SECONDS * 1000
      ));

      if (reusablePending) {
        return json(res, 201, {
          job,
          payment: reusablePending,
          checkout: reusablePending.razorpayQrCodeId ? null : checkoutPayload(reusablePending, job, req),
          qr: reusablePending.razorpayQrCodeId
            ? { id: reusablePending.razorpayQrCodeId, imageUrl: reusablePending.qrImageUrl || "", closeBy: reusablePending.qrCloseBy || null }
            : null
        });
      }

      // Prefer a direct UPI QR code - any payment app scans and pays it without
      // a browser hop. Falls back to Orders + Checkout if the merchant account
      // isn't enabled for the QR Codes product (e.g. still pending activation).
      let qrCode = null;
      try {
        qrCode = await createRazorpayQrCode(amount, job);
      } catch (error) {
        qrCode = null;
        console.error(`[razorpay] UPI QR code creation failed for job ${job.jobId}, falling back to Checkout: ${error.message}`);
      }

      let razorpayOrder = null;
      if (!qrCode) {
        try {
          razorpayOrder = await razorpayRequest("POST", "/v1/orders", {
            amount,
            currency: "INR",
            receipt: safeReceipt(job.jobId),
            notes: {
              jobId: job.jobId,
              kioskId: job.kioskId,
              service: job.service
            }
          });
        } catch (error) {
          return json(res, 502, { error: `Unable to create Razorpay order: ${error.message}` });
        }
      }

      const payment = {
        paymentId: `PAY-${Date.now()}`,
        gateway: "razorpay",
        jobId: job.jobId,
        amount: job.amount,
        amountInPaise: amount,
        currency: "INR",
        paymentMethod: qrCode ? "Razorpay UPI QR" : "Razorpay Checkout",
        razorpayOrderId: razorpayOrder?.id || "",
        razorpayQrCodeId: qrCode?.id || "",
        qrImageUrl: qrCode?.image_url || "",
        qrCloseBy: qrCode?.close_by || null,
        razorpayMode: config.mode,
        status: "Pending",
        createdAt: new Date().toISOString()
      };
      db.payments.push(payment);
      job.paymentStatus = "Payment Pending";
      saveData();
      return json(res, 201, {
        job,
        payment,
        checkout: qrCode ? null : checkoutPayload(payment, job, req),
        qr: qrCode ? { id: qrCode.id, imageUrl: qrCode.image_url, closeBy: qrCode.close_by || null } : null
      });
    } finally {
      paymentCreationLocks.delete(job.jobId);
      releasePaymentCreationLock();
    }
  }

  if (req.method === "POST" && url.pathname === "/api/payment/verify") {
    const config = razorpayConfig();

    if (!razorpayIsConfigured()) {
      return json(res, 503, { error: "Razorpay keys are not configured." });
    }

    const payment = db.payments.find((item) => item.razorpayOrderId === body.razorpay_order_id);
    if (!payment) return json(res, 404, { error: "Razorpay order was not found in kiosk payments." });

    const job = findJob(payment.jobId);
    if (!job) return json(res, 404, { error: "Payment job was not found." });

    const expectedSignature = crypto
      .createHmac("sha256", config.keySecret)
      .update(`${payment.razorpayOrderId}|${body.razorpay_payment_id}`)
      .digest("hex");

    if (!secureCompare(expectedSignature, body.razorpay_signature)) {
      payment.status = "Signature Failed";
      payment.failedAt = new Date().toISOString();
      const modeHint = payment.razorpayMode && payment.razorpayMode !== config.mode
        ? ` Order was created with ${payment.razorpayMode} keys, but the backend is currently using ${config.mode} keys.`
        : "";
      return json(res, 400, { error: `Razorpay payment signature verification failed.${modeHint}` });
    }

    payment.status = "Success";
    payment.razorpayPaymentId = body.razorpay_payment_id;
    payment.razorpaySignature = body.razorpay_signature;
    payment.razorpayMode = payment.razorpayMode || config.mode;
    payment.paidAt = new Date().toISOString();
    job.paymentStatus = "Payment Success";
    job.printStatus = "In Queue";
    saveData();

    return json(res, 200, { payment, job });
  }

  if (req.method === "POST" && url.pathname === "/api/print/start") {
    const job = findJob(body.jobId);
    if (!job) return json(res, 404, { error: "Job not found" });
    if (job.paymentStatus !== "Payment Success") {
      return json(res, 409, { error: "Payment must be confirmed before printing." });
    }
    job.printStatus = "Printing";
    saveData();
    return json(res, 200, { job, localAgent: `POST ${localAgentUrl()}/local/print` });
  }

  if (req.method === "POST" && url.pathname === "/api/print/status") {
    let job = findJob(body.jobId);
    if (!job && body.jobId) {
      const settingsError = validateCustomerJobOptions(body);
      if (settingsError) return json(res, 400, { error: settingsError });
      job = upsertPaymentJob(body);
    }
    if (!job) return json(res, 404, { error: "Job not found" });

    // paymentStatus is never taken from the request body — a caller could
    // otherwise mark any job "Payment Success" without an actual payment and
    // then start a real print via /api/print/start. It's derived instead
    // from whether db.payments actually has a Success record for this job,
    // which is only ever written by the signature-verified Razorpay paths.
    const hasSuccessfulPayment = db.payments.some(
      (payment) => payment.jobId === job.jobId && payment.status === "Success"
    );
    if (hasSuccessfulPayment) {
      job.paymentStatus = "Payment Success";
    }

    return json(res, 200, {
      job: setJobPrintStatus(job, body.printStatus, {
        failureReason: body.failureReason,
        completionConfirmed: body.completionConfirmed
      })
    });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/print/status/")) {
    const job = findJob(url.pathname.split("/").pop());
    if (!job) return json(res, 404, { error: "Job not found" });
    return json(res, 200, { jobId: job.jobId, paymentStatus: job.paymentStatus, printStatus: job.printStatus });
  }

  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts[0] === "api" && pathParts[1] === "super-admin") {
    const resource = pathParts[2];

    if (req.method === "GET" && resource === "snapshot") {
      return json(res, 200, superAdminSnapshot());
    }

    if (resource === "pricing") {
      const serviceId = decodeSegment(pathParts[3] || "");

      if (req.method === "GET" && !serviceId) {
        return json(res, 200, {
          pricing: db.pricing,
          entries: Object.entries(db.pricing).map(([id, rates]) => ({ serviceId: id, ...rates }))
        });
      }

      if ((req.method === "POST" || req.method === "PUT" || req.method === "PATCH") && !serviceId) {
        db.pricing = normalizePricing(body.pricing || body, db.services);
        saveSuperAdminCollection("pricing");
        return json(res, 200, { pricing: db.pricing });
      }

      if ((req.method === "PUT" || req.method === "PATCH") && serviceId) {
        if (!db.services.some((service) => service.id === serviceId)) {
          return json(res, 404, { error: "Service not found" });
        }
        db.pricing = normalizePricing({
          ...db.pricing,
          [serviceId]: {
            bw: numericPrice(body.bw, db.pricing[serviceId]?.bw || 0),
            color: numericPrice(body.color, db.pricing[serviceId]?.color || 0)
          }
        }, db.services);
        saveSuperAdminCollection("pricing");
        return json(res, 200, { pricing: db.pricing, rates: db.pricing[serviceId] });
      }

      return json(res, 405, { error: "Unsupported pricing operation." });
    }

    if (resource === "services" && pathParts[4] === "templates") {
      return handleSuperAdminTemplate(req, res, pathParts, body);
    }

    return handleSuperAdminCollection(req, res, resource, decodeSegment(pathParts[3] || ""), body);
  }

  const adminSession = url.pathname.startsWith("/api/admin/") ? readAdminSession(req) : null;

  if (req.method === "GET" && url.pathname === "/api/admin/idle-screensaver") {
    const admin = findKioskAdminById(adminSession?.adminId);
    if (!admin) return json(res, 404, { error: "Admin account not found." });
    return json(res, 200, kioskAdminIdleScreensaverFields(admin));
  }

  if (req.method === "PUT" && url.pathname === "/api/admin/idle-screensaver") {
    const admin = findKioskAdminById(adminSession?.adminId);
    if (!admin) return json(res, 404, { error: "Admin account not found." });

    // Whitelist-merge only the 4 idle-screensaver fields — this endpoint must
    // never let a client touch anything else on their own account record
    // (adminId, projectIds, status, ...), unlike the generic Super Admin PUT.
    // Partial-update semantics: a field only changes if it was actually sent,
    // so an omitted field keeps its saved value instead of being wiped.
    if (body.idleMediaMode !== undefined) admin.idleMediaMode = normalizeIdleMediaMode(body.idleMediaMode);
    if (body.idleImageUrls !== undefined) admin.idleImageUrls = normalizeIdleImageUrls(body.idleImageUrls);
    if (body.idleVideoUrl !== undefined) admin.idleVideoUrl = normalizePublicAssetUrl(body.idleVideoUrl || "");
    if (body.idleTimeoutSeconds !== undefined) admin.idleTimeoutSeconds = normalizeIdleTimeoutSeconds(body.idleTimeoutSeconds);
    saveData();

    return json(res, 200, kioskAdminIdleScreensaverFields(admin));
  }

  if (req.method === "GET" && url.pathname === "/api/admin/dashboard") {
    const adminJobs = jobsForAdmin(adminSession);
    const adminKiosks = kiosksForAdmin(adminSession);
    return json(res, 200, {
      revenueToday: adminJobs.reduce((sum, job) => sum + (job.paymentStatus === "Payment Success" ? job.amount : 0), 0),
      jobsToday: adminJobs.length,
      failedJobs: adminJobs.filter((job) => String(job.printStatus || "").includes("Failed")).length,
      activeKiosks: adminKiosks.filter((kiosk) => kiosk.status === "online").length
    });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/revenue") {
    const adminJobs = jobsForAdmin(adminSession);
    const adminServices = servicesForAdmin(adminSession);
    const gross = adminJobs.reduce((sum, job) => sum + (job.paymentStatus === "Payment Success" ? Number(job.amount || 0) : 0), 0);
    return json(res, 200, { gross, net: gross, pricing: pricingForServices(adminServices, [...kioskIdsForAdmin(adminSession)]), services: adminServices, config: db.config });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/pricing") {
    const adminServices = servicesForAdmin(adminSession);
    return json(res, 200, { pricing: pricingForServices(adminServices, [...kioskIdsForAdmin(adminSession)]), services: adminServices, config: db.config });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/services") {
    const kioskId = url.searchParams.get("kioskId");
    const services = servicesForAdmin(adminSession, kioskId);
    return json(res, 200, { services, pricing: pricingForServices(services, [...kioskIdsForAdmin(adminSession)]), config: db.config });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/transactions") {
    return json(res, 200, { payments: paymentsForJobs(jobsForAdmin(adminSession)) });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/print-history") {
    return json(res, 200, { jobs: jobsForAdmin(adminSession) });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/reports") {
    return json(res, 200, {
      reports: ["daily-sales", "monthly-sales", "failed-transactions", "maintenance"]
    });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/kiosks") {
    return json(res, 200, { kiosks: kiosksForAdmin(adminSession) });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/projects") {
    return json(res, 200, { projects: projectsForAdmin(adminSession) });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/projects") {
    const rawProject = body.project || body;
    const project = normalizeSuperAdminProject({
      ...rawProject,
      adminId: adminSession.adminId
    });

    if (db.projects.some((item) => item.projectId === project.projectId)) {
      return json(res, 409, { error: "Project ID already exists." });
    }

    db.projects.push(project);
    db.kioskAdmins = db.kioskAdmins.map((admin) => {
      if (admin.adminId !== adminSession.adminId) return admin;
      return {
        ...admin,
        projectIds: [...new Set([...(admin.projectIds || []), project.projectId])]
      };
    });
    saveData();
    return json(res, 201, { project, projects: projectsForAdmin(adminSession) });
  }

  if ((req.method === "PUT" || req.method === "PATCH") && url.pathname.startsWith("/api/admin/projects/")) {
    const projectId = slug(decodeSegment(url.pathname.split("/")[4] || ""), "");
    const index = db.projects.findIndex((item) => item.projectId === projectId);

    if (index === -1) {
      return json(res, 404, { error: "Project not found." });
    }

    if (!adminCanAccessProject(adminSession, projectId)) {
      return json(res, 403, { error: "This project is outside your account." });
    }

    const rawProject = body.project || body;
    const project = normalizeSuperAdminProject({
      ...db.projects[index],
      ...rawProject,
      projectId: db.projects[index].projectId,
      adminId: adminSession.adminId
    }, db.projects[index]);

    db.projects[index] = project;
    saveData();
    return json(res, 200, { project, projects: projectsForAdmin(adminSession) });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/projects/")) {
    const projectId = slug(decodeSegment(url.pathname.split("/")[4] || ""), "");
    const index = db.projects.findIndex((item) => item.projectId === projectId);

    if (index === -1) {
      return json(res, 404, { error: "Project not found." });
    }

    if (!adminCanAccessProject(adminSession, projectId)) {
      return json(res, 403, { error: "This project is outside your account." });
    }

    const [deleted] = db.projects.splice(index, 1);
    db.kiosks = db.kiosks.filter((kiosk) => slug(kiosk.projectId, "") !== projectId);
    db.services = db.services
      .map((service) => ({
        ...service,
        projectIds: (service.projectIds || []).filter((id) => slug(id, "") !== projectId)
      }))
      .filter((service) => (service.projectIds || []).length || (service.kioskIds || []).length);
    db.kioskAdmins = db.kioskAdmins.map((admin) => ({
      ...admin,
      projectIds: (admin.projectIds || []).filter((id) => slug(id, "") !== projectId)
    }));
    db.pricing = normalizePricing(db.pricing, db.services);
    touchConfig("project-deleted");
    saveSettings();
    saveData();
    return json(res, 200, {
      deleted,
      projects: projectsForAdmin(adminSession),
      kiosks: kiosksForAdmin(adminSession),
      services: servicesForAdmin(adminSession),
      pricing: pricingForServices(servicesForAdmin(adminSession), [...kioskIdsForAdmin(adminSession)]),
      config: db.config
    });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/kiosks") {
    const rawKiosk = body.kiosk || body;
    const fallbackProjectId = projectsForAdmin(adminSession)[0]?.projectId || "";
    const projectId = slug(rawKiosk.projectId || fallbackProjectId, "");
    const requestedKioskId = normalizeKioskCode(rawKiosk.kioskId);
    const requestedSetupCode = normalizeKioskCode(rawKiosk.setupCode, 16);

    if (!projectId || !adminCanAccessProject(adminSession, projectId)) {
      return json(res, 403, { error: "Select a project allocated to this client before creating the kiosk." });
    }

    const kiosk = normalizeSuperAdminKiosk({
      ...rawKiosk,
      projectId,
      adminId: adminSession.adminId
    });

    if (!requestedKioskId || !kiosk.kioskId) {
      return json(res, 400, { error: "Kiosk ID is required." });
    }

    if (!requestedSetupCode || !kiosk.setupCode) {
      return json(res, 400, { error: "Mini PC setup code is required." });
    }

    if (kioskIdInUse(kiosk.kioskId)) {
      return json(res, 409, { error: "Kiosk ID already exists. Use a unique kiosk ID." });
    }

    // Setup codes may repeat across kiosks (see validateSuperAdminRecord).
    db.kiosks.push(kiosk);
    db.kioskAdmins = db.kioskAdmins.map((admin) => {
      if (admin.adminId !== adminSession.adminId || !Array.isArray(admin.kioskIds) || !admin.kioskIds.length) {
        return admin;
      }

      return {
        ...admin,
        kioskIds: [...new Set([...admin.kioskIds.map((id) => normalizeKioskCode(id)).filter(Boolean), kiosk.kioskId])]
      };
    });
    touchConfig("kiosk-created");
    saveSettings();
    saveData();
    return json(res, 201, { kiosk, kiosks: kiosksForAdmin(adminSession) });
  }

  if ((req.method === "PUT" || req.method === "PATCH") && url.pathname.startsWith("/api/admin/kiosks/")) {
    const kioskId = normalizeKioskCode(decodeSegment(url.pathname.split("/")[4] || ""));
    const index = db.kiosks.findIndex((item) => normalizeKioskCode(item.kioskId) === kioskId);

    if (index === -1) {
      return json(res, 404, { error: "Kiosk not found." });
    }

    if (!adminCanAccessKiosk(adminSession, kioskId)) {
      return json(res, 403, { error: "This kiosk is outside your assigned projects." });
    }

    const rawKiosk = body.kiosk || body;
    const projectId = slug(rawKiosk.projectId || db.kiosks[index].projectId, "");

    if (!projectId || !adminCanAccessProject(adminSession, projectId)) {
      return json(res, 403, { error: "Select a project allocated to this client." });
    }

    const kiosk = normalizeSuperAdminKiosk({
      ...db.kiosks[index],
      ...rawKiosk,
      kioskId: db.kiosks[index].kioskId,
      projectId,
      adminId: adminSession.adminId
    }, db.kiosks[index]);

    if (!kiosk.setupCode) {
      return json(res, 400, { error: "Mini PC setup code is required." });
    }

    // Setup codes may repeat across kiosks (see validateSuperAdminRecord).
    db.kiosks[index] = kiosk;
    touchConfig("kiosk-updated");
    saveSettings();
    saveData();
    return json(res, 200, { kiosk, kiosks: kiosksForAdmin(adminSession) });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/kiosks/")) {
    const kioskId = normalizeKioskCode(decodeSegment(url.pathname.split("/")[4] || ""));
    const index = db.kiosks.findIndex((item) => normalizeKioskCode(item.kioskId) === kioskId);

    if (index === -1) {
      return json(res, 404, { error: "Kiosk not found." });
    }

    if (!adminCanAccessKiosk(adminSession, kioskId)) {
      return json(res, 403, { error: "This kiosk is outside your assigned projects." });
    }

    const [deleted] = db.kiosks.splice(index, 1);
    db.kioskAdmins = db.kioskAdmins.map((admin) => ({
      ...admin,
      kioskIds: Array.isArray(admin.kioskIds)
        ? admin.kioskIds.map((id) => normalizeKioskCode(id)).filter((id) => id && id !== kioskId)
        : []
    }));
    touchConfig("kiosk-deleted");
    saveSettings();
    saveData();
    return json(res, 200, { deleted, kiosks: kiosksForAdmin(adminSession) });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/system-status") {
    return json(res, 200, {
      kiosks: kiosksForAdmin(adminSession),
      alertLogs: alertLogsForAdmin(adminSession),
      backend: "online",
      localAgentExpectedPort: 5077
    });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/pricing") {
    const adminServices = servicesForAdmin(adminSession);
    const allowedServiceIds = new Set(adminServices.map((service) => service.id));
    const allowedKioskIds = kioskIdsForAdmin(adminSession);
    const requestedPricing = body.pricing || body;
    const scopedPricing = {};
    const scopedKioskPricing = {};

    if (requestedPricing && typeof requestedPricing === "object") {
      Object.entries(requestedPricing).forEach(([serviceId, rates]) => {
        if (allowedServiceIds.has(serviceId)) {
          scopedPricing[serviceId] = rates;
        }
      });

      Object.entries(requestedPricing.__kiosks || {}).forEach(([rawKioskId, kioskPricing]) => {
        const kioskId = normalizeKioskCode(rawKioskId);
        if (!kioskId || !allowedKioskIds.has(kioskId) || !kioskPricing || typeof kioskPricing !== "object") return;

        const scopedRates = {};
        Object.entries(kioskPricing).forEach(([serviceId, rates]) => {
          if (allowedServiceIds.has(serviceId)) {
            scopedRates[serviceId] = rates;
          }
        });

        if (Object.keys(scopedRates).length) {
          scopedKioskPricing[kioskId] = scopedRates;
        }
      });
    }

    db.pricing = normalizePricing({
      ...db.pricing,
      ...scopedPricing,
      __kiosks: {
        ...(db.pricing.__kiosks || {}),
        ...scopedKioskPricing
      }
    }, db.services);
    db.services = db.services.map((service) => ({
      ...service,
      pricing: db.pricing[service.id] || service.pricing
    }));
    touchConfig("pricing-updated");
    saveSettings();
    saveData();
    const scopedServices = servicesForAdmin(adminSession);
    return json(res, 200, { pricing: pricingForServices(scopedServices, [...kioskIdsForAdmin(adminSession)]), services: scopedServices, config: db.config });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/services") {
    const savedServices = mergeAdminServices(adminSession, body.services || body, body.pricing);
    if (!savedServices) {
      return json(res, 403, { error: "This admin has no assigned kiosks." });
    }
    touchConfig("services-updated");
    saveSettings();
    saveData();
    const scopedServices = servicesForAdmin(adminSession);
    return json(res, 200, { services: scopedServices, pricing: pricingForServices(scopedServices, [...kioskIdsForAdmin(adminSession)]), config: db.config });
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/admin/reprint/")) {
    const job = findJob(url.pathname.split("/").pop());
    if (!job) return json(res, 404, { error: "Job not found" });
    if (!adminCanAccessKiosk(adminSession, job.kioskId)) {
      return json(res, 403, { error: "This job is outside your assigned kiosks." });
    }
    return json(res, 200, { job: setJobPrintStatus(job, "Manual Reprint Done") });
  }

  return json(res, 404, { error: "Route not found", path: url.pathname });
 } catch (error) {
  console.error("Unhandled request error:", req.url, error);
  if (!res.headersSent) return json(res, 500, { error: "Internal server error" });
 }
});

// ── Live admin push (WebSocket) ──────────────────────────────────────────────
// Replaces manual "Refresh" buttons on admin dashboards: rather than a client
// polling on a timer, the backend pushes a lightweight "data-changed" ping to
// every connected admin whenever saveData() actually writes something. The
// socket never carries the data itself (no auth/authorization logic to
// duplicate here) — clients just re-fetch through the existing authenticated
// REST endpoints they already use, so this is purely a "check now" signal.
const wss = new WebSocketServer({ server, path: "/ws" });
// ws re-emits the underlying http `server`'s own 'error' event onto `wss`
// (e.g. the EADDRINUSE thrown at startup.listen() below, see server.on("error", ...)
// there). An 'error' event with no listener on the target EventEmitter throws
// synchronously in Node - and that throw happens INSIDE wss's own internal
// listener for the server's 'error' event, meaning it interrupts that
// listener-invocation loop before server's own "error" listener (registered
// later, in startServer()) ever gets a turn. Without this listener here, that
// throw was the actual thing landing in the generic uncaughtException net at
// the top of this file - "process kept alive" while never having bound to
// the port. This listener is a no-op beyond preventing that: the real
// listen-failure handling and process.exit(1) both stay in
// server.on("error", ...) inside startServer().
wss.on("error", () => {});
const wsClients = new Set();
let broadcastDataChangedTimer = null;

wss.on("connection", (socket) => {
  wsClients.add(socket);
  socket.on("close", () => wsClients.delete(socket));
  socket.on("error", () => wsClients.delete(socket));
});

function broadcastDataChanged() {
  // Coalesce bursts (e.g. several kiosks heartbeating within the same
  // second) into a single push instead of one message per saveData() call.
  if (broadcastDataChangedTimer) return;

  broadcastDataChangedTimer = setTimeout(() => {
    broadcastDataChangedTimer = null;
    const payload = JSON.stringify({ type: "data-changed", at: new Date().toISOString() });
    for (const socket of wsClients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }, 300);
}

async function startServer() {
  db = createRuntimeDb(loadData(), loadSettings());
  await initializePersistence();

  const checkKioskTimeouts = () => {
    let changed = false;
    const now = Date.now();
    const iso = new Date(now).toISOString();

    db.kiosks.forEach(kiosk => {
      if (kiosk.status === "online") {
        const last = new Date(kiosk.lastOnline).getTime();
        // The kiosk heartbeat now retries every ~2-3s under normal
        // conditions (see syncPrinterHealthToBackend), so 5s without one
        // is already several missed retries, not a single slow tick —
        // tightened from 30s so losing internet is reflected here within
        // single-digit seconds instead of up to ~40.
        if (isNaN(last) || (now - last > 5000)) {
          kiosk.status = "offline";
          changed = true;
        }
      }

      // Ensure every currently-offline kiosk has an active alert log entry, not
      // just the ones caught transitioning above. Without this, a kiosk that was
      // already offline before a server restart (in-memory alertLogs reset) stays
      // offline forever without ever getting logged, even though the live "Open
      // Alerts" view (computed straight from kiosk.status) keeps reporting it.
      if (kiosk.status === "offline") {
        const existingActive = db.alertLogs.find(a => a.kioskId === kiosk.kioskId && a.title.includes("Kiosk Offline") && a.status === 'active');
        if (!existingActive) {
          db.alertLogs.push({
            id: "ALT-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
            kioskId: kiosk.kioskId,
            category: "network",
            title: `${kiosk.kioskId || "Kiosk"} - Kiosk Offline`,
            detail: `The kiosk PC has lost internet connection or is turned off.`,
            tone: "bad",
            status: 'active',
            createdAt: iso,
            resolvedAt: null
          });
          changed = true;
        }
      }
    });
    if (changed) saveData();
  };

  checkKioskTimeouts();
  setInterval(checkKioskTimeouts, 2000); // Check every 2s so the 5s heartbeat timeout above is caught promptly

  // A paid job normally clears "In Queue"/"Printing" within seconds to a
  // couple minutes. If the local print agent crashes, the kiosk loses
  // power mid-print, or it just never picks the job up, nothing previously
  // detected that - the job sat there forever with no alert and no way for
  // staff to notice short of a customer complaint. Mirrors the kiosk
  // offline sweep above: same alertLogs table, same dedup-by-title pattern,
  // resolved automatically in setJobPrintStatus() once the job actually
  // finishes (even late).
  const STALE_JOB_TIMEOUT_MS = 10 * 60 * 1000;

  const checkStaleJobs = () => {
    let changed = false;
    const now = Date.now();
    const iso = new Date(now).toISOString();

    db.jobs.forEach(job => {
      if (job.printStatus !== "In Queue" && job.printStatus !== "Printing") return;

      const successfulPayment = db.payments.find(p => p.jobId === job.jobId && p.status === "Success");
      const referenceTime = successfulPayment?.paidAt || job.createdAt;
      if (!referenceTime) return;

      const elapsedMs = now - new Date(referenceTime).getTime();
      if (elapsedMs < STALE_JOB_TIMEOUT_MS) return;

      const alertTitle = `${job.kioskId || "Kiosk"} - Print Job Stuck (${job.jobId})`;
      const existingActive = db.alertLogs.find(a => a.title === alertTitle && a.status === 'active');
      if (!existingActive) {
        db.alertLogs.push({
          id: "ALT-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
          kioskId: job.kioskId || "Unknown",
          category: "queue",
          title: alertTitle,
          detail: `This job has been "${job.printStatus}" for over ${Math.round(elapsedMs / 60000)} minute(s) without completing. Check the local print agent and printer connection at this kiosk.`,
          tone: "bad",
          status: 'active',
          createdAt: iso,
          resolvedAt: null
        });
        changed = true;
      }
    });
    if (changed) saveData();
  };

  checkStaleJobs();
  setInterval(checkStaleJobs, 30000); // Stale jobs move on a much slower timescale than kiosk heartbeats

  // A failure to bind the port (EADDRINUSE from a stray/leftover process still
  // holding it, EACCES, ...) is a listen-time 'error' event on the server
  // itself, not a request-handling bug - the generic uncaughtException net
  // above is the wrong place for it to land. Without this listener, Node has
  // no listener for that 'error' event and throws it as an uncaught
  // exception instead, which the net above then only logs and swallows -
  // leaving the process reported "online" by PM2 while never actually
  // listening on the port, so every request silently fails forever until
  // someone notices and restarts it by hand. Exiting here instead lets PM2's
  // own restart/alerting actually see the failure.
  server.on("error", (error) => {
    console.error(`Backend failed to start: ${error.message}`);
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use - find and stop whatever else is bound to it, then restart this service.`);
    }
    process.exit(1);
  });

  server.listen(PORT, HOST || undefined, () => {
    const hostLabel = HOST || "localhost";
    console.log(`Printing kiosk backend running at http://${hostLabel}:${PORT}`);
    if (DISABLE_ADMIN_ACCESS) {
      console.log("Admin web and API access are disabled on this kiosk.");
    }
  });
}

startServer().catch((error) => {
  console.error(`Backend startup failed: ${error.message}`);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await rdsStore.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await rdsStore.close();
  process.exit(0);
});
