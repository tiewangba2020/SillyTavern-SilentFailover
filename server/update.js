import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { VERSION } from "./version.js";

export const REPOSITORY = "tiewangba2020/SillyTavern-SilentFailover";
export const UPDATE_ASSET = "silent-failover-update.json";
export const FILES = [
  "frontend/manifest.json",
  "frontend/style.css",
  "frontend/dist/index.js",
  "server/package.json",
  "server/index.cjs",
];
const digest = (data) => createHash("sha256").update(data).digest("hex");
const validVersion = (v) =>
  typeof v === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v);
export function newer(a, b) {
  if (!validVersion(a) || !validVersion(b)) return false;
  const x = a.split(".").map(Number),
    y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
export function validatePackage(bundle, version) {
  if (
    bundle?.schema !== 1 ||
    !validVersion(version) ||
    bundle.version !== version ||
    !Array.isArray(bundle.files) ||
    bundle.files.length !== FILES.length
  )
    throw new Error("更新包格式或版本不正确");
  const files = new Map();
  for (const file of bundle.files) {
    if (
      !FILES.includes(file.path) ||
      files.has(file.path) ||
      typeof file.content !== "string" ||
      file.content.length > 8 * 1024 * 1024
    )
      throw new Error("更新包文件列表不正确");
    const data = Buffer.from(file.content, "base64");
    if (
      data.toString("base64") !== file.content ||
      digest(data) !== file.sha256
    )
      throw new Error("更新包校验失败");
    files.set(file.path, data);
  }
  const manifest = JSON.parse(files.get("frontend/manifest.json").toString());
  const pkg = JSON.parse(files.get("server/package.json").toString());
  if (
    manifest.version !== version ||
    manifest.homePage !== `https://github.com/${REPOSITORY}` ||
    manifest.js !== "dist/index.js" ||
    manifest.css !== "style.css" ||
    !validVersion(manifest.minimum_client_version) ||
    pkg.version !== version ||
    pkg.main !== "index.cjs" ||
    pkg.name !== "sillytavern-silent-failover-server"
  )
    throw new Error("前后端版本或插件标识不匹配");
  return files;
}
async function readJSON(url, limit) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(45000),
    headers: {
      Accept: "application/json",
      "User-Agent": "SillyTavern-SilentFailover",
    },
  });
  if (!response.ok)
    throw new Error(`GitHub 下载失败（HTTP ${response.status}）`);
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("更新包超过大小限制");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } finally {
    await reader.cancel().catch(() => {});
  }
}
// Do not follow filesystem links into unrelated directories during replacement.
function checked(root, relative) {
  let current = root;
  for (const part of relative.split(/[\\/]/)) {
    if (!part || part === "." || part === "..")
      throw new Error("安装路径不正确");
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw new Error("暂不支持更新符号链接安装，请手动更新");
  }
  return current;
}
export class Updater {
  constructor({
    root = process.cwd(),
    serverDir = typeof __SF_SERVER_DIR__ === "string"
      ? __SF_SERVER_DIR__
      : null,
    busy = () => false,
    download = readJSON,
    replace = fs.renameSync,
    runningVersion = VERSION,
  } = {}) {
    this.version = runningVersion;
    this.root = fs.realpathSync(root);
    this.serverDir = serverDir;
    this.busy = busy;
    this.download = download;
    this.replace = replace;
    this.state = {
      runningVersion: this.version,
      state: "idle",
      restartRequired: false,
    };
  }
  async latest() {
    const release = await this.download(
      `https://api.github.com/repos/${REPOSITORY}/releases/latest`,
      1024 * 1024,
    );
    const version = release.tag_name?.replace(/^v/, "");
    const asset = release.assets?.find((a) => a.name === UPDATE_ASSET);
    const expected = `https://github.com/${REPOSITORY}/releases/download/v${version}/${UPDATE_ASSET}`;
    if (
      !validVersion(version) ||
      release.draft ||
      release.prerelease ||
      asset?.browser_download_url !== expected
    )
      throw new Error("最新正式版尚未提供一键更新包，请使用完整安装包");
    return { version, url: expected };
  }
  async check() {
    const release = await this.latest();
    return {
      ...this.state,
      latestVersion: release.version,
      available: newer(release.version, this.version),
    };
  }
  targets(extensions) {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(this.root, "package.json")),
    );
    if (
      pkg.name !== "sillytavern" ||
      !this.serverDir ||
      !fs.existsSync(path.join(this.root, "server.js"))
    )
      throw new Error("无法识别酒馆安装目录，请手动更新");
    const relative = path.relative(this.root, this.serverDir);
    if (
      !relative.startsWith(`plugins${path.sep}`) ||
      relative.split(path.sep).length !== 2
    )
      throw new Error("服务端安装路径不受支持");
    const server = checked(this.root, relative);
    const installed = JSON.parse(
      fs.readFileSync(path.join(server, "package.json")),
    );
    if (installed.name !== "sillytavern-silent-failover-server")
      throw new Error("服务端插件标识不匹配");
    const frontends = [];
    for (const base of new Set(
      [
        path.join(this.root, "public/scripts/extensions/third-party"),
        extensions,
      ].filter(Boolean),
    )) {
      if (!fs.existsSync(base)) continue;
      const resolved = fs.realpathSync(base);
      if (path.resolve(base) !== resolved)
        throw new Error("前端安装路径包含符号链接，请手动更新");
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const target = checked(base, entry.name);
        try {
          const manifest = JSON.parse(
            fs.readFileSync(checked(target, "manifest.json")),
          );
          if (
            manifest.homePage === `https://github.com/${REPOSITORY}` &&
            manifest.js === "dist/index.js"
          )
            frontends.push(target);
        } catch (e) {
          if (e.message.includes("符号链接")) throw e;
        }
      }
    }
    if (!frontends.length)
      throw new Error("未找到已安装的前端插件，请先手动安装完整包");
    return { server, frontends };
  }
  start(extensions) {
    if (this.state.state === "updating") throw new Error("更新正在进行");
    if (this.state.restartRequired) throw new Error("已安装更新，请先重启酒馆");
    if (this.busy()) throw new Error("存在生成任务，请结束生成后更新");
    this.state = {
      runningVersion: this.version,
      state: "updating",
      restartRequired: false,
      started: Date.now(),
    };
    this.promise = this.install(extensions).catch((error) => {
      this.state = {
        ...this.state,
        state: "failed",
        restartRequired: error.recoveryRequired === true,
        error:
          error.message.startsWith("更新") ||
          error.message.startsWith("GitHub") ||
          error.message.includes("请")
            ? error.message.slice(0, 300)
            : "更新失败，请检查网络、磁盘空间和插件目录写入权限",
      };
    });
    return { ...this.state };
  }
  async install(extensions) {
    const release = await this.latest();
    if (!newer(release.version, this.version)) {
      this.state = {
        ...this.state,
        state: "current",
        latestVersion: release.version,
      };
      return;
    }
    const files = validatePackage(
      await this.download(release.url, 12 * 1024 * 1024),
      release.version,
    );
    const { server, frontends } = this.targets(extensions);
    const required = JSON.parse(
      files.get("frontend/manifest.json").toString(),
    ).minimum_client_version;
    const installedHost = JSON.parse(
      fs.readFileSync(path.join(this.root, "package.json")),
    ).version;
    if (!validVersion(installedHost) || newer(required, installedHost))
      throw new Error(`更新要求酒馆 ${required} 或更新版本，请先升级酒馆`);
    if (this.busy()) throw new Error("存在生成任务，请结束生成后更新");
    const backupRoot = checked(this.root, "backups");
    fs.mkdirSync(backupRoot, { recursive: true });
    const backup = fs.mkdtempSync(
      path.join(backupRoot, "silent-failover-update-"),
    );
    const entries = [];
    for (const [name, data] of files) {
      const [component, ...parts] = name.split("/");
      for (const target of component === "server" ? [server] : frontends) {
        const destination = checked(target, parts.join("/"));
        if (!fs.existsSync(destination))
          throw new Error("安装文件缺失，请使用完整安装包修复");
        const saved = path.join(backup, String(entries.length));
        fs.copyFileSync(destination, saved);
        entries.push({ destination, saved, data });
      }
    }
    fs.writeFileSync(
      path.join(backup, "restore.json"),
      JSON.stringify(
        entries.map(({ destination, saved }) => ({ destination, saved })),
        null,
        2,
      ),
    );
    const changed = [];
    try {
      for (const entry of entries) {
        const temp = checked(
          path.dirname(entry.destination),
          path.basename(entry.destination) + ".sf-update-tmp",
        );
        let created = false;
        try {
          fs.writeFileSync(temp, entry.data, { flag: "wx" });
          created = true;
          this.replace(temp, entry.destination);
          changed.push(entry);
        } finally {
          if (created && fs.existsSync(temp)) fs.unlinkSync(temp);
        }
      }
    } catch (error) {
      let rollbackFailed = false;
      for (const entry of changed.reverse()) {
        try {
          fs.copyFileSync(entry.saved, entry.destination);
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed)
        throw Object.assign(
          new Error(
            "更新失败且恢复不完整，请关闭酒馆并使用 backups 中的 silent-failover-update 备份恢复",
          ),
          { recoveryRequired: true },
        );
      throw new Error("更新写入失败，已恢复旧文件，请检查目录写入权限");
    }
    this.state = {
      ...this.state,
      state: "installed",
      installedVersion: release.version,
      restartRequired: true,
      backup: path.basename(backup),
      ended: Date.now(),
    };
  }
}
