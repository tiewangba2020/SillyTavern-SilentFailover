import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
const ext = "release/SillyTavern-SilentFailover",
  server = "release/SillyTavern-SilentFailover-Server";
fs.mkdirSync(ext + "/dist", { recursive: true });
fs.mkdirSync(server, { recursive: true });
await build({
  entryPoints: ["extension/index.js"],
  outfile: ext + "/dist/index.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: false,
});
await build({
  entryPoints: ["server/index.js"],
  outfile: server + "/index.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  minify: false,
});
for (const name of ["manifest.json", "style.css"])
  fs.copyFileSync("extension/" + name, ext + "/" + name);
fs.writeFileSync(
  server + "/package.json",
  JSON.stringify(
    {
      name: "sillytavern-silent-failover-server",
      version: "1.1.1",
      main: "index.cjs",
      private: true,
    },
    null,
    2,
  ),
);
for (const dest of [ext, server])
  if (fs.existsSync("README.md"))
    fs.copyFileSync("README.md", dest + "/README.md");
await build({
  entryPoints: ["tools/install.mjs"],
  outfile: "release/install.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
if (fs.existsSync("README.md"))
  fs.copyFileSync("README.md", "release/README.md");
fs.copyFileSync("docs/PUBLIC-VERIFICATION.md", "release/VERIFICATION.md");
// Remove private reports left by older local builds.
for (const name of ["NATIVE-LINK-VERIFICATION.md", "REAL-API-VERIFICATION.md", "LIVE-BROWSER-VERIFICATION-1.1.1.md"])
  if (fs.existsSync(path.join("release", name))) fs.unlinkSync(path.join("release", name));
for (const dest of [ext, server, "release"])
  fs.copyFileSync("LICENSE", dest + "/LICENSE");
const notices = ["eventsource-parser", "yaml"]
  .map(
    (name) =>
      name +
      "\n\n" +
      fs.readFileSync("node_modules/" + name + "/LICENSE", "utf8"),
  )
  .join("\n\n");
for (const dest of [server, "release"])
  fs.writeFileSync(dest + "/THIRD_PARTY_NOTICES.txt", notices);
console.log("Built frontend extension and self-contained server plugin.");
