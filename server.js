const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");
const QRCode = require("qrcode");
const { loadEnv } = require("./load-env");

loadEnv();
const rdsStore = require("./rds-store");

const PORT = Number(process.env.PORT || 5080);
const HOST = process.env.HOST || "";
const DISABLE_ADMIN_ACCESS = process.env.DISABLE_ADMIN_ACCESS === "true";
const RAZORPAY_API_BASE = "api.razorpay.com";
const SETTINGS_PATH = process.env.SETTINGS_PATH ? path.resolve(process.env.SETTINGS_PATH) : path.join(__dirname, "settings.json");
const DATA_PATH = process.env.DATA_PATH ? path.resolve(process.env.DATA_PATH) : path.join(__dirname, "data.json");
const FRONTEND_DIR = path.join(__dirname, "../frontend");
const FRONTEND_ASSET_DIR = path.join(FRONTEND_DIR, "assets");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const SERVICE_IMAGE_DIR = path.join(UPLOADS_DIR, "service-images");
const MAX_FILES_PER_JOB = 10;
const CUSTOMER_UPLOAD_EXTENSIONS = new Set(["PDF", "JPG", "JPEG", "PNG"]);
const KIOSK_PRINTER_STALE_MS = 10 * 60 * 1000;
const mobileUploadSessions = new Map();
const adminSessions = new Map();
const processedRazorpayWebhookEvents = new Set();
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const LOCAL_ONLY_ADMIN_EMAIL = "admin@printingkiosk.local";
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
  email: configValue(["KIOSK_ADMIN_EMAIL", "ADMIN_EMAIL"], LOCAL_ONLY_ADMIN_EMAIL, "KIOSK_ADMIN_EMAIL"),
  password: configValue(["KIOSK_ADMIN_PASSWORD", "ADMIN_PASSWORD"], LOCAL_ONLY_ADMIN_PASSWORD, "KIOSK_ADMIN_PASSWORD")
};
const SUPER_ADMIN_CREDENTIALS = {
  email: configValue(["SUPER_ADMIN_EMAIL", "SUPER_EMAIL"], LOCAL_ONLY_SUPER_ADMIN_EMAIL, "SUPER_ADMIN_EMAIL"),
  password: configValue(["SUPER_ADMIN_PASSWORD", "SUPER_PASSWORD"], LOCAL_ONLY_SUPER_ADMIN_PASSWORD, "SUPER_ADMIN_PASSWORD")
};
const DEFAULT_KIOSK_ADMIN_ID = process.env.KIOSK_ADMIN_ID || "default-admin";
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

let db = createRuntimeDb(loadData(), loadSettings());
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

      return {
        id,
        title,
        description: String(template?.description || "Blank printable template.").trim(),
        pages: Math.max(1, Math.min(20, Number(template?.pages || 1))),
        fields: normalizeFields(template?.fields).length ? normalizeFields(template?.fields) : ["Applicant", "Address", "Mobile", "Purpose", "Signature"],
        imageUrl: String(template?.imageUrl || "").trim()
      };
    })
    .filter((template) => template.title);
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
        description: String(service?.description || fallback.description || "Customer service.").trim(),
        defaultPages: Math.max(1, Math.min(99, Number(service?.defaultPages || fallback.defaultPages || 1))),
        mode,
        imageUrl: String(service?.imageUrl || fallback.imageUrl || "").trim(),
        enabled: service?.enabled !== false,
        kioskIds: Array.isArray(service?.kioskIds) ? service.kioskIds.map((item) => String(item).trim()).filter(Boolean) : [],
        pricing: {
          bw: numericPrice(service?.pricing?.bw, fallback.pricing?.bw ?? DEFAULT_PRICING.print.bw),
          color: numericPrice(service?.pricing?.color, fallback.pricing?.color ?? DEFAULT_PRICING.print.color)
        },
        templates: mode === "template" ? normalizeTemplates(service?.templates || fallback.templates) : []
      };
    });
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

  return nextPricing;
}

function normalizeAdminId(value, fallback = DEFAULT_KIOSK_ADMIN_ID) {
  return slug(value || fallback, fallback);
}

