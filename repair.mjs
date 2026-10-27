#!/usr/bin/env node
/**
 * API还没挂 · 一键修复 / 安装
 *
 * 用法（在酒馆所在的终端里执行，手机 Termux 同样可用）：
 *   node repair.mjs                     自动查找酒馆目录
 *   node repair.mjs --target ~/SillyTavern
 *
 * 它会做三件事：
 *   1. 找到酒馆目录，确认版本够新；
 *   2. 从 GitHub 拉最新的「API还没挂」前后端文件，覆盖安装（旧文件先备份）；
 *   3. 检查插件的数据文件，坏的备份、能从临时文件救回来的自动救回来。
 *
 * 不联网时不改动任何文件；任何一步失败都会明确告诉你卡在哪。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = "tiewangba2020/SillyTavern-SilentFailover";
const BUNDLE_URL = `https://github.com/${REPO}/releases/latest/download/silent-failover-update.json`;
const FRONT = path.join(
  "public",
  "scripts",
  "extensions",
  "third-party",
  "SillyTavern-SilentFailover",
);
const SERVER = path.join("plugins", "SillyTavern-SilentFailover-Server");
const EXPECTED = [
  "frontend/manifest.json",
  "frontend/style.css",
  "frontend/dist/index.js",
  "server/package.json",
  "server/index.cjs",
];
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const say = (text = "") => console.log(text);
const step = (text) => say("\n▶ " + text);
const ok = (text) => say("  ✔ " + text);
const warn = (text) => say("  ! " + text);

function die(text) {
  say("\n✘ " + text);
  say("\n没有改动任何东西。把上面的内容截图发给我，我看看卡在哪。");
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function isTavern(dir) {
  try {
    if (!fs.existsSync(path.join(dir, "server.js"))) return false;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return pkg.name === "sillytavern";
  } catch {
    return false;
  }
}

function findTaverns() {
  const home = os.homedir();
  const seeds = [
    process.cwd(),
    path.join(home, "SillyTavern"),
    path.join(home, "sillytavern"),
    path.join(home, "SillyTavern-release"),
    path.join(home, "SillyTavern-master"),
    path.join(home, "st"),
    path.join(home, "ST"),
    "/storage/emulated/0/SillyTavern",
    "/sdcard/SillyTavern",
  ];
  try {
    for (const entry of fs.readdirSync(home, { withFileTypes: true }))
      if (entry.isDirectory()) seeds.push(path.join(home, entry.name));
  } catch {}
  const found = [];
  for (const seed of seeds) {
    let real;
    try {
      real = fs.realpathSync(seed);
    } catch {
      continue;
    }
    if (isTavern(real) && !found.includes(real)) found.push(real);
  }
  return found;
}

function pickTavern() {
  const given = arg("--target");
  if (given) {
    const real = (() => {
      try {
        return fs.realpathSync(path.resolve(given));
      } catch {
        die(`找不到目录：${given}`);
      }
    })();
    if (!isTavern(real))
      die(`${given} 不是酒馆目录（里面应该有 server.js 和 package.json）。`);
    return real;
  }
  const all = findTaverns();
  if (all.length === 1) return all[0];
  if (!all.length)
    die(
      "没找到酒馆目录。请在酒馆目录里运行，或指定路径：\n  node repair.mjs --target ~/SillyTavern",
    );
  const installed = all.filter((dir) => fs.existsSync(path.join(dir, FRONT)));
  if (installed.length === 1) return installed[0];
  die(
    "找到多个酒馆目录，请指定一个：\n" +
      all.map((dir) => "  node repair.mjs --target " + dir).join("\n"),
  );
}

function readVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  } catch {
    return "";
  }
}

async function download(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(120000),
    headers: { "User-Agent": "silent-failover-repair" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.repair-${process.pid}.tmp`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, file);
}

function copyTree(source, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function countNodes(config) {
  if (!config || typeof config !== "object") return 0;
  if (Array.isArray(config.nodes)) return config.nodes.length;
  if (Array.isArray(config.presets))
    return config.presets.reduce(
      (sum, preset) => sum + (Array.isArray(preset?.config?.nodes) ? preset.config.nodes.length : 0),
      0,
    );
  return 0;
}

function newestTemporary(file) {
  let newest = null;
  let newestAt = 0;
  try {
    for (const name of fs.readdirSync(path.dirname(file))) {
      if (!name.startsWith(path.basename(file) + ".") || !name.endsWith(".tmp")) continue;
      const full = path.join(path.dirname(file), name);
      const at = fs.statSync(full).mtimeMs;
      if (at > newestAt) {
        newestAt = at;
        newest = full;
      }
    }
  } catch {}
  return newest;
}

// 数据文件坏了就地处理：能救的从临时文件救回来，救不了的改名备份，
// 让插件下次启动时按默认配置重建——这样节点和 Key 始终有据可查。
function repairDataFile(file) {
  if (!fs.existsSync(file)) return { state: "missing" };
  let problem = "";
  try {
    return { state: "ok", nodes: countNodes(JSON.parse(fs.readFileSync(file, "utf8"))) };
  } catch (e) {
    problem = e.message;
  }
  const temporary = newestTemporary(file);
  if (temporary) {
    try {
      const value = JSON.parse(fs.readFileSync(temporary, "utf8"));
      fs.renameSync(file, `${file}.broken-${stamp()}`);
      writeAtomic(file, JSON.stringify(value));
      return {
        state: "salvaged",
        nodes: countNodes(value),
        from: path.basename(temporary),
      };
    } catch {}
  }
  const backup = `${file}.broken-${stamp()}`;
  try {
    fs.renameSync(file, backup);
    return { state: "reset", problem, backup: path.basename(backup) };
  } catch (e) {
    return { state: "stuck", problem, error: e.message };
  }
}

function dataRoots(root) {
  const roots = new Set();
  const candidates = [
    path.join(root, "config", "config.yaml"),
    path.join(root, "config.yaml"),
    path.join(root, "default", "config.yaml"),
  ];
  let configured = null;
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const match = text.match(/^dataRoot:\s*(.+)$/m);
    if (match) configured = match[1].trim().replace(/^["']|["']$/g, "");
    break;
  }
  if (configured) roots.add(path.resolve(root, configured));
  roots.add(path.join(root, "data"));
  return [...roots].filter((dir) => fs.existsSync(dir));
}

function ensureServerPlugins(root) {
  for (const file of [
    path.join(root, "config", "config.yaml"),
    path.join(root, "config.yaml"),
    path.join(root, "default", "config.yaml"),
  ]) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (!/^enableServerPlugins:\s*true\s*$/m.test(text)) {
      if (/^enableServerPlugins:\s*false\s*$/m.test(text)) {
        fs.copyFileSync(file, `${file}.bak-${stamp()}`);
        fs.writeFileSync(
          file,
          text.replace(/^enableServerPlugins:\s*false\s*$/m, "enableServerPlugins: true"),
        );
        warn(`已打开服务端插件开关（原文件备份为 ${path.basename(file)}.bak-*）`);
      } else {
        warn("配置文件里没找到 enableServerPlugins，请确认酒馆允许加载服务端插件");
      }
    }
    return;
  }
}

async function main() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) die(`Node 版本太旧（${process.versions.node}），请先升级到 20 或更新版本。`);

  step("查找酒馆目录");
  const root = pickTavern();
  ok(root);
  const stVersion = readVersion(root);
  if (stVersion) ok(`酒馆版本 ${stVersion}`);

  step("下载最新版本");
  let bundle;
  const local = arg("--bundle");
  if (local) {
    try {
      bundle = JSON.parse(fs.readFileSync(local, "utf8"));
    } catch (e) {
      die(`读取本地更新包失败：${local}（${e.message}）`);
    }
  } else {
    try {
      bundle = await download(BUNDLE_URL);
    } catch (e) {
      die(`下载失败（${e.message}）。请检查网络后重试；连不上 GitHub 时换 Wi-Fi 或流量再试。`);
    }
  }
  if (bundle?.schema !== 1 || !Array.isArray(bundle?.files) || !bundle?.version)
    die("下载到的更新包格式不对，可能被网络劫持或代理改写，请稍后重试。");
  const missing = EXPECTED.filter((name) => !bundle.files.some((f) => f.path === name));
  if (missing.length) die(`更新包缺少文件：${missing.join("、")}`);
  ok(`版本 ${bundle.version}（${bundle.files.length} 个文件）`);

  step("备份并安装");
  const backup = path.join(root, "backups", "silent-failover-repair-" + stamp());
  for (const [name, dir] of [
    ["frontend", path.join(root, FRONT)],
    ["server", path.join(root, SERVER)],
  ]) {
    if (!fs.existsSync(dir)) continue;
    copyTree(dir, path.join(backup, name));
    ok(`已备份 ${name === "frontend" ? "前端" : "服务端"}旧文件`);
  }
  for (const file of bundle.files) {
    const [component, ...rest] = file.path.split("/");
    const base = component === "frontend" ? path.join(root, FRONT) : path.join(root, SERVER);
    const dest = path.join(base, ...rest);
    writeAtomic(dest, Buffer.from(file.content, "base64"));
  }
  ok("前后端文件已写入");
  ensureServerPlugins(root);

  step("检查插件数据");
  let touched = false;
  const roots = dataRoots(root);
  if (!roots.length) warn("没找到 data 目录，跳过（首次安装时属于正常）");
  for (const dir of roots) {
    for (const user of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!user.isDirectory()) continue;
      const file = path.join(dir, user.name, "silent-failover", "config.json");
      if (!fs.existsSync(file)) continue;
      touched = true;
      const result = repairDataFile(file);
      const label = path.relative(root, file);
      if (result.state === "ok") ok(`${label}：正常，${result.nodes} 个节点`);
      else if (result.state === "salvaged")
        ok(`${label}：损坏，已从临时文件恢复，${result.nodes} 个节点`);
      else if (result.state === "reset")
        warn(
          `${label}：损坏，已备份为 ${result.backup}，重启后按默认设置重建\n` +
            "     原来的节点和 Key 都在这份备份里，重启后面板如果是空的，把它发给我就能捞回来",
        );
      else if (result.state === "stuck")
        warn(`${label}：损坏且无法备份（${result.error}），请检查文件权限`);
    }
  }
  if (!touched) ok("没有已保存的插件配置（首次安装时属于正常）");

  say("\n完成。");
  say("  版本：" + bundle.version);
  if (fs.existsSync(backup)) say("  备份：" + backup);
  say("\n下一步：重启酒馆");
  say("  1. 在运行酒馆的那个窗口按 Ctrl+C 停掉；");
  say("  2. 重新执行你平时启动酒馆的命令（常见：./start.sh 或 node server.js）；");
  say("  3. 手机浏览器刷新酒馆页面，打开「扩展程序 → API还没挂」，确认前后端都是 " + bundle.version + "。");
}

main().catch((e) => die(e?.stack || String(e)));
