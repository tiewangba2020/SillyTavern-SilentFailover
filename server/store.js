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
export class Store {
  constructor(root) {
    this.root = path.join(root, "silent-failover");
    this.file = path.join(this.root, "config.json");
    this.listeners = new Set();
    this.config = fs.existsSync(this.file)
      ? {
          ...structuredClone(DEFAULTS),
          ...JSON.parse(fs.readFileSync(this.file, "utf8")),
        }
      : structuredClone(DEFAULTS);
    const stored = this.config;
    this.revision = Number.isSafeInteger(stored.revision) ? stored.revision : 0;
    this.presets = stored.presets || [
      { id: randomUUID(), name: "默认预设", config: this.cleanConfig(stored) },
    ];
    this.activePresetId = stored.activePresetId || this.presets[0].id;
    this.config = this.presets.find(
      (p) => p.id === this.activePresetId,
    )?.config;
    if (!this.config) throw new Error("当前预设不存在");
    if (!stored.presets) this.persistConfig();
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