function defaultKioskAdmin() {
  return {
    adminId: normalizeAdminId(DEFAULT_KIOSK_ADMIN_ID),
    name: process.env.KIOSK_ADMIN_NAME || "Kiosk Admin",
    email: ADMIN_CREDENTIALS.email,
    password: ADMIN_CREDENTIALS.password,
    status: "active",
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
    name: String(next.name || "Kiosk Admin").trim(),
    email: String(next.email || "").trim().toLowerCase(),
    password: String(password || "").trim(),
    status: String(next.status || "active").trim().toLowerCase() === "disabled" ? "disabled" : "active",
    projectIds: Array.isArray(next.projectIds)
      ? next.projectIds.map((item) => slug(item, "")).filter(Boolean)
      : String(next.projectIds || "").split(",").map((item) => slug(item, "")).filter(Boolean),
    kioskIds: Array.isArray(next.kioskIds)
      ? next.kioskIds.map((item) => String(item || "").trim().toUpperCase()).filter(Boolean)
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

  return {
    jobs: Array.isArray(persistedData.jobs) ? persistedData.jobs : [],
    payments: Array.isArray(persistedData.payments) ? persistedData.payments : [],
    services: persistedServices,
    pricing: normalizePricing(persistedData.pricing || persistedSettings.pricing, persistedServices),
    kiosks: persistedKiosks.map((kiosk) => normalizeSuperAdminKiosk({
      projectId: kiosk.projectId || projects[0]?.projectId || "default-project",
      ...kiosk
    })),
    projects,
    kioskAdmins,
    refunds: Array.isArray(persistedData.refunds) ? persistedData.refunds : [],
    config: normalizeConfigMeta(persistedData.config || persistedSettings.config, persistedData.updatedAt)
  };
}

function defaultKiosk() {
  return {
    kioskId: defaultKioskId(),
    name: process.env.KIOSK_NAME || os.hostname(),
    branch: process.env.KIOSK_BRANCH || "Local Branch",
    projectId: process.env.KIOSK_PROJECT_ID || "default-project",
    adminId: process.env.KIOSK_ADMIN_ID || "",
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
    refunds: db.refunds,
    config: db.config,
    updatedAt: new Date().toISOString()
  };
}

function clonedDataSnapshot() {
  return JSON.parse(JSON.stringify(dataSnapshot()));
}

function persistDatabaseSnapshot() {
  if (!rdsStore.enabled()) return;

  const snapshot = clonedDataSnapshot();
  databaseSaveQueue = databaseSaveQueue
    .then(() => rdsStore.saveSnapshot(snapshot))
    .catch((error) => {
      console.error(`RDS save failed: ${error.message}`);
    });
}

function saveSettings() {
  if (rdsStore.enabled()) {
    persistDatabaseSnapshot();
    return;
  }

  writeJsonAtomic(SETTINGS_PATH, {
    services: db.services,
    pricing: db.pricing,
    config: db.config,
    updatedAt: db.config.updatedAt
  });
}

function saveData() {
  if (rdsStore.enabled()) {
    persistDatabaseSnapshot();
    return;
  }

  writeJsonAtomic(DATA_PATH, dataSnapshot());
}

function serviceRates(serviceId) {
  return db.pricing[serviceId] || db.services.find((service) => service.id === serviceId)?.pricing || DEFAULT_PRICING.print;
}

function servicesForKiosk(kioskId = "") {
  const id = String(kioskId || "").trim();
  return db.services.filter((service) => !id || !service.kioskIds.length || service.kioskIds.includes(id));
}

function kioskForConfig(kioskId = "") {
  const id = String(kioskId || "").trim().toUpperCase();
  return db.kiosks.find((kiosk) => String(kiosk.kioskId || "").toUpperCase() === id) || null;
}

function kioskConfigResponse(kioskId = "") {
  const filteredServices = servicesForKiosk(kioskId);
  const kiosk = kioskForConfig(kioskId);
  const pricing = Object.fromEntries(
    filteredServices.map((service) => [
      service.id,
      db.pricing[service.id] || service.pricing || { bw: 0, color: 0 }
    ])
  );

  return {
    kioskId: kioskId || null,
    kiosk: kiosk ? {
      kioskId: kiosk.kioskId,
      name: kiosk.name,
      branch: kiosk.branch,
      status: kiosk.status,
      printer: kiosk.printer,
      scanner: kiosk.scanner,
      appVersion: kiosk.appVersion,
      lastOnline: kiosk.lastOnline
    } : null,
    config: db.config,
    services: filteredServices.map((service) => ({
      ...service,
      pricing: pricing[service.id] || service.pricing
    })),
    pricing
  };
}

function snapshotHasData(snapshot = {}) {
  return ["jobs", "payments", "services", "kiosks", "refunds"].some((key) => Array.isArray(snapshot[key]) && snapshot[key].length);
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

function binary(res, status, body, contentType) {
  res.writeHead(status, {
    "Content-Type": contentType || "application/octet-stream",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function frontendContentType(filename) {
  const extension = path.extname(filename).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8"
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

function serveFrontendAsset(res, filename) {
  const safeName = path.basename(filename);
  const filePath = path.join(FRONTEND_ASSET_DIR, safeName);

  if (!FRONTEND_ASSETS.has(safeName) || !filePath.startsWith(FRONTEND_ASSET_DIR) || !fs.existsSync(filePath)) {
    return json(res, 404, { error: "Frontend asset not found." });
  }

  return binary(res, 200, fs.readFileSync(filePath), imageContentType(safeName));
}

function ensureUploadDirs() {
  fs.mkdirSync(SERVICE_IMAGE_DIR, { recursive: true });
}

function publicOrigin(req) {
  return (process.env.PUBLIC_BASE_URL || process.env.BACKEND_URL || `http://${req.headers.host || `localhost:${PORT}`}`).replace(/\/+$/, "");
}

function uploadBaseUrl(req, session = null) {
  return (session?.publicBaseUrl || publicOrigin(req)).replace(/\/+$/, "");
}

function imageContentType(filename) {
  const extension = path.extname(filename).toLowerCase();
  return {
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp"
  }[extension] || "application/octet-stream";
}

function safeUploadedImageName(filename) {
  const extension = path.extname(filename).toLowerCase();
  const allowed = new Set([".gif", ".jpg", ".jpeg", ".png", ".webp"]);
  const normalizedExtension = allowed.has(extension) ? extension : ".png";
  const base = path.basename(filename, extension)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "service-image";

  return `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${base}${normalizedExtension}`;
}

function credentialIdentifier(body = {}) {
  return String(body.identifier || body.email || body.username || body.adminId || body.ownerId || body.id || "").trim();
}

function credentialsMatch(body, expected) {
  const identifier = credentialIdentifier(body).toLowerCase();
  const password = String(body?.password || "");

  return identifier === String(expected.email || "").trim().toLowerCase() && password === String(expected.password || "");
}

function publicKioskAdmin(admin = {}) {
  return {
    adminId: admin.adminId,
    name: admin.name,
    email: admin.email,
    status: admin.status,
    projectIds: Array.isArray(admin.projectIds) ? admin.projectIds : [],
    kioskIds: Array.isArray(admin.kioskIds) ? admin.kioskIds : []
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
        error: "These credentials match both admin roles. Use different super admin and kiosk admin credentials."
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
  const kioskId = String(body.kioskId || "").trim().toUpperCase();
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
        error: "These credentials match both admin roles. Use different super admin and kiosk admin credentials."
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
          error: "This kiosk admin is not assigned to this kiosk."
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

function createAdminSession(role, account = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, {
    role,
    adminId: account.adminId || "",
    email: account.email || "",
    name: account.name || "",
    expiresAt: Date.now() + 8 * 60 * 60 * 1000
  });
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

  return session;
}

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
    ...(account.projectIds || []).map((id) => slug(id, "")),
    ...db.projects.filter((project) => project.adminId === account.adminId).map((project) => project.projectId)
  ].filter(Boolean));
}

function kioskIdsForAdmin(session = {}) {
  if (session.role === "super-admin") {
    return new Set(db.kiosks.map((kiosk) => String(kiosk.kioskId || "").toUpperCase()));
  }

  const account = findKioskAdminById(session.adminId);
  if (!account || account.status === "disabled") return new Set();

  const assignedProjectIds = projectIdsForAdmin(session);
  const projectKiosks = db.kiosks
    .filter((kiosk) => assignedProjectIds.has(slug(kiosk.projectId, "")))
    .map((kiosk) => String(kiosk.kioskId || "").toUpperCase());

  return new Set(projectKiosks);
}

function projectsForAdmin(session = {}) {
  const allowed = projectIdsForAdmin(session);
  return db.projects.filter((project) => allowed.has(project.projectId));
}

function kiosksForAdmin(session = {}) {
  const allowed = kioskIdsForAdmin(session);
  return db.kiosks.filter((kiosk) => allowed.has(String(kiosk.kioskId || "").toUpperCase()));
}

function adminCanAccessKiosk(session = {}, kioskId = "") {
  return kioskIdsForAdmin(session).has(String(kioskId || "").toUpperCase());
}

function jobsForAdmin(session = {}) {
  const allowed = kioskIdsForAdmin(session);
  return db.jobs.filter((job) => allowed.has(String(job.kioskId || "").toUpperCase()));
}

function paymentsForJobs(jobs = []) {
  const jobIds = new Set(jobs.map((job) => String(job.jobId || "")));
  return db.payments.filter((payment) => jobIds.has(String(payment.jobId || "")));
}

function refundsForJobs(jobs = [], payments = []) {
  const jobIds = new Set(jobs.map((job) => String(job.jobId || "")));
  const paymentIds = new Set(payments.map((payment) => String(payment.paymentId || "")));
  return db.refunds.filter((refund) => jobIds.has(String(refund.jobId || "")) || paymentIds.has(String(refund.paymentId || "")));
}

function servicesForAdmin(session = {}, kioskId = "") {
  const allowed = kioskIdsForAdmin(session);
  const requestedKioskId = String(kioskId || "").trim().toUpperCase();

  if (requestedKioskId) {
    if (!allowed.has(requestedKioskId)) return [];
    return db.services.filter((service) => !service.kioskIds.length || service.kioskIds.includes(requestedKioskId));
  }

  return db.services.filter((service) => (
    !service.kioskIds.length ||
    service.kioskIds.some((id) => allowed.has(String(id || "").toUpperCase()))
  ));
}

function pricingForServices(serviceList = []) {
  return Object.fromEntries(serviceList.map((service) => [
    service.id,
    db.pricing[service.id] || service.pricing
  ]));
}

function mergeAdminServices(session = {}, incomingServices = [], incomingPricing = null) {
  const allowedKioskIds = kioskIdsForAdmin(session);
  if (!allowedKioskIds.size) {
    return null;
  }

  const allowedExistingIds = new Set(servicesForAdmin(session).map((service) => service.id));
  const normalizedIncoming = normalizeServices(incomingServices)
    .map((service) => {
      const requestedIds = Array.isArray(service.kioskIds) ? service.kioskIds.map((id) => String(id || "").toUpperCase()) : [];
      const scopedIds = requestedIds.length
        ? requestedIds.filter((id) => allowedKioskIds.has(id))
        : [];

      return {
        ...service,
        kioskIds: requestedIds.length ? scopedIds : service.kioskIds
      };
    })
    .filter((service) => {
      if (!allowedExistingIds.has(service.id)) return true;
      if (!service.kioskIds.length) return true;
      return service.kioskIds.some((id) => allowedKioskIds.has(String(id || "").toUpperCase()));
    });

  const incomingIds = new Set(normalizedIncoming.map((service) => service.id));
  db.services = [
    ...db.services.filter((service) => !(allowedExistingIds.has(service.id) && incomingIds.has(service.id))),
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
  const allowedExtensions = new Set([".gif", ".jpg", ".jpeg", ".png", ".webp"]);
  return file.mimeType.startsWith("image/") || allowedExtensions.has(extension);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ raw });
      }
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
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
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

function isRazorpayWebhookBody(body = {}) {
  return Boolean(body && typeof body === "object" && (
    body.event ||
    body.payload ||
    body.razorpay_order_id ||
    body.razorpay_payment_id
  ));
}

function razorpayWebhookStatus(event, paymentEntity = {}, orderEntity = {}) {
  const eventName = String(event || "").toLowerCase();
  const paymentStatus = String(paymentEntity.status || "").toLowerCase();
  const orderStatus = String(orderEntity.status || "").toLowerCase();

  if (eventName === "payment.failed" || paymentStatus === "failed") return "Failed";
  if (
    eventName === "payment.captured" ||
    eventName === "order.paid" ||
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
    (details.razorpayPaymentId && String(payment.razorpayPaymentId || "") === details.razorpayPaymentId)
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
    return { ok: true, verified: false };
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

function handleLegacyPaymentWebhook(res, body = {}) {
  const payment = db.payments.find((item) => item.paymentId === body.paymentId);
  if (!payment) return json(res, 404, { error: "Payment not found" });

  payment.status = body.status || "Success";
  payment.gatewayTransactionId = body.gatewayTransactionId || payment.gatewayTransactionId || `GATEWAY-${Date.now()}`;
  payment.upiReferenceId = body.upiReferenceId || payment.upiReferenceId || `UPI-${Date.now()}`;
  payment.paidAt = new Date().toISOString();

  const job = findJob(payment.jobId);
  if (job && payment.status === "Success") {
    job.paymentStatus = "Payment Success";
    if (shouldQueueAfterPayment(job)) {
      job.printStatus = "In Queue";
    }
  }

  saveData();
  return json(res, 200, { payment, job });
}

function handlePaymentWebhook(req, res, rawBody, body = {}) {
  if (!isRazorpayWebhookBody(body) && !req.headers["x-razorpay-signature"]) {
    return handleLegacyPaymentWebhook(res, body);
  }

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

function renderMobileUploadShell({ title, eyebrow, heading, description, content, script = "" }) {
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#1769f5" />
        <title>${escapeHtml(title)} | PrintHub</title>
        <link rel="icon" type="image/png" href="/assets/printhub-mark.png" />
        <style>
          :root{--blue:#1769f5;--blue-dark:#0d47ae;--ink:#14213d;--muted:#64748b;--line:#dbe4ef;--soft:#f3f7fd;--green:#15a669;--red:#c2413b;}
          *{box-sizing:border-box;}
          html{min-height:100%;background:#eef4ff;}
          body{min-height:100vh;margin:0;background:radial-gradient(circle at 8% 4%,rgba(23,105,245,.17),transparent 30%),radial-gradient(circle at 95% 90%,rgba(21,166,105,.11),transparent 32%),linear-gradient(160deg,#f8fbff 0%,#eef4ff 100%);color:var(--ink);font-family:"Segoe UI",Inter,Arial,sans-serif;}
          body:before{background:linear-gradient(90deg,var(--blue),#20a7f7,var(--green));content:"";height:5px;left:0;position:fixed;right:0;top:0;z-index:2;}
          .page{align-items:center;display:flex;justify-content:center;min-height:100vh;padding:max(28px,env(safe-area-inset-top)) 18px max(28px,env(safe-area-inset-bottom));}
          .shell{max-width:480px;width:100%;}
          .brand{align-items:center;display:flex;justify-content:center;margin:0 auto 18px;}
          .brand img{display:block;height:auto;width:142px;}
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
          @media(max-width:380px){.page{padding-left:12px;padding-right:12px}.card-head{padding:24px 19px 20px}.card-body{padding:20px 19px 23px}.brand img{width:122px}.step{display:grid;justify-items:center}.upload-zone{min-height:175px}}
        </style>
      </head>
      <body>
        <main class="page">
          <div class="shell">
            <a class="brand" href="#" aria-label="PrintHub"><img src="/assets/printhub-logo.png" alt="PrintHub" /></a>
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
        <div class="status-note">${warning ? "Return to the PrintHub kiosk and generate a new QR code." : "Return to the kiosk to preview your documents and continue to payment."}</div>
      </div>
    `
  });
}

function renderMobileUploadPage(session) {
  if (!session) {
    return renderMobileStatusPage({
      title: "Upload link expired",
      heading: "This upload link has expired",
      description: "For your privacy, each PrintHub QR code works for one short upload session.",
      note: "No files were uploaded. Use the kiosk screen to create a fresh upload code.",
      warning: true
    });
  }

  const script = `
    const form = document.getElementById("upload-form");
    const input = document.getElementById("documents");
    const zone = document.getElementById("upload-zone");
    const selection = document.getElementById("selection");
    const count = document.getElementById("selection-count");
    const list = document.getElementById("file-list");
    const message = document.getElementById("message");
    const clearButton = document.getElementById("clear-files");
    const submitButton = document.getElementById("submit-button");
    const supported = /\\.(pdf|jpe?g|png)$/i;

    function showError(text) {
      message.textContent = text;
      message.hidden = !text;
    }

    function resetFiles() {
      input.value = "";
      selection.hidden = true;
      zone.classList.remove("selected");
      submitButton.disabled = true;
      list.replaceChildren();
    }

    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      showError("");

      if (files.length > ${MAX_FILES_PER_JOB}) {
        resetFiles();
        showError("Choose no more than ${MAX_FILES_PER_JOB} files.");
        return;
      }

      if (files.some((file) => !supported.test(file.name))) {
        resetFiles();
        showError("Only PDF, JPG, JPEG, and PNG files are supported.");
        return;
      }

      if (!files.length) {
        resetFiles();
        return;
      }

      count.textContent = files.length + (files.length === 1 ? " file selected" : " files selected");
      list.replaceChildren();
      files.slice(0, 4).forEach((file) => {
        const item = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = file.name;
        item.appendChild(name);
        list.appendChild(item);
      });
      if (files.length > 4) {
        const item = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = "+ " + (files.length - 4) + " more file(s)";
        item.appendChild(name);
        list.appendChild(item);
      }
      selection.hidden = false;
      zone.classList.add("selected");
      submitButton.disabled = false;
    });

    clearButton.addEventListener("click", resetFiles);
    form.addEventListener("submit", () => {
      submitButton.disabled = true;
      submitButton.textContent = "Sending securely...";
    });
  `;

  return renderMobileUploadShell({
    title: "Upload documents",
    eyebrow: "Secure kiosk upload",
    heading: "Upload your documents",
    description: `Send up to ${MAX_FILES_PER_JOB} files directly to the PrintHub kiosk you just scanned.`,
    content: `
      <div class="steps" aria-label="Upload steps">
        <div class="step"><span>1</span>Choose</div>
        <div class="step"><span>2</span>Send</div>
        <div class="step"><span>3</span>Preview</div>
      </div>
      <form id="upload-form" method="POST" action="/mobile-upload/${escapeHtml(session.token)}/upload" enctype="multipart/form-data">
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
        <button class="submit" id="submit-button" type="submit" disabled>Send to PrintHub Kiosk</button>
      </form>
    `,
    script
  });
}

function createJob(body) {
  const job = {
    jobId: body.jobId || `JOB-${Date.now()}`,
    kioskId: body.kioskId || defaultKioskId(),
    service: body.service || "print",
    fileName: body.fileName || "pending-upload.pdf",
    fileType: body.fileType || "PDF",
    pageCount: Number(body.pageCount || 1),
    copies: Number(body.copies || 1),
    colorMode: body.colorMode || "bw",
    paperSize: body.paperSize || "A4",
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

function calculatePrice(job) {
  const pages = Math.max(1, Number(job.pageCount) || 1);
  const copies = Math.max(1, Number(job.copies) || 1);
  const rates = serviceRates(job.service);
  const rate = job.colorMode === "color" ? rates.color : rates.bw;
  const amount = pages * copies * rate;
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

  Object.assign(job, {
    service: body.service || job.service,
    fileName: body.fileName || job.fileName,
    fileType: body.fileType || job.fileType,
    pageCount: Number(body.pageCount || job.pageCount || 1),
    copies: Number(body.copies || job.copies || 1),
    colorMode: body.colorMode || job.colorMode,
    paperSize: body.paperSize || job.paperSize,
    printStatus: "Price Calculated"
  });

  calculatePrice(job);
  return job;
}

function setJobPrintStatus(job, printStatus, extra = {}) {
  job.printStatus = printStatus || job.printStatus;

  if (/completed/i.test(job.printStatus)) {
    job.completedAt = new Date().toISOString();
  }

  if (/failed/i.test(job.printStatus)) {
    job.failedAt = new Date().toISOString();
    job.failureReason = extra.failureReason || job.failureReason || "Print failed";
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
  const kioskId = String(body.kioskId || "").trim().toUpperCase();
  const setupCode = String(body.setupCode || "").trim().toUpperCase();
  const activationDeviceId = normalizeActivationDeviceId(body.deviceId || body.activationDeviceId || body.machineId || "");
  const kiosk = db.kiosks.find((item) => String(item.kioskId || "").toUpperCase() === kioskId);

  if (!kioskId || !setupCode || !activationDeviceId) {
    return {
      status: 400,
      error: "Kiosk ID, setup code, and device identity are required. Use the latest mini-PC installer."
    };
  }

  if (!kiosk || String(kiosk.setupCode || "").toUpperCase() !== setupCode) {
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
    kioskId: String(next.kioskId || defaultKioskId()).trim(),
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
  const kioskId = String(existing.kioskId || next.kioskId || `KIOSK-${Date.now()}`).trim().toUpperCase();
  const setupCode = String(next.setupCode || existing.setupCode || crypto.randomBytes(4).toString("hex").toUpperCase()).trim().toUpperCase();

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
    setupCode,
    activatedAt: next.activatedAt || existing.activatedAt || null,
    activationDeviceId: normalizeActivationDeviceId(next.activationDeviceId || existing.activationDeviceId || next.deviceId || ""),
    lastOnline: next.lastOnline || isoNow()
  };
}

function normalizeSuperAdminRefund(record = {}, existing = {}) {
  const next = { ...existing, ...record };

  return {
    ...next,
    refundId: String(existing.refundId || next.refundId || `REF-${Date.now()}`).trim(),
    jobId: String(next.jobId || "").trim(),
    paymentId: String(next.paymentId || "").trim(),
    amount: numericPrice(next.amount, 0),
    reason: String(next.reason || "Admin refund").trim(),
    status: String(next.status || "Refund Pending").trim(),
    requestedAt: next.requestedAt || existing.requestedAt || isoNow()
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
    refunds: {
      key: "refundId",
      get: () => db.refunds,
      set: (items) => {
        db.refunds = items;
      },
      normalize: normalizeSuperAdminRefund
    },
    services: {
      key: "id",
      get: () => db.services,
      set: (items) => {
        db.services = normalizeServices(items);
      },
      normalize: normalizeSuperAdminService
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

function saveSuperAdminCollection(collection) {
  if (collection === "services" || collection === "pricing") {
    if (collection === "services") {
      syncServiceSavePricing();
    } else {
      syncServicePricing();
    }
    touchConfig(`${collection}-updated`);
    saveSettings();
  }

  saveData();
}

function superAdminSummary() {
  const gross = db.jobs.reduce((sum, job) => sum + (job.paymentStatus === "Payment Success" ? Number(job.amount || 0) : 0), 0);
  const refunds = db.refunds.reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
  const templates = db.services.reduce((sum, service) => sum + (service.templates?.length || 0), 0);

  return {
    kioskAdmins: db.kioskAdmins.length,
    projects: db.projects.length,
    kiosks: db.kiosks.length,
    services: db.services.length,
    templates,
    jobs: db.jobs.length,
    payments: db.payments.length,
    refunds: db.refunds.length,
    gross,
    net: gross - refunds,
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
    const kioskJobs = db.jobs.filter((job) => job.kioskId === kiosk.kioskId);
    const jobIds = new Set(kioskJobs.map((job) => job.jobId));
    const serviceIds = new Set(kioskJobs.map((job) => job.service));
    const kioskServices = db.services
      .filter((service) => !service.kioskIds.length || service.kioskIds.includes(kiosk.kioskId) || serviceIds.has(service.id))
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
      refunds: db.refunds.filter((refund) => jobIds.has(refund.jobId)),
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
      refunds: db.refunds,
      config: db.config
    },
    config: db.config,
    updatedAt: isoNow()
  };
}

function findCollectionItem(config, itemId) {
  return config.get().find((item) => String(item[config.key]) === itemId);
}

function validateSuperAdminRecord(collection, record) {
  if (collection === "projects" && record.adminId && !db.kioskAdmins.some((admin) => admin.adminId === record.adminId)) {
    return "Select an existing kiosk admin for this project.";
  }

  if (collection === "kiosks" && !db.projects.some((project) => project.projectId === record.projectId)) {
    return "Select an existing project before creating the kiosk.";
  }

  if (collection === "kioskAdmins") {
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

function handleSuperAdminCollection(req, res, collection, itemId, body) {
  const config = superAdminCollectionConfig(collection);

  if (!config) {
    return json(res, 404, { error: "Unknown super admin collection." });
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
    if (items.some((item) => String(item[config.key]) === id)) {
      return json(res, 409, { error: "Record already exists." });
    }
    items.push(record);
    config.set(items);
    saveSuperAdminCollection(collection);
    return json(res, 201, { record, [collection]: config.get() });
  }

  if ((req.method === "PUT" || req.method === "PATCH") && itemId) {
    const index = items.findIndex((item) => String(item[config.key]) === itemId);
    if (index === -1) return json(res, 404, { error: "Record not found" });
    const record = config.normalize({ ...items[index], ...(body[collection.slice(0, -1)] || body), [config.key]: items[index][config.key] }, items[index]);
    const validationError = validateSuperAdminRecord(collection, record);
    if (validationError) return json(res, 400, { error: validationError });
    items[index] = record;
    config.set(items);
    saveSuperAdminCollection(collection);
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
      return json(res, 409, { error: "Remove this project from its kiosk admin allocation before deleting it." });
    }
    if (collection === "kioskAdmins") {
      if (items.length <= 1) {
        return json(res, 409, { error: "At least one kiosk admin must remain." });
      }
      if (db.projects.some((project) => project.adminId === normalizeAdminId(itemId)) || db.kiosks.some((kiosk) => kiosk.adminId && normalizeAdminId(kiosk.adminId) === normalizeAdminId(itemId))) {
        return json(res, 409, { error: "Move this admin's projects and kiosks to another admin before deleting." });
      }
    }
    const [deleted] = items.splice(index, 1);
    config.set(items);
    if (collection === "services") {
      delete db.pricing[itemId];
    }
    saveSuperAdminCollection(collection);
    return json(res, 200, { deleted, [collection]: config.get() });
  }

  return json(res, 405, { error: "Unsupported super admin operation." });
}

const server = http.createServer(async (req, res) => {
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

  if (req.method === "GET" && url.pathname === "/admin") {
    return redirect(res, "/admin.html");
  }

  if (req.method === "GET" && url.pathname === "/super-admin") {
    return redirect(res, "/super-admin.html");
  }

  if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
    return serveFrontendAsset(res, path.basename(url.pathname));
  }

  const frontendFilename = path.basename(url.pathname);
  if (req.method === "GET" && url.pathname === `/${frontendFilename}` && FRONTEND_FILES.has(frontendFilename)) {
    if (DISABLE_ADMIN_ACCESS && ADMIN_FRONTEND_FILES.has(frontendFilename)) {
      return json(res, 403, { error: "Admin access is disabled on this kiosk." });
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

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const result = authenticatedAdminResponse(body);
    return json(res, result.status, result.body);
  }

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    const result = authenticatedAdminResponse(body);
    if (result.body.role !== "kiosk-admin") {
      return json(res, 401, { error: "Invalid kiosk admin credentials." });
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

  if (url.pathname.startsWith("/api/super-admin/") && url.pathname !== "/api/super-admin/login") {
    if (!requireAdminSession(req, res, "super-admin")) return;
  }

  if (req.method === "GET" && url.pathname === "/api/kiosk/config") {
    return json(res, 200, kioskConfigResponse(url.searchParams.get("kioskId") || ""));
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

    return binary(res, 200, fs.readFileSync(filePath), imageContentType(filename));
  }

  if (req.method === "POST" && url.pathname === "/api/admin/service-image") {
    if (!isMultipart) {
      return json(res, 400, { error: "Upload must use multipart/form-data." });
    }

    const parts = parseMultipartParts(await readRawBody(req), req.headers["content-type"] || "");
    const file = parts.find((part) => part.filename && ["image", "serviceImage", "templateImage"].includes(part.name)) ||
      parts.find((part) => part.filename);

    if (!isAllowedServiceImage(file)) {
      return json(res, 400, { error: "Upload a PNG, JPG, GIF, or WebP image." });
    }

    if (file.content.length > 3 * 1024 * 1024) {
      return json(res, 413, { error: "Image must be 3 MB or smaller." });
    }

    ensureUploadDirs();
    const filename = safeUploadedImageName(file.filename);
    fs.writeFileSync(path.join(SERVICE_IMAGE_DIR, filename), file.content);

    return json(res, 201, {
      imageUrl: `${publicOrigin(req)}/uploads/service-images/${encodeURIComponent(filename)}`,
      filename,
      size: file.content.length
    });
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
        description: "PrintHub accepts PDF, JPG, JPEG, and PNG documents from this mobile upload page.",
        note: "Nothing was added to the print session.",
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
      description: "Your documents are now ready on the PrintHub kiosk screen.",
      note: "You can close this page. Continue on the kiosk to review print options and pay."
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/create") {
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
    Object.assign(job, {
      copies: Number(body.copies || job.copies),
      colorMode: body.colorMode || job.colorMode,
      paperSize: body.paperSize || job.paperSize,
      printStatus: "Settings Selected"
    });
    saveData();
    return json(res, 200, { job });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/jobs/price/")) {
    const job = findJob(url.pathname.split("/").pop());
    if (!job) return json(res, 404, { error: "Job not found" });
    return json(res, 200, { jobId: job.jobId, amount: calculatePrice(job), pricing: db.pricing });
  }

  if (req.method === "POST" && url.pathname === "/api/payment/create") {
    const config = razorpayConfig();

    if (!razorpayIsConfigured()) {
      return json(res, 503, {
        error: "Razorpay keys are not configured.",
        setup: "Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET before starting the kiosk."
      });
    }

    const job = upsertPaymentJob(body);
    const amount = amountToPaise(job.amount);
    let razorpayOrder;

    if (!Number.isFinite(amount) || amount <= 0) {
      return json(res, 400, { error: "Payment amount must be greater than zero." });
    }

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

    const payment = {
      paymentId: `PAY-${Date.now()}`,
      gateway: "razorpay",
      jobId: job.jobId,
      amount: job.amount,
      amountInPaise: amount,
      currency: "INR",
      paymentMethod: "Razorpay Checkout",
      razorpayOrderId: razorpayOrder.id,
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
      checkout: {
        key: config.keyId,
        orderId: razorpayOrder.id,
        amount,
        currency: "INR",
        name: "Smart Printing Kiosk",
        description: `${job.fileName} | ${job.pageCount} page(s)`,
        prefill: {
          name: "Kiosk Customer",
          contact: "",
          email: ""
        }
      }
    });
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
    const job = findJob(body.jobId);
    if (!job) return json(res, 404, { error: "Job not found" });

    if (body.paymentStatus) {
      job.paymentStatus = body.paymentStatus;
    }

    return json(res, 200, {
      job: setJobPrintStatus(job, body.printStatus, { failureReason: body.failureReason })
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

  if (url.pathname.startsWith("/api/admin/") && req.method !== "GET") {
    return json(res, 403, { error: "Kiosk admin access is read-only. Changes can only be made by the super admin." });
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
    const adminPayments = paymentsForJobs(adminJobs);
    const adminRefunds = refundsForJobs(adminJobs, adminPayments);
    const adminServices = servicesForAdmin(adminSession);
    const gross = adminJobs.reduce((sum, job) => sum + (job.paymentStatus === "Payment Success" ? Number(job.amount || 0) : 0), 0);
    const refunds = adminRefunds.reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
    return json(res, 200, { gross, refunds, net: gross - refunds, pricing: pricingForServices(adminServices), services: adminServices, config: db.config });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/pricing") {
    const adminServices = servicesForAdmin(adminSession);
    return json(res, 200, { pricing: pricingForServices(adminServices), services: adminServices, config: db.config });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/services") {
    const kioskId = url.searchParams.get("kioskId");
    const services = servicesForAdmin(adminSession, kioskId);
    return json(res, 200, { services, pricing: pricingForServices(services), config: db.config });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/transactions") {
    return json(res, 200, { payments: paymentsForJobs(jobsForAdmin(adminSession)) });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/refunds") {
    const adminJobs = jobsForAdmin(adminSession);
    return json(res, 200, { refunds: refundsForJobs(adminJobs, paymentsForJobs(adminJobs)) });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/print-history") {
    return json(res, 200, { jobs: jobsForAdmin(adminSession) });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/reports") {
    return json(res, 200, {
      reports: ["daily-sales", "monthly-sales", "failed-transactions", "refunds", "maintenance"]
    });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/kiosks") {
    return json(res, 200, { kiosks: kiosksForAdmin(adminSession) });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/projects") {
    return json(res, 200, { projects: projectsForAdmin(adminSession) });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/kiosks") {
    const kiosk = normalizeSuperAdminKiosk({
      ...(body.kiosk || body),
      adminId: adminSession.adminId
    });

    if (db.kiosks.some((item) => String(item.kioskId).toUpperCase() === kiosk.kioskId)) {
      return json(res, 409, { error: "Kiosk ID already exists." });
    }

    db.kiosks.push(kiosk);
    saveData();
    return json(res, 201, { kiosk, kiosks: kiosksForAdmin(adminSession) });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/system-status") {
    return json(res, 200, {
      kiosks: kiosksForAdmin(adminSession),
      backend: "online",
      localAgentExpectedPort: 5077
    });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/pricing") {
    const adminServices = servicesForAdmin(adminSession);
    const allowedServiceIds = new Set(adminServices.map((service) => service.id));
    const requestedPricing = body.pricing || body;
    const scopedPricing = {};

    if (requestedPricing && typeof requestedPricing === "object") {
      Object.entries(requestedPricing).forEach(([serviceId, rates]) => {
        if (allowedServiceIds.has(serviceId)) {
          scopedPricing[serviceId] = rates;
        }
      });
    }

    db.pricing = normalizePricing({ ...db.pricing, ...scopedPricing }, db.services);
    db.services = db.services.map((service) => ({
      ...service,
      pricing: db.pricing[service.id] || service.pricing
    }));
    touchConfig("pricing-updated");
    saveSettings();
    saveData();
    const scopedServices = servicesForAdmin(adminSession);
    return json(res, 200, { pricing: pricingForServices(scopedServices), services: scopedServices, config: db.config });
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
    return json(res, 200, { services: scopedServices, pricing: pricingForServices(scopedServices), config: db.config });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/refund") {
    const adminJobs = jobsForAdmin(adminSession);
    const adminPayments = paymentsForJobs(adminJobs);
    const canRefundJob = adminJobs.some((job) => String(job.jobId || "") === String(body.jobId || ""));
    const canRefundPayment = adminPayments.some((payment) => String(payment.paymentId || "") === String(body.paymentId || ""));
    if (!canRefundJob && !canRefundPayment) {
      return json(res, 403, { error: "This refund is outside your assigned kiosks." });
    }

    const refund = {
      refundId: `REF-${Date.now()}`,
      jobId: body.jobId,
      paymentId: body.paymentId,
      amount: Number(body.amount || 0),
      reason: body.reason || "Print failed",
      status: "Refund Pending",
      requestedAt: new Date().toISOString()
    };
    db.refunds.push(refund);
    saveData();
    return json(res, 201, { refund });
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
});

async function startServer() {
  await initializePersistence();

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
