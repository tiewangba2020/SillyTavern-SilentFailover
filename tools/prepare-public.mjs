import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, ".publish", "github");
const copy = (source, target) => {
  if (fs.statSync(source).isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) copy(path.join(source, name), path.join(target, name));
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
};

// An explicit allowlist keeps local verification data out of the public repository.
for (const name of [
  "extension", "server", "tests", "tools", "package.json", "package-lock.json",
  "README.md", "LICENSE", ".gitignore", "playwright.config.js", "vitest.config.js",
  "docs/DEVELOPMENT.md",
]) copy(path.join(root, name), path.join(destination, name));
const obsoleteReport = path.join(destination, "docs/PUBLIC-VERIFICATION.md");
if (fs.existsSync(obsoleteReport)) fs.unlinkSync(obsoleteReport);
for (const name of ["manifest.json", "style.css", "dist"])
  copy(path.join(root, "release/SillyTavern-SilentFailover", name), path.join(destination, name));
console.log("Prepared public source and installable frontend at " + destination);
