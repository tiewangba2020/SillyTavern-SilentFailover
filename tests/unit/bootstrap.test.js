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

// PowerShell 的 Compress-Archive 会把条目写成反斜杠分隔，POSIX 的 unzip 会把
// 反斜杠当成文件名字符，于是解出来的路径全错、install.sh 报 checksum/路径异常。
// 这里直接写一份最小 ZIP（store，不压缩），条目名统一用正斜杠。
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();
const crc32 = (buffer) => {
  let c = -1;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function zipDirectory(root) {
  const files = [];
  const walk = (dir, prefix) => {
    const names = fs
      .readdirSync(dir, { withFileTypes: true })
      .map((e) => e.name)
      .sort();
    for (const name of names) {
      const full = path.join(dir, name);
      const entry = prefix ? `${prefix}/${name}` : name;
      if (fs.statSync(full).isDirectory()) walk(full, entry);
      else files.push([entry, fs.readFileSync(full)]);
    }
  };
  walk(root, "");
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 条目名按 UTF-8 解释
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

test.skipIf(process.platform === "win32" && !fs.existsSync(bash))(
  "portable bootstrap installs a checked release and rejects a corrupt checksum before changing files",
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-bootstrap-"));
    let server;
    try {
      const zip = path.join(dir, "release.zip");
      if (process.platform === "win32")
        fs.writeFileSync(zip, zipDirectory(path.resolve("release")));
      else await exec("zip", ["-qr", zip, "."], { cwd: "release" });
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
