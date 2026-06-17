const fs = require("node:fs");
const path = require("node:path");

const defaultEnvPath = path.join(__dirname, ".env");

function unquote(value) {
  const trimmed = value.trim();
  const quote = trimmed[0];

  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    const inner = trimmed.slice(1, -1);
    return quote === '"' ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"') : inner;
  }

  return trimmed;
}

function loadEnv(envPath = defaultEnvPath) {
  if (!fs.existsSync(envPath)) {
    return {};
  }

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
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return loaded;
}

module.exports = { loadEnv };

if (require.main === module) {
  const loaded = loadEnv();
  console.log(`Loaded ${Object.keys(loaded).length} variable(s) from ${defaultEnvPath}`);
}
