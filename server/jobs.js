import { attempt, normalizeRequest } from "./upstream.js";
import { abortError, failureRecord, sleep, CANCEL_REASONS } from "./errors.js";
import { adaptParameters } from "./parameters.js";
import { completionSummary, generationType } from "./diagnostics.js";
import { VERSION } from "./version.js";
import { completeApiUrl } from "./url.js";
import { Failure } from "./errors.js";
const terminal = new Set(["succeeded", "exhausted", "cancelled", "invalid"]);
export class Jobs {
  constructor(store, options = {}) {
    this.store = store;
    this.attempt =
      options.attempt || ((n, p, s, c, d) => attempt(n, p, s, c, null, d));
    this.waitMs = options.waitMs;
    this.leaseMs = options.leaseMs || 60000;
    this.jobs = new Map();
    this.records = store.loadLogs().map((j) =>
      terminal.has(j.state)
        ? j
        : {
            ...j,
            state: "cancelled",
            ended: Date.now(),
            reason: "服务已重启，旧任务未恢复",
          },
    );
    this.onConfig = () => this.configChanged();
    store.listeners.add(this.onConfig);
    this.sweep = setInterval(() => this.expire(), Math.min(this.leaseMs, 5000));
    this.sweep.unref?.();
  }
  create(
    id,
    input,
    {
      testNode,
      previewNode = null,
      nativeNode = null,
      generation,
      testSettings,
      preferredNodeId,
    } = {},
  ) {
    if (typeof id !== "string" || !id.length || id.length > 120)
      throw new Error("任务 ID 无效");
    if (this.jobs.has(id)) return this.get(id, true);
    if (this.records.some((x) => x.id === id))
      throw new Error("任务已结束，不能重复执行");
    if (
      [...this.jobs.values()].filter((j) => !terminal.has(j.state)).length >= 4
    )
      throw new Error("同时运行的任务过多");
    // These settings belong to the host connection, not to independently configured backups.
    const customFields = [
      "custom_include_body",
      "custom_exclude_body",
      "custom_include_headers",
    ];
    const hasCustomParameters = customFields.some((name) =>
      typeof input?.[name] === "string"
        ? input[name].trim()
        : input?.[name] != null,
    );
    if (hasCustomParameters && nativeNode)
      nativeNode = {
        ...nativeNode,
        unavailableReason:
          nativeNode.unavailableReason ||
          "原生连接包含暂不支持的自定义请求体或请求头，已跳过原生节点并尝试备用节点",
      };
    const job = {
      id,
      logVersion: 2,
      pluginVersion: VERSION,
      generation: generationType(generation),
      clientEvents: [],
      state: "running",
      round: 0,
      started: Date.now(),
      lease: Date.now(),
      attemptCount: 0,
      dropped: 0,
      attempts: [],
      controller: new AbortController(),
      payload: null,
      testNode,
      previewNode,
      testSettings,
      preferredNodeId,
      manualSwitches: [],
      nativeNode,
      mode: testNode ? "node_test" : nativeNode ? "native_first" : "fallback",
      ...(hasCustomParameters
        ? {
            connectionNote:
              "酒馆自定义请求体、排除参数和请求头仅属于原生连接，未传给备用节点",
          }
        : {}),
    };
    this.jobs.set(id, job);
    try {
      const sharedInput = { ...input };
      for (const name of customFields) delete sharedInput[name];
      job.payload = normalizeRequest(sharedInput);
    } catch (e) {
      job.state = "invalid";
      job.reason = e.message;
      this.finish(job);
      return this.get(id);
    }
    this.run(job).catch((e) => {
      job.state = "invalid";
      job.reason = failureRecord(e, [
        ...this.store.keys(),
        job.nativeNode?.key,
      ]).message;
      this.finish(job);
    });
    return this.get(id);
  }
  async run(job) {
    const signal = job.controller.signal;
    const retryTimes = new Map();
    try {
      while (!signal.aborted) {
        const config = structuredClone(this.store.config);
        job.maxRounds = config.loop ? config.maxRounds || 0 : 1;
        if (job.maxRounds && job.round >= job.maxRounds) {
          job.state = "exhausted";
          job.reason = "已达到总轮次上限";
          break;
        }
        if (!config.enabled && !job.testNode) {
          job.state = "cancelled";
          job.reason = "插件已停用";
          break;
        }
        const nodes = (job.previewNode ? [job.previewNode] : config.nodes)
          .filter((n) => (job.testNode ? n.id === job.testNode : n.enabled))
          .filter(
            (n) =>
              !job.nativeNode ||
              job.nativeNode.unavailableReason ||
              n.url !== job.nativeNode.url ||
              n.model !== job.nativeNode.model ||
              n.key !== job.nativeNode.key ||
              n.stream !== job.nativeNode.stream ||
              (n.protocol || "openai") !== job.nativeNode.protocol,
          )
          .sort((a, b) => a.priority - b.priority);
        if (job.nativeNode && !job.testNode) nodes.unshift(job.nativeNode);
        if (job.round === 0 && job.preferredNodeId && !job.testNode) {
          let index = nodes.findIndex((n) => n.id === job.preferredNodeId);
          // An enabled saved node may have been deduplicated against the native connection.
          if (
            index < 0 &&
            job.nativeNode &&
            config.nodes.some((n) => n.enabled && n.id === job.preferredNodeId)
          )
            index = nodes.indexOf(job.nativeNode);
          if (index < 0) {
            job.state = "invalid";
            job.reason = "下次优先 API 已停用或不存在，请重新选择";
            break;
          }
          nodes.unshift(...nodes.splice(index, 1));
        }
        job.availableNodes = nodes.map(({ id, name, model, stream }) => ({
          id,
          name,
          model,
          stream,
        }));
        if (!nodes.length) {
          job.state = "invalid";
          job.reason = "没有可用的启用节点";
          break;
        }
        job.round++;
        job.state = "running";
        for (let index = 0; index < nodes.length; index++) {
          if (job.pendingSwitch) {
            const target = nodes.findIndex((n) => n.id === job.pendingSwitch);
            delete job.pendingSwitch;
            if (target >= 0) index = target;
          }
          const node = nodes[index];
          if (signal.aborted) throw signal.reason;
          job.attemptController = new AbortController();
          const attemptSignal = AbortSignal.any([
            signal,
            job.attemptController.signal,
          ]);
          const retry = retryTimes.get(node.id) || 0;
          if (retry > Date.now()) {
            job.nextAttemptAt = retry;
            try {
              await sleep(retry - Date.now(), attemptSignal);
            } catch (e) {
              if (signal.aborted) throw e;
              if (job.pendingSwitch) {
                index--;
                continue;
              }
              throw e;
            }
            delete job.nextAttemptAt;
          }
          const settings =
            job.testSettings || structuredClone(this.store.config);
          const adapted = adaptParameters(node, job.payload);
          const entry = {
            nodeId: node.id,
            node: node.name,
            model: node.model,
            round: job.round,
            started: Date.now(),
            state: "running",
            adjustments: adapted.adjustments,
            diagnostics: {
              protocol: node.protocol || "openai",
              stream: node.stream !== false,
              waitMode: settings.waitMode,
              timeouts: Object.fromEntries(
                [
                  "timeoutSeconds",
                  "headerSeconds",
                  "firstTokenSeconds",
                  "idleSeconds",
                ].map((k) => [
                  k,
                  settings.waitMode === "patient" ? 0 : settings[k],
                ]),
              ),
            },
          };
          job.attempts.push(entry);
          job.attemptCount++;
          if (job.attempts.length > 1000) {
            job.attempts.shift();
            job.dropped++;
          }
          try {
            if (node.unavailableReason)
              throw new Failure(node.unavailableReason, {
                category: "configuration",
                phase: "configuration",
              });
            const result = await this.attempt(
              {
                ...node,
                url: completeApiUrl(
                  node.url,
                  node.protocol,
                  settings.autoCompleteUrl !== false,
                ),
              },
              adapted.payload,
              attemptSignal,
              settings,
              entry.diagnostics,
            );
            if (signal.aborted) throw signal.reason;
            if (job.pendingSwitch) throw abortError();
            entry.state = "succeeded";
            entry.diagnostics.completion = completionSummary(result);
            entry.ms = Date.now() - entry.started;
            job.state = "succeeded";
            job.result = result;
            return;
          } catch (error) {
            entry.ms = Date.now() - entry.started;
            if (signal.aborted) {
              entry.state = "cancelled";
              entry.cancelReason = job.cancelReason || "client_aborted";
              throw signal.reason;
            }
            if (job.pendingSwitch) {
              entry.state = "cancelled";
              entry.cancelReason = "manual_switch";
              entry.category = "user";
              entry.phase = "switch";
              entry.code = "manual_switch";
              entry.message = "用户手动切换节点，已丢弃未交付结果";
              index--;
              continue;
            }
            entry.state = "failed";
            Object.assign(
              entry,
              failureRecord(error, [
                ...this.store.keys(),
                node.key,
                job.nativeNode?.key,
              ]),
            );
            if (Number.isFinite(error.retryAt))
              retryTimes.set(node.id, error.retryAt);
          } finally {
            job.attemptController = null;
          }
        }
        if (
          job.testNode ||
          !this.store.config.loop ||
          (job.maxRounds && job.round >= job.maxRounds)
        ) {
          job.state = "exhausted";
          job.reason = job.testNode
            ? "节点测试失败"
            : "已达到总轮次上限或循环未开启";
          break;
        }
        job.state = "waiting";
        this.persist();
        const ms = this.waitMs ?? this.store.config.intervalSeconds * 1000;
        job.nextAttemptAt = Date.now() + ms;
        job.waitController = new AbortController();
        try {
          await sleep(ms, AbortSignal.any([signal, job.waitController.signal]));
        } catch (e) {
          if (signal.aborted) throw e;
        }
        delete job.waitController;
        delete job.nextAttemptAt;
        if (!this.store.config.loop) {
          job.state = "exhausted";
          break;
        }
      }
    } catch (error) {
      job.state = signal.aborted ? "cancelled" : "invalid";
      job.reason = signal.aborted
        ? CANCEL_REASONS[job.cancelReason] || CANCEL_REASONS.client_aborted
        : failureRecord(error, [...this.store.keys(), job.nativeNode?.key])
            .message;
    } finally {
      this.finish(job);
    }
  }
  finish(job) {
    job.ended = Date.now();
    job.payload = null;
    job.nativeNode = null;
    job.previewNode = null;
    job.testSettings = null;
    job.attemptController = null;
    delete job.pendingSwitch;
    job.controller = null;
    delete job.waitController;
    delete job.nextAttemptAt;
    this.persist();
  }
  snapshot(j, withResult = false) {
    const {
      controller,
      payload,
      lease,
      result,
      waitController,
      testNode,
      nativeNode,
      previewNode,
      testSettings,
      attemptController,
      pendingSwitch,
      ...safe
    } = j;
    return structuredClone({
      ...safe,
      ...(withResult && result ? { result } : {}),
    });
  }
  get(id, touch = false) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (touch) job.lease = Date.now();
    return this.snapshot(job, true);
  }
  list() {
    const byId = new Map(this.records.map((j) => [j.id, j]));
    for (const j of this.jobs.values()) byId.set(j.id, this.snapshot(j));
    return [...byId.values()]
      .sort((a, b) => b.started - a.started)
      .slice(0, 100);
  }
  cancel(id, reason = "client_aborted") {
    const j = this.jobs.get(id);
    if (j && !terminal.has(j.state) && !j.controller?.signal.aborted) {
      j.cancelReason = Object.hasOwn(CANCEL_REASONS, reason)
        ? reason
        : "client_aborted";
      j.controller?.abort(abortError());
    }
    return this.get(id);
  }
  switchNode(id, nodeId) {
    const job = this.jobs.get(id);
    if (
      !job ||
      terminal.has(job.state) ||
      job.testNode ||
      job.controller?.signal.aborted
    )
      throw new Error("当前任务不能切换节点");
    if (!job.availableNodes?.some((n) => n.id === nodeId))
      throw new Error("请选择本轮可用节点");
    if (job.pendingSwitch) throw new Error("正在切换，请稍后");
    job.manualSwitches.push({ nodeId, at: Date.now(), round: job.round });
    job.manualSwitches.splice(0, Math.max(0, job.manualSwitches.length - 100));
    job.pendingSwitch = nodeId;
    delete job.nextAttemptAt;
    job.attemptController?.abort(abortError());
    job.waitController?.abort();
    this.persist();
    return this.get(id);
  }
  acknowledge(id) {
    const j = this.jobs.get(id);
    if (j && terminal.has(j.state)) {
      j.result = null;
      j.lease = Date.now();
      this.clientEvent(id, "browser_received");
    }
  }
  clientEvent(id, stage) {
    if (
      !["browser_received", "response_prepared", "client_failed"].includes(
        stage,
      )
    )
      return false;
    const j = this.jobs.get(id) || this.records.find((r) => r.id === id);
    if (!j) return false;
    j.clientEvents ||= [];
    if (!j.clientEvents.some((e) => e.stage === stage)) {
      j.clientEvents.push({ stage, at: Date.now() });
      this.persist();
    }
    return true;
  }
  configChanged() {
    for (const j of this.jobs.values()) {
      if (!this.store.config.enabled && !j.testNode)
        this.cancel(j.id, "plugin_disabled");
      else if (j.nativeNode && !this.store.config.nativeFirst)
        this.cancel(j.id, "native_disabled");
      else if (!this.store.config.loop) j.waitController?.abort();
    }
  }
  expire() {
    for (const [id, j] of this.jobs) {
      if (!terminal.has(j.state) && Date.now() - j.lease > this.leaseMs)
        this.cancel(id, "lease_expired");
      if (terminal.has(j.state) && Date.now() - (j.ended || j.started) > 60000)
        this.jobs.delete(id);
    }
  }
  persist() {
    const byId = new Map(this.records.map((j) => [j.id, j]));
    for (const j of this.jobs.values()) byId.set(j.id, this.snapshot(j));
    try {
      this.records = this.store.saveLogs([...byId.values()]);
      this.storageError = false;
    } catch {
      this.storageError = true;
    }
  }
  clearLogs() {
    this.records = [];
    for (const [id, j] of this.jobs)
      if (terminal.has(j.state)) this.jobs.delete(id);
    this.store.saveLogs([]);
  }
  close() {
    clearInterval(this.sweep);
    this.store.listeners.delete(this.onConfig);
    for (const id of this.jobs.keys()) this.cancel(id, "server_shutdown");
  }
}
