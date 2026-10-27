#!/usr/bin/env node
/**
 * API还没挂 · 一键修复 / 安装
 *
 * 用法（在酒馆所在的终端里执行，手机 Termux 同样可用）：
 *   node repair.mjs                     自动查找酒馆目录
 *   node repair.mjs --target ~/SillyTavern
 *   node repair.mjs --restore <config.json.broken-xxx>
 *                                       只从备份里把节点/Key 还原回当前配置
 *
 * 它会做三件事：
 *   1. 找到酒馆目录，确认版本够新；
 *   2. 从 GitHub 拉最新的「API还没挂」前后端文件，覆盖安装（旧文件先备份）；
 *   3. 检查插件的数据文件，坏的备份、能从临时文件或残留内容里救回来的自动救回来。
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

// 整份 JSON 解析不了时，里面往往还留着完整的节点对象（截断多半发生在末尾）。
// 按括号配对把 "nodes":[...] 里的对象一个个抠出来单独解析，用户的 Key 全在这里面。
function scanNodes(text) {
  const nodes = [];
  const seen = new Set();
  let from = 0;
  while (nodes.length < 100) {
    const at = text.indexOf('"nodes"', from);
    if (at < 0) break;
    const open = text.indexOf("[", at + 7);
    if (open < 0) break;
    from = open + 1;
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = open + 1; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth++;
        continue;
      }
      if (ch === "}") {
        depth--;
        if (depth === 0 && start >= 0) {
          let node = null;
          try {
            node = JSON.parse(text.slice(start, i + 1));
          } catch {}
          const id = node && (node.id || node.url);
          if (
            node &&
            typeof node.url === "string" &&
            typeof node.name === "string" &&
            id &&
            !seen.has(id)
          ) {
            seen.add(id);
            nodes.push(node);
          }
          start = -1;
        }
        if (depth < 0) break;
        continue;
      }
      if (ch === "]" && depth === 0) break;
    }
  }
  return nodes;
}

// 数据文件坏了就地处理：能救的从临时文件或残留内容里救回来，救不了的改名备份，
// 让插件下次启动时按默认配置重建——这样节点和 Key 始终有据可查。
function repairDataFile(file) {
  if (!fs.existsSync(file)) return { state: "missing" };
  const text = fs.readFileSync(file, "utf8");
  let problem = "";
  try {
    return { state: "ok", nodes: countNodes(JSON.parse(text)) };
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
  let moved = true;
  try {
    fs.renameSync(file, backup);
  } catch {
    moved = false;
  }
  const nodes = scanNodes(text);
  if (nodes.length) {
    writeAtomic(file, JSON.stringify({ schema: 3, nodes }));
    return {
      state: "recovered",
      nodes: nodes.length,
      backup: moved ? path.basename(backup) : "",
    };
  }
  if (moved) return { state: "reset", problem, backup: path.basename(backup) };
  return { state: "stuck", problem, error: "无法备份" };
}

// --restore：已经重启过、面板变空了，从备份文件里把节点捡回当前配置。
function restoreFrom(file) {
  if (!fs.existsSync(file)) die(`找不到文件：${file}`);
  const nodes = scanNodes(fs.readFileSync(file, "utf8"));
  if (!nodes.length)
    die(
      "这个文件里没找到完整的节点，可能是截断得太厉害。\n把它发给作者，可以人工从残留内容里捞。",
    );
  const target = /\.broken-/.test(file)
    ? file.replace(/\.broken-.*$/, "")
    : path.join(path.dirname(file), "config.json");
  let current = {};
  if (fs.existsSync(target)) {
    try {
      current = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch {
      current = {};
    }
  }
  const seen = new Set();
  const existing = [];
  const collect = (list) => {
    for (const node of Array.isArray(list) ? list : []) {
      const id = node?.id || node?.url;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      existing.push(node);
    }
  };
  collect(current.nodes);
  for (const preset of Array.isArray(current.presets) ? current.presets : [])
    collect(preset?.config?.nodes);
  const before = existing.length;
  for (const node of nodes) {
    const id = node.id || node.url;
    if (seen.has(id)) continue;
    seen.add(id);
    existing.push(node);
  }
  current.nodes = existing;
  writeAtomic(target, JSON.stringify(current));
  ok(`从 ${path.basename(file)} 找到 ${nodes.length} 个节点`);
  ok(`已写入 ${path.relative(process.cwd(), target) || target}（原有 ${before} 个，现共 ${existing.length} 个）`);
  say("\n下一步：重启酒馆，面板里应该能看到这些节点了。");
  if (before) warn("原有节点不会被覆盖，只补充备份里多出来的那些。");
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

  const restore = arg("--restore");
  if (restore) {
    step("从备份还原节点");
    restoreFrom(path.resolve(restore));
    return;
  }

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
  let reset = "";
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
      else if (result.state === "recovered")
        ok(
          `${label}：损坏，已从残留内容里恢复 ${result.nodes} 个节点` +
            (result.backup ? `（原文件备份为 ${result.backup}）` : ""),
        );
      else if (result.state === "reset") {
        reset = path.join(path.dirname(file), result.backup);
        warn(
          `${label}：损坏，已备份为 ${result.backup}，重启后按默认设置重建\n` +
            "     备份里没有完整的节点对象；如果确实丢过节点，把这份备份发给我，可以人工捞",
        );
      }
      else if (result.state === "stuck")
        warn(`${label}：损坏且无法备份（${result.error}），请检查文件权限`);
    }
  }
  if (!touched) ok("没有已保存的插件配置（首次安装时属于正常）");

  say("\n完成。");
  say("  版本：" + bundle.version);
  if (fs.existsSync(backup)) say("  备份：" + backup);
  if (reset)
    say(
      "\n  备份里没有完整的节点，面板可能是空的。等以后拿到节点备份时，用这条命令还原：\n" +
        "    node repair.mjs --restore " + reset,
    );
  say("\n下一步：重启酒馆");
  say("  1. 在运行酒馆的那个窗口按 Ctrl+C 停掉；");
  say("  2. 重新执行你平时启动酒馆的命令（常见：./start.sh 或 node server.js）；");
  say("  3. 手机浏览器刷新酒馆页面，打开「扩展程序 → API还没挂」，确认前后端都是 " + bundle.version + "。");
}

main().catch((e) => die(e?.stack || String(e)));
