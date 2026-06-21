const fs = require("node:fs");
const path = require("node:path");

const defaultEnvPath = path.join(__dirname, ".env");
const rootEnvPath = path.join(__dirname, "..", ".env");

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean).map((item) => path.resolve(item)))];
}

function unquote(value) {
  const trimmed = value.trim();
  const quote = trimmed[0];

  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    const inner = trimmed.slice(1, -1);
    return quote === '"' ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"') : inner;
  }

  return trimmed;
}

function readEnvFile(envPath) {
  const loaded = {};
  const content = fs.readFileSync(envPath, "utf8");

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator === -1) continue;

    const key = normalized.slice(0, separator).trim();
    const value = unquote(normalized.slice(separator + 1));

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    loaded[key] = value;
    if (process.env[key] === undefined || !String(process.env[key]).trim()) {
      process.env[key] = value;
    }
  }

  return loaded;
}

function loadEnv(envPath = [defaultEnvPath, rootEnvPath, path.join(process.cwd(), ".env")]) {
  const envPaths = uniquePaths(Array.isArray(envPath) ? envPath : [envPath]);
  const loaded = {};

  for (const candidate of envPaths) {
    if (!fs.existsSync(candidate)) continue;
    Object.assign(loaded, readEnvFile(candidate));
  }

  return loaded;
}

module.exports = { loadEnv };

if (require.main === module) {
  const loaded = loadEnv();
  console.log(`Loaded ${Object.keys(loaded).length} variable(s).`);
}
