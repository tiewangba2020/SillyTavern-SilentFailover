import { test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const bash =
  process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";

test.skipIf(process.platform === "win32" && !fs.existsSync(bash))(
  "portable bootstrap installs a checked release and rejects a corrupt checksum before changing files",
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-bootstrap-"));
    let server;
    try {
      const zip = path.join(dir, "release.zip");
      if (process.platform === "win32") {
        const quote = (s) => "'" + s.replace(/'/g, "''") + "'";
        await exec("powershell.exe", [
          "-NoProfile",
          "-Command",
          `Compress-Archive -Path ${quote(path.resolve("release/*"))} -DestinationPath ${quote(zip)}`,
        ]);
      } else await exec("zip", ["-qr", zip, "."], { cwd: "release" });
      const data = fs.readFileSync(zip),
        hash = createHash("sha256").update(data).digest("hex");
      let corrupt = false;
      const calls = [];
      server = http.createServer((req, res) => {
        calls.push(req.url);
        if (req.url.endsWith(".json"))
          res.end(JSON.stringify({ version: "99.0.0" }));
        else if (req.url.endsWith(".zip")) res.end(data);
        else if (req.url.endsWith("SHA256SUMS-99.0.0"))
          res.end(
            `${corrupt ? "0".repeat(64) : hash}  SillyTavern-SilentFailover-v99.0.0.zip\n`,
          );
        else {
          res.statusCode = 404;
          res.end();
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const root = path.join(dir, "SillyTavern with spaces");
      fs.mkdirSync(root);
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "sillytavern", version: "1.18.0" }),
      );
      fs.writeFileSync(path.join(root, "server.js"), "");
      fs.writeFileSync(
        path.join(root, "config.yaml"),
        "enableServerPlugins: false\nport: 8000\n",
      );
      const run = () =>
        exec(bash, ["tools/install.sh", "--target", root.replace(/\\/g, "/")], {
          env: {
            ...process.env,
            SF_RELEASE_BASE: `http://127.0.0.1:${server.address().port}/releases`,
          },
          timeout: 25000,
        });
      corrupt = true;
      await expect(run()).rejects.toThrow("checksum mismatch");
      expect(fs.existsSync(path.join(root, "plugins"))).toBe(false);
      expect(fs.readFileSync(path.join(root, "config.yaml"), "utf8")).toContain(
        "false",
      );
      corrupt = false;
      const done = await run();
      expect(done.stdout).toContain("Installation complete");
      expect(
        fs.existsSync(
          path.join(
            root,
            "plugins/SillyTavern-SilentFailover-Server/index.cjs",
          ),
        ),
      ).toBe(true);
      expect(fs.readFileSync(path.join(root, "config.yaml"), "utf8")).toContain(
        "enableServerPlugins: true",
      );
      expect(calls).toContain("/releases/download/v99.0.0/SHA256SUMS-99.0.0");
    } finally {
      server?.closeAllConnections();
      if (server) await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  60000,
);
