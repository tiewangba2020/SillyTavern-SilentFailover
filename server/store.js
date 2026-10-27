import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { completeApiUrl } from "./url.js";
export const DEFAULTS = Object.freeze({
  enabled: false,
  nativeFirst: true,
  autoCompleteUrl: true,
  loop: false,
  maxRounds: 0,
  notificationMode: "silent",
  floatingWindow: false,
  waitMode: "patient",
  intervalSeconds: 5,
  timeoutSeconds: 180,
  idleSeconds: 45,
  firstTokenSeconds: 90,
  headerSeconds: 30,
  nodes: [],
});
function number(value, min, max, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new Error(`${label}: ${min}-${max}`);
  return n;
}
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
// 读不动文件（权限、磁盘满）是真问题，交给上层报错；
// 内容坏了（手机被强杀、存储写一半、手工改过）只影响这一份数据，
// 备份原文件后按默认配置继续跑，否则用户会一直卡在「无法读取插件数据」。
const parseConfigText = (text) => {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("内容不是对象");
  return value;
};
const parseConfig = (file) => parseConfigText(fs.readFileSync(file, "utf8"));
// 整份 JSON 解析失败时，里面往往还留着完整的节点对象（截断多半发生在文件末尾）。
// 按括号配对把 "nodes":[...] 里的对象一个个抠出来单独解析，比整份放弃好得多——
// 用户的 API Key 全在节点里。
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
// 主文件写坏时，先看它自己的残留内容，再看历史上备份下来的 .broken-* 文件。
function salvageNodes(file, text) {
  const own = text ? scanNodes(text) : [];
  if (own.length) return { nodes: own, source: "当前文件" };
  let newest = null;
  let newestAt = 0;
  try {
    for (const name of fs.readdirSync(path.dirname(file))) {
      if (!name.startsWith(path.basename(file) + ".broken-")) continue;
      const full = path.join(path.dirname(file), name);
      const at = fs.statSync(full).mtimeMs;
      if (at > newestAt) {
        newestAt = at;
        newest = full;
      }
    }
  } catch {
    return null;
  }
  if (!newest) return null;
  try {
    const nodes = scanNodes(fs.readFileSync(newest, "utf8"));
    if (nodes.length) return { nodes, source: path.basename(newest) };
  } catch {}
  return null;
}
// atomicJson 先写 <config>.json.<uuid>.tmp 再改名；进程被强杀时临时文件是完整的，
// 比坏掉的主文件可靠，优先用它把用户的节点和 Key 捞回来。
function salvageTemporary(file) {
  let newest = null;
  let newestAt = 0;
  try {
    for (const name of fs.readdirSync(path.dirname(file))) {
      if (!name.startsWith(path.basename(file) + ".") || !name.endsWith(".tmp"))
        continue;
      const full = path.join(path.dirname(file), name);
      const at = fs.statSync(full).mtimeMs;
      if (at > newestAt) {
        newestAt = at;
        newest = full;
      }
    }
  } catch {
    return null;
  }
  if (!newest) return null;
  try {
    return { stored: parseConfig(newest), name: path.basename(newest) };
  } catch {
    return null;
  }
}
function readConfig(file) {
  if (!fs.existsSync(file)) {
    const salvaged = salvageTemporary(file);
    return salvaged
      ? {
          stored: salvaged.stored,
          warning: `已从上次写入中断留下的临时文件（${salvaged.name}）恢复设置`,
        }
      : { stored: {}, warning: "" };
  }
  // 读不动（权限、只读挂载）是真问题，往上抛；读到了但解析不了才算文件损坏。
  const text = fs.readFileSync(file, "utf8");
  let problem = "";
  try {
    return { stored: parseConfigText(text), warning: "" };
  } catch (e) {
    problem = e.message;
  }
  const backup = `${file}.broken-${Date.now()}`;
  let moved = true;
  try {
    fs.renameSync(file, backup);
  } catch {
    moved = false;
  }
  const salvaged = salvageTemporary(file);
  if (salvaged)
    return {
      stored: salvaged.stored,
      warning: `配置文件无法解析（${problem}），已${moved ? `备份为 ${path.basename(backup)}` : "跳过备份"}，并从临时文件（${salvaged.name}）恢复了设置`,
    };
  const recovered = salvageNodes(file, text);
  if (recovered)
    return {
      stored: { ...structuredClone(DEFAULTS), nodes: recovered.nodes },
      warning: `配置文件无法解析（${problem}），已${moved ? `备份为 ${path.basename(backup)}` : "跳过备份"}，并从${recovered.source}恢复了 ${recovered.nodes.length} 个节点`,
    };
  return {
    stored: {},
    warning: `配置文件无法解析（${problem}），${moved ? `已备份为 ${path.basename(backup)}` : "且无法备份"}，按默认设置启动`,
  };
}
export class Store {
  constructor(root) {
    this.root = path.join(root, "silent-failover");
    this.file = path.join(this.root, "config.json");
    this.listeners = new Set();
    const { stored, warning } = readConfig(this.file);
    this.warning = warning;
    // 旧版是扁平配置，新版把每个预设的配置嵌在 presets 里，两边都补齐默认值。
    const flat = { ...structuredClone(DEFAULTS), ...stored };
    this.revision = Number.isSafeInteger(stored.revision) ? stored.revision : 0;
    const presets = Array.isArray(stored.presets)
      ? stored.presets
          .filter(
            (p) =>
              p &&
              typeof p.id === "string" &&
              p.config &&
              typeof p.config === "object" &&
              !Array.isArray(p.config),
          )
          .map((p) => ({
            id: p.id,
            name: p.name,
            config: { ...structuredClone(DEFAULTS), ...p.config },
          }))
      : [];
    this.presets = presets.length
      ? presets
      : [
          {
            id: randomUUID(),
            name: "默认预设",
            config: this.cleanConfig(flat),
          },
        ];
    this.activePresetId =
      this.presets.find((p) => p.id === stored.activePresetId)?.id ||
      this.presets[0].id;
    this.config = this.presets.find((p) => p.id === this.activePresetId).config;
    // 旧版没有预设列表、预设全部失效、指针指丢时把修好的结构写回去。
    if (
      !presets.length ||
      this.activePresetId !== stored.activePresetId ||
      !Array.isArray(stored.presets)
    )
      this.persistQuietly();
  }
  // 构造阶段不能因为写不进去就整体不可用：设置项保存时会再报一次真正的错误。
  persistQuietly() {
    try {
      this.persistConfig();
    } catch (e) {
      this.warning = `${this.warning ? this.warning + "；" : ""}配置无法写入磁盘（${e.message}），本次修改可能不会被保存`;
    }
  }
  cleanConfig(config) {
    return Object.fromEntries(
      Object.entries(config).filter(([k]) => Object.hasOwn(DEFAULTS, k)),
    );
  }
  persistConfig() {
    atomicJson(this.file, {
      ...this.config,
      schema: 3,
      revision: this.revision,
      activePresetId: this.activePresetId,
      presets: this.presets,
    });
  }
  presetName() {
    return this.presets.find((p) => p.id === this.activePresetId).name;
  }
  assertCurrent(input) {
    if (
      (input.activePresetId && input.activePresetId !== this.activePresetId) ||
      (input.revision !== undefined && input.revision !== this.revision)
    )
      throw new Error(
        "配置已在其他页面更改，请刷新配置后重试；当前修改尚未保存",
      );
  }
  publicConfig() {
    return {
      ...this.config,
      activePresetId: this.activePresetId,
      presetName: this.presetName(),
      presets: this.presets.map(({ id, name }) => ({ id, name })),
      revision: this.revision,
      warning: this.warning || "",
      nodes: this.config.nodes.map(({ key, maxTokens, ...n }) => ({
        ...n,
        keySet: Boolean(key),
        keyHint: key ? "********" + (key.length >= 8 ? key.slice(-3) : "") : "",
      })),
    };
  }
  keys() {
    return this.presets
      .flatMap((p) => p.config.nodes.map((n) => n.key))
      .filter(Boolean);
  }
  previewNode(input, requireModel = true, settings = {}) {
    if (!input || typeof input !== "object") throw new Error("节点无效");
    return this.validate({
      ...this.publicConfig(),
      autoCompleteUrl: settings.autoCompleteUrl ?? this.config.autoCompleteUrl,
      nodes: [
        {
          ...input,
          name: input.name || "测试节点",
          model: requireModel ? input.model : "model-list",
        },
      ],
    }).nodes[0];
  }
  validate(input) {
    if (!input || !Array.isArray(input.nodes) || input.nodes.length > 100)
      throw new Error("节点列表无效（最多 100 个）");
    const old = new Map(this.config.nodes.map((n) => [n.id, n]));
    const ids = new Set();
    const nodes = input.nodes.map((n, index) => {
      const id = n.id || randomUUID();
      if (typeof id !== "string" || id.length > 100 || ids.has(id))
        throw new Error("节点 ID 重复或无效");
      ids.add(id);
      const name = String(n.name || "").trim();
      const model = String(n.model || "").trim();
      const protocol = n.protocol || "openai";
      if (!["openai", "claude", "gemini"].includes(protocol))
        throw new Error("不支持的 API 协议");
      if (!name || name.length > 100 || !model || model.length > 200)
        throw new Error("节点名称和模型不能为空或过长");
      let url;
      try {
        url = new URL(n.url);
      } catch {
        throw new Error("API 地址无效");
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("API 地址只支持不带凭据和查询参数的 HTTP/HTTPS URL");
      if (url.hostname === "sillytavern-failover.invalid")
        throw new Error("不能将故障转移连接作为上游");
      const key = n.clearKey
        ? ""
        : typeof n.key === "string" && n.key.length
          ? n.key
          : old.get(id)?.key || "";
      if (key.length > 8192) throw new Error("API Key 过长");
      return {
        id,
        name,
        model,
        protocol,
        url: completeApiUrl(
          url.href,
          protocol,
          input.autoCompleteUrl !== false,
        ),
        key,
        enabled: n.enabled !== false,
        priority: number(n.priority ?? index + 1, 0, 99999, "优先级"),
        stream: n.stream !== false,
      };
    });
    const config = {
      enabled: input.enabled === true,
      nativeFirst: input.nativeFirst !== false,
      autoCompleteUrl: input.autoCompleteUrl !== false,
      loop: input.loop === true,
      maxRounds: number(input.maxRounds ?? 0, 0, 10000, "总轮次上限"),
      notificationMode: input.notificationMode ?? "silent",
      floatingWindow: input.floatingWindow === true,
      waitMode: input.waitMode ?? "patient",
      intervalSeconds: number(input.intervalSeconds ?? 5, 1, 3600, "轮次间隔"),
      timeoutSeconds: number(input.timeoutSeconds ?? 180, 0, 86400, "总超时"),
      idleSeconds: number(input.idleSeconds ?? 45, 0, 86400, "数据间隔超时"),
      firstTokenSeconds: number(
        input.firstTokenSeconds ?? 90,
        0,
        86400,
        "首数据超时",
      ),
      headerSeconds: number(input.headerSeconds ?? 30, 0, 86400, "响应头超时"),
      nodes,
    };
    if (!Number.isInteger(config.maxRounds))
      throw new Error("总轮次上限必须为整数");
    if (!["silent", "failure", "progress"].includes(config.notificationMode))
      throw new Error("提示方式无效");
    if (!["patient", "limited"].includes(config.waitMode))
      throw new Error("等待策略无效");
    return config;
  }
  save(input) {
    this.assertCurrent(input);
    const config = this.validate(input);
    const presets = this.presets.map((p) =>
      p.id === this.activePresetId ? { ...p, config } : p,
    );
    atomicJson(this.file, {
      ...config,
      schema: 3,
      activePresetId: this.activePresetId,
      revision: this.revision + 1,
      presets,
    });
    this.presets = presets;
    this.revision++;
    this.config = config;
    for (const fn of this.listeners) fn();
    return this.publicConfig();
  }
  changePreset(input) {
    this.assertCurrent(input);
    const { action, id } = input;
    let presets = structuredClone(this.presets),
      active = this.activePresetId;
    const current = presets.find((p) => p.id === active);
    if (["create", "copy", "rename"].includes(action)) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (
        !name ||
        name.length > 60 ||
        presets.some(
          (p) => p.name === name && (action !== "rename" || p.id !== active),
        )
      )
        throw new Error("预设名称不能为空、重复或超过 60 个字符");
      if (action === "rename") current.name = name;
      else {
        if (presets.length >= 30) throw new Error("最多保存 30 个预设");
        active = randomUUID();
        presets.push({
          id: active,
          name,
          config:
            action === "copy"
              ? structuredClone(current.config)
              : structuredClone(DEFAULTS),
        });
      }
    } else if (action === "activate") {
      if (!presets.some((p) => p.id === id)) throw new Error("预设不存在");
      active = id;
    } else if (action === "delete") {
      if (presets.length === 1) throw new Error("至少保留一个预设");
      presets = presets.filter((p) => p.id !== active);
      active = presets[0].id;
    } else throw new Error("预设操作无效");
    const config = presets.find((p) => p.id === active).config;
    atomicJson(this.file, {
      ...config,
      schema: 3,
      activePresetId: active,
      revision: this.revision + 1,
      presets,
    });
    this.presets = presets;
    this.activePresetId = active;
    this.config = config;
    this.revision++;
    for (const fn of this.listeners) fn();
    return this.publicConfig();
  }
  loadLogs() {
    const f = path.join(this.root, "records.json");
    if (!fs.existsSync(f)) return [];
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      return [];
    }
  }
  saveLogs(records) {
    const cutoff = Date.now() - 7 * 86400000;
    const kept = [];
    let size = 2;
    for (const record of records
      .filter((x) => x.started >= cutoff)
      .slice(-1000)
      .reverse()) {
      const bytes = Buffer.byteLength(JSON.stringify(record)) + 1;
      if (size + bytes > 16 * 1024 * 1024) break;
      kept.unshift(record);
      size += bytes;
    }
    atomicJson(path.join(this.root, "records.json"), kept);
    return kept;
  }
}
