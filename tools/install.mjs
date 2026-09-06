import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const artifactRoot = fs.existsSync(
  path.join(project, "release", "SillyTavern-SilentFailover"),
)
  ? path.join(project, "release")
  : path.dirname(fileURLToPath(import.meta.url));
function copyTree(source, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name),
      to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}
const target = process.argv[process.argv.indexOf("--target") + 1];
if (!process.argv.includes("--target") || !target)
  throw new Error(
    "Usage: node tools/install.mjs --target <SillyTavern directory>",
  );
const root = fs.realpathSync(path.resolve(target));
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
if (pkg.name !== "sillytavern" || !fs.existsSync(path.join(root, "server.js")))
  throw new Error("Target is not a SillyTavern installation");
const parts = String(pkg.version).split(".").map(Number);
if (parts[0] < 1 || (parts[0] === 1 && parts[1] < 18))
  throw new Error("SillyTavern 1.18.0 or newer is required");
const configArg = process.argv.includes("--config")
  ? process.argv[process.argv.indexOf("--config") + 1]
  : null;
if (
  process.argv.includes("--config") &&
  (!configArg || configArg.startsWith("--"))
)
  throw new Error(
    "--config requires the config.yaml path used to start SillyTavern",
  );
const rootConfig = path.join(root, "config.yaml");
const dockerConfig = path.join(root, "config", "config.yaml");
if (
  !configArg &&
  fs.existsSync(rootConfig) &&
  fs.existsSync(dockerConfig) &&
  fs.realpathSync(rootConfig) !== fs.realpathSync(dockerConfig)
)
  throw new Error(
    "Multiple config files found. Use --config to select the active config.yaml",
  );
const selectedConfig = configArg
  ? path.resolve(root, configArg)
  : fs.existsSync(dockerConfig)
    ? dockerConfig
    : rootConfig;
const configPath = fs.existsSync(selectedConfig)
  ? fs.realpathSync(selectedConfig)
  : selectedConfig;
fs.accessSync(path.dirname(configPath), fs.constants.W_OK);
const source = fs.existsSync(configPath)
  ? configPath
  : path.join(root, "default/config.yaml");
const doc = parseDocument(fs.readFileSync(source, "utf8"));
if (doc.errors.length) throw new Error("Existing config YAML cannot be parsed");
for (const name of [
  "SillyTavern-SilentFailover",
  "SillyTavern-SilentFailover-Server",
])
  if (!fs.existsSync(path.join(artifactRoot, name)))
    throw new Error("Build artifacts not found");
const backup = path.join(
  root,
  "backups",
  "silent-failover-" + new Date().toISOString().replace(/[:.]/g, "-"),
);
fs.mkdirSync(backup, { recursive: true });
for (const [name, parent] of [
  ["SillyTavern-SilentFailover", "public/scripts/extensions/third-party"],
  ["SillyTavern-SilentFailover-Server", "plugins"],
]) {
  const source = path.join(artifactRoot, name);
  if (!fs.existsSync(source)) throw new Error("Run npm run build first");
  const dest = path.join(root, parent, name);
  if (fs.existsSync(dest)) copyTree(dest, path.join(backup, name));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  copyTree(source, dest);
}
if (fs.existsSync(configPath))
  fs.copyFileSync(configPath, path.join(backup, "config.yaml"));
doc.set("enableServerPlugins", true);
fs.writeFileSync(configPath + ".silent-failover.tmp", doc.toString());
fs.renameSync(configPath + ".silent-failover.tmp", configPath);
console.log(
  JSON.stringify(
    { installed: root, configPath, backup, restartRequired: true },
    null,
    2,
  ),
);
