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
const SETTINGS_PATH = path.join(__dirname, "settings.json");
const DATA_PATH = path.join(__dirname, "data.json");
const FRONTEND_DIR = path.join(__dirname, "../frontend");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const SERVICE_IMAGE_DIR = path.join(UPLOADS_DIR, "service-images");
const mobileUploadSessions = new Map();
const adminSessions = new Map();
const ADMIN_CREDENTIALS = {
  email: process.env.KIOSK_ADMIN_EMAIL || process.env.ADMIN_EMAIL || "admin@printingkiosk.local",
  password: process.env.KIOSK_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "demo1234"
};
const SUPER_ADMIN_CREDENTIALS = {
  email: process.env.SUPER_ADMIN_EMAIL || process.env.SUPER_EMAIL || "superadmin@printingkiosk.local",
  password: process.env.SUPER_ADMIN_PASSWORD || process.env.SUPER_PASSWORD || "superdemo1234"
};
const DEFAULT_KIOSK_ADMIN_ID = process.env.KIOSK_ADMIN_ID || "default-admin";
const FRONTEND_FILES = new Set([
  "index.html",
  "admin.html",
  "super-admin.html",
  "styles.css",
  "app.js",
  "super-admin.js"
]);
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
      { id: "birth-certificate", title: "Birth Certificate Form", description: "Blank Form No. 5 birth certificate template.", pages: 1, fields: ["Name", "Sex", "Date of birth", "Place of birth", "Mother name", "Father name"], imageUrl: "https://www.pdffiller.com/preview/29/559/29559281/large.png" },
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
    kioskIds: Array.isArray(next.kioskIds)
      ? next.kioskIds.map((item) => String(item || "").trim().toUpperCase()).filter(Boolean)
      : []
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

  return {
    jobs: Array.isArray(persistedData.jobs) ? persistedData.jobs : [],
    payments: Array.isArray(persistedData.payments) ? persistedData.payments : [],
    services: persistedServices,
    pricing: normalizePricing(persistedData.pricing || persistedSettings.pricing, persistedServices),
    kiosks: persistedKiosks.map((kiosk) => normalizeSuperAdminKiosk({
      adminId: kiosk.adminId || fallbackAdminId,
      ...kiosk
    })),
    kioskAdmins,
    refunds: Array.isArray(persistedData.refunds) ? persistedData.refunds : [],
    config: normalizeConfigMeta(persistedData.config || persistedSettings.config, persistedData.updatedAt)
  };
}

