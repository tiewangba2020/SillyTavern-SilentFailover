import { attempt, normalizeRequest } from "./upstream.js";
import { abortError, failureRecord, sleep, CANCEL_REASONS } from "./errors.js";
import { adaptParameters } from "./parameters.js";
const terminal = new Set(["succeeded", "exhausted", "cancelled", "invalid"]);
export class Jobs {
  constructor(store, options = {}) {
    this.store = store;
    this.attempt = options.attempt || attempt;
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
  create(id, input, { testNode, nativeNode = null } = {}) {
    if (typeof id !== "string" || !id.length || id.length > 120)
      throw new Error("任务 ID 无效");
    if (this.jobs.has(id)) return this.get(id, true);
    if (this.records.some((x) => x.id === id))
      throw new Error("任务已结束，不能重复执行");
    if (
      [...this.jobs.values()].filter((j) => !terminal.has(j.state)).length >= 4
    )
      throw new Error("同时运行的任务过多");
    const job = {
      id,
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
      nativeNode,
      mode: testNode ? "node_test" : nativeNode ? "native_first" : "fallback",
    };
    this.jobs.set(id, job);
    try {
      job.payload = normalizeRequest(input);
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
        if (!config.enabled && !job.testNode) {
          job.state = "cancelled";
          job.reason = "插件已停用";
          break;
        }
        const nodes = config.nodes
          .filter((n) => (job.testNode ? n.id === job.testNode : n.enabled))
          .filter(
            (n) =>
              !job.nativeNode ||
              n.url !== job.nativeNode.url ||
              n.model !== job.nativeNode.model ||
              n.key !== job.nativeNode.key ||
              n.stream !== job.nativeNode.stream ||
              (n.maxTokens ?? null) !== (job.nativeNode.maxTokens ?? null) ||
              (n.protocol || "openai") !== job.nativeNode.protocol,
          )
          .sort((a, b) => a.priority - b.priority);
        if (job.nativeNode && !job.testNode) nodes.unshift(job.nativeNode);
        if (!nodes.length) {
          job.state = "invalid";
          job.reason = "没有可用的启用节点";
          break;
        }
        job.round++;
        job.state = "running";
        for (const node of nodes) {
          if (signal.aborted) throw signal.reason;
          const retry = retryTimes.get(node.id) || 0;
          if (retry > Date.now()) {
            job.nextAttemptAt = retry;
            await sleep(retry - Date.now(), signal);
            delete job.nextAttemptAt;
          }
          const adapted = adaptParameters(node, job.payload);
          const entry = {
            nodeId: node.id,
            node: node.name,
            model: node.model,
            round: job.round,
            started: Date.now(),
            state: "running",
            adjustments: adapted.adjustments,
          };
          job.attempts.push(entry);
          job.attemptCount++;
          if (job.attempts.length > 1000) {
            job.attempts.shift();
            job.dropped++;
          }
          try {
            const result = await this.attempt(
              node,
              adapted.payload,
              signal,
              config,
            );
            if (signal.aborted) throw signal.reason;
            entry.state = "succeeded";
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
          }
        }
        if (job.testNode || !this.store.config.loop) {
          job.state = "exhausted";
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
  acknowledge(id) {
    const j = this.jobs.get(id);
    if (j && terminal.has(j.state)) {
      j.result = null;
      j.lease = Date.now();
    }
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
