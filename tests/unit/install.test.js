import { test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
test("bundled installer installs and upgrades artifacts while preserving existing config and data", () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "sf-install-"));
  try {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "sillytavern", version: "1.18.0" }),
    );
    fs.writeFileSync(path.join(root, "server.js"), "");
    fs.mkdirSync(path.join(root, "data"));
    fs.writeFileSync(path.join(root, "data", "existing.txt"), "preserve");
    const before =
      "# preserve comment\nport: 8123\nenableServerPlugins: false\ncustomSetting: keep\n";
    fs.writeFileSync(path.join(root, "config.yaml"), before);
    const run = () =>
      spawnSync(process.execPath, ["release/install.mjs", "--target", root], {
        encoding: "utf8",
      });
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    const info = JSON.parse(first.stdout);
    expect(fs.readFileSync(path.join(info.backup, "config.yaml"), "utf8")).toBe(
      before,
    );
    const config = fs.readFileSync(path.join(root, "config.yaml"), "utf8");
    expect(config).toContain("# preserve comment");
    expect(parse(config)).toEqual({
      port: 8123,
      enableServerPlugins: true,
      customSetting: "keep",
    });
    const ext = path.join(
      root,
      "public/scripts/extensions/third-party/SillyTavern-SilentFailover",
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ext, "manifest.json"), "utf8"),
    );
    expect(fs.existsSync(path.join(ext, manifest.js))).toBe(true);
    expect(fs.existsSync(path.join(ext, manifest.css))).toBe(true);
    const plugin = path.join(root, "plugins/SillyTavern-SilentFailover-Server");
    const p = JSON.parse(
      fs.readFileSync(path.join(plugin, "package.json"), "utf8"),
    );
    expect(fs.existsSync(path.join(plugin, p.main))).toBe(true);
    const second = run();
    expect(second.status, second.stderr).toBe(0);
    const backup = JSON.parse(second.stdout).backup;
    expect(
      fs.existsSync(
        path.join(backup, "SillyTavern-SilentFailover", "manifest.json"),
      ),
    ).toBe(true);
    expect(fs.readFileSync(path.join(root, "data/existing.txt"), "utf8")).toBe(
      "preserve",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