function defaultKiosk() {
  return {
    kioskId: process.env.KIOSK_ID || "KIOSK-BANK-01",
    name: process.env.KIOSK_NAME || os.hostname(),
    branch: process.env.KIOSK_BRANCH || "Local Branch",
    adminId: process.env.KIOSK_ADMIN_ID || DEFAULT_KIOSK_ADMIN_ID,
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

function credentialsMatch(body, expected) {
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");

  return email === String(expected.email || "").trim().toLowerCase() && password === String(expected.password || "");
}

function publicKioskAdmin(admin = {}) {
  return {
    adminId: admin.adminId,
    name: admin.name,
    email: admin.email,
    status: admin.status,
    kioskIds: Array.isArray(admin.kioskIds) ? admin.kioskIds : []
  };
}

function findKioskAdminByCredentials(body = {}) {
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  return db.kioskAdmins.find((admin) => (
    admin.status !== "disabled" &&
    admin.email === email &&
    admin.password === password
  )) || null;
}

function findKioskAdminById(adminId = "") {
  const id = normalizeAdminId(adminId);
  return db.kioskAdmins.find((admin) => admin.adminId === id) || null;
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

function kioskIdsForAdmin(session = {}) {
  if (session.role === "super-admin") {
    return new Set(db.kiosks.map((kiosk) => String(kiosk.kioskId || "").toUpperCase()));
  }

  const account = findKioskAdminById(session.adminId);
  if (!account || account.status === "disabled") return new Set();

  const explicit = new Set((account.kioskIds || []).map((id) => String(id || "").toUpperCase()).filter(Boolean));
  const owned = db.kiosks
    .filter((kiosk) => normalizeAdminId(kiosk.adminId) === account.adminId)
    .map((kiosk) => String(kiosk.kioskId || "").toUpperCase());

  return new Set([...explicit, ...owned]);
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

function razorpayConfig() {
  return {
    keyId: process.env.RAZORPAY_KEY_ID || "",
    keySecret: process.env.RAZORPAY_KEY_SECRET || "",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || ""
  };
}

function razorpayIsConfigured() {
  const config = razorpayConfig();
  return Boolean(config.keyId && config.keySecret);
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
    createdAt: new Date().toISOString()
  };

  mobileUploadSessions.set(token, session);
  return session;
}

function uploadSessionResponse(session, req = null) {
  if (!session) return null;
  const baseUrl = req ? uploadBaseUrl(req, session) : (session.publicBaseUrl || `http://${localUploadHost()}:${PORT}`).replace(/\/+$/, "");

  return {
    token: session.token,
    uploadUrl: session.uploadUrl,
    qrSvg: session.qrSvg,
    status: session.status,
    file: session.file
      ? {
          name: session.file.name,
          size: session.file.size,
          mimeType: session.file.mimeType,
          pages: session.file.pages,
          previewUrl: `${baseUrl}/mobile-upload/${session.token}/file`
        }
      : null
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

function renderMobileUploadPage(session) {
  if (!session) {
    return `
      <!doctype html>
      <html><head><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Upload expired</title></head>
      <body style="font-family:Cambria, Georgia, 'Times New Roman', serif;padding:24px;background:#f3f6f5;color:#172033;"><h1>Upload link expired</h1><p>Please generate a new QR on the kiosk.</p></body></html>
    `;
  }

  return `
    <!doctype html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Upload to Printing Kiosk</title>
        <style>
          body{font-family:Cambria, Georgia, 'Times New Roman', serif;margin:0;background:#f3f6f5;color:#172033;}
          main{min-height:100vh;display:grid;align-content:center;padding:24px;}
          form{background:white;border:1px solid #d8e0e7;border-radius:10px;padding:24px;display:grid;gap:16px;box-shadow:0 18px 40px rgba(23,32,51,.1);}
          h1{margin:0;font-size:24px;}
          p{color:#647184;line-height:1.5;margin:0;}
          input{border:1px solid #d8e0e7;border-radius:8px;padding:14px;width:100%;font:inherit;}
          button{background:#1f5fbf;color:white;border:0;border-radius:8px;font:inherit;font-weight:800;min-height:48px;}
        </style>
      </head>
      <body>
        <main>
          <form method="POST" action="/mobile-upload/${escapeHtml(session.token)}/upload" enctype="multipart/form-data">
            <h1>Send document to kiosk</h1>
            <p>Choose PDF, DOCX, JPG, or PNG from your phone. After upload, the kiosk will show preview automatically.</p>
            <input name="document" type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" required />
            <button type="submit">Send to Kiosk</button>
          </form>
        </main>
      </body>
    </html>
  `;
}

function createJob(body) {
  const job = {
    jobId: body.jobId || `JOB-${Date.now()}`,
    kioskId: body.kioskId || "KIOSK-BANK-01",
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
    kioskId: String(next.kioskId || "KIOSK-BANK-01").trim(),
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
    adminId: normalizeAdminId(next.adminId || DEFAULT_KIOSK_ADMIN_ID),
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
    const kioskAdmin = db.kioskAdmins.find((admin) => admin.adminId === kiosk.adminId) || null;
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
    if (collection === "kioskAdmins") {
      if (items.length <= 1) {
        return json(res, 409, { error: "At least one kiosk admin must remain." });
      }
      if (db.kiosks.some((kiosk) => normalizeAdminId(kiosk.adminId) === normalizeAdminId(itemId))) {
        return json(res, 409, { error: "Move this admin's kiosks to another admin before deleting." });
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
      payments: {
        gateway: "razorpay",
        razorpayConfigured: razorpayIsConfigured()
      },
      time: new Date().toISOString()
    });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    const kioskAdmin = findKioskAdminByCredentials(body);
    if (!kioskAdmin) {
      return json(res, 401, { error: "Invalid kiosk admin credentials." });
    }

    kioskAdmin.lastLoginAt = isoNow();
    saveData();
    return json(res, 200, { ok: true, role: "kiosk-admin", admin: publicKioskAdmin(kioskAdmin), token: createAdminSession("kiosk-admin", kioskAdmin) });
  }

  if (req.method === "POST" && url.pathname === "/api/super-admin/login") {
    if (!credentialsMatch(body, SUPER_ADMIN_CREDENTIALS)) {
      return json(res, 401, { error: "Invalid super admin credentials." });
    }

    return json(res, 200, { ok: true, role: "super-admin", token: createAdminSession("super-admin") });
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

  if (req.method === "GET" && url.pathname.startsWith("/mobile-upload/") && url.pathname.endsWith("/file")) {
    const token = url.pathname.split("/")[2];
    const session = mobileUploadSessions.get(token);

    if (!session?.file?.content) {
      return json(res, 404, { error: "Uploaded file not found" });
    }

    return binary(res, 200, session.file.content, session.file.mimeType);
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

    const file = parseMultipartFile(await readRawBody(req), req.headers["content-type"] || "");

    if (!file) {
      return html(res, 400, `
        <!doctype html>
        <html><head><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Upload failed</title></head>
        <body style="font-family:Cambria, Georgia, 'Times New Roman', serif;padding:24px;background:#f3f6f5;color:#172033;"><h1>Upload failed</h1><p>Please go back and choose a valid document.</p></body></html>
      `);
    }

    session.status = "uploaded";
    session.file = file;
    session.uploadedAt = new Date().toISOString();

    return html(res, 200, `
      <!doctype html>
      <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Uploaded</title></head>
        <body style="font-family:Cambria, Georgia, 'Times New Roman', serif;padding:24px;background:#f3f6f5;color:#172033;">
          <main style="background:white;border:1px solid #d8e0e7;border-radius:10px;padding:22px;">
            <h1>Document sent</h1>
            <p>${escapeHtml(file.name)} has been sent to the kiosk. Please continue on the kiosk screen.</p>
          </main>
        </body>
      </html>
    `);
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
    return json(res, 200, { job, note: "Connect multer or signed object storage for real uploads." });
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
    if (!razorpayIsConfigured()) {
      return json(res, 503, {
        error: "Razorpay test keys are not configured.",
        setup: "Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET before starting the kiosk."
      });
    }

    const job = upsertPaymentJob(body);
    const amount = amountToPaise(job.amount);
    let razorpayOrder;

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
        key: razorpayConfig().keyId,
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
    if (!razorpayIsConfigured()) {
      return json(res, 503, { error: "Razorpay test keys are not configured." });
    }

    const payment = db.payments.find((item) => item.razorpayOrderId === body.razorpay_order_id);
    if (!payment) return json(res, 404, { error: "Razorpay order was not found in kiosk payments." });

    const job = findJob(payment.jobId);
    if (!job) return json(res, 404, { error: "Payment job was not found." });

    const expectedSignature = crypto
      .createHmac("sha256", razorpayConfig().keySecret)
      .update(`${payment.razorpayOrderId}|${body.razorpay_payment_id}`)
      .digest("hex");

    if (!secureCompare(expectedSignature, body.razorpay_signature)) {
      payment.status = "Signature Failed";
      payment.failedAt = new Date().toISOString();
      return json(res, 400, { error: "Razorpay payment signature verification failed." });
    }

    payment.status = "Success";
    payment.razorpayPaymentId = body.razorpay_payment_id;
    payment.razorpaySignature = body.razorpay_signature;
    payment.paidAt = new Date().toISOString();
    job.paymentStatus = "Payment Success";
    job.printStatus = "In Queue";
    saveData();

    return json(res, 200, { payment, job });
  }

  if (req.method === "POST" && url.pathname === "/api/payment/webhook") {
    const payment = db.payments.find((item) => item.paymentId === body.paymentId);
    if (!payment) return json(res, 404, { error: "Payment not found" });
    payment.status = body.status || "Success";
    payment.gatewayTransactionId = body.gatewayTransactionId || `GATEWAY-${Date.now()}`;
    payment.upiReferenceId = body.upiReferenceId || `UPI-${Date.now()}`;
    payment.paidAt = new Date().toISOString();
    const job = findJob(payment.jobId);
    if (job && payment.status === "Success") {
      job.paymentStatus = "Payment Success";
      job.printStatus = "In Queue";
    }
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
