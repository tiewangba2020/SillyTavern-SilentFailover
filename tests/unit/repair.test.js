import { test, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const script = path.resolve("repair.mjs");
const cleanup = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);

function tavern() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-repair-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "public/scripts/extensions/third-party"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "sillytavern", version: "1.18.0" }),
  );
  fs.writeFileSync(path.join(dir, "server.js"), "// stub\n");
  fs.writeFileSync(path.join(dir, "config.yaml"), "enableServerPlugins: false\n");
  fs.mkdirSync(path.join(dir, "data/default-user/silent-failover"), { recursive: true });
  return dir;
}

function bundle(dir, version = "9.9.9") {
  const files = {
    "frontend/manifest.json": JSON.stringify({ version }),
    "frontend/style.css": "/* x */",
    "frontend/dist/index.js": "export const VERSION = '" + version + "';",
    "server/package.json": JSON.stringify({ version }),
    "server/index.cjs": "// server " + version,
  };
  const file = path.join(dir, "bundle.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      schema: 1,
      version,
      files: Object.entries(files).map(([name, text]) => ({
        path: name,
        content: Buffer.from(text).toString("base64"),
        sha256: "ignored-by-repair",
      })),
    }),
  );
  return file;
}

const run = (dir, extra = []) =>
  execFileSync(process.execPath, [script, "--target", dir, ...extra], {
    encoding: "utf8",
  });

test("installs both halves, enables the server plugin and keeps a backup", () => {
  const dir = tavern();
  fs.writeFileSync(path.join(dir, "config.yaml"), "port: 8000\nenableServerPlugins: false\n");
  const output = run(dir, ["--bundle", bundle(dir)]);
  expect(output).toContain("9.9.9");
  expect(
    JSON.parse(
      fs.readFileSync(
        path.join(dir, "public/scripts/extensions/third-party/SillyTavern-SilentFailover/manifest.json"),
        "utf8",
      ),
    ).version,
  ).toBe("9.9.9");
  expect(
    fs.readFileSync(path.join(dir, "plugins/SillyTavern-SilentFailover-Server/index.cjs"), "utf8"),
  ).toContain("9.9.9");
  expect(fs.readFileSync(path.join(dir, "config.yaml"), "utf8")).toContain(
    "enableServerPlugins: true",
  );
});

test("salvages a broken config from the temporary file and reports node count", () => {
  const dir = tavern();
  const folder = path.join(dir, "data/default-user/silent-failover");
  fs.writeFileSync(path.join(folder, "config.json"), '{"nodes": [{"na');
  fs.writeFileSync(
    path.join(folder, "config.json.0f9c1a2b-1111-2222-3333-444455556666.tmp"),
    JSON.stringify({ schema: 3, nodes: [{ name: "a", key: "k" }, { name: "b" }] }),
  );
  const output = run(dir, ["--bundle", bundle(dir)]);
  expect(output).toContain("已从临时文件恢复，2 个节点");
  const saved = JSON.parse(fs.readFileSync(path.join(folder, "config.json"), "utf8"));
  expect(saved.nodes).toHaveLength(2);
});

test("backs up an unrepairable config and refuses to touch a non-tavern directory", () => {
  const dir = tavern();
  const folder = path.join(dir, "data/default-user/silent-failover");
  fs.writeFileSync(path.join(folder, "config.json"), "not json at all");
  const output = run(dir, ["--bundle", bundle(dir)]);
  expect(output).toContain("已备份为 config.json.broken-");
  expect(fs.existsSync(path.join(folder, "config.json"))).toBe(false);
  expect(
    fs.readdirSync(folder).some((name) => name.startsWith("config.json.broken-")),
  ).toBe(true);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sf-not-tavern-"));
  cleanup.push(() => fs.rmSync(empty, { recursive: true, force: true }));
  expect(() => run(empty, ["--bundle", bundle(dir)])).toThrow();
});
