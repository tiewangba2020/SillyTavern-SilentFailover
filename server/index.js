import { Store } from "./store.js";
import { Jobs } from "./jobs.js";
import { redact } from "./errors.js";
import { randomUUID } from "node:crypto";
import { loadNativeSecrets, nativeNode } from "./native.js";
import { attempt } from "./upstream.js";
import { VERSION } from "./version.js";
import { Updater } from "./update.js";
import { listModels } from "./models.js";
export const info = {
  id: "silent-failover",
  name: "Silent API Failover",
  description: "Private sequential and cyclic API failover jobs",
};
const users = new Map();
export async function init(router, options = {}) {
  const host = options.host ?? (await loadNativeSecrets());
  const updater =
    options.updater ||
    new Updater({
      busy: () =>
        [...users.values()].some(({ jobs }) =>
          [...jobs.jobs.values()].some((j) =>
            ["running", "waiting"].includes(j.state),
          ),
        ),
    });
  router.use((req, res, next) => {
    const root = req.user?.directories?.root;
    if (!root)
      return res.status(401).json({ error: "Authentication required" });
    try {
      if (!users.has(root)) {
        const store = new Store(root);
        users.set(root, {
          store,
          jobs: new Jobs(store, {
            attempt: (node, payload, signal, settings, diagnostics) =>
              attempt(node, payload, signal, settings, host, diagnostics),
          }),
        });
      }
      req.failover = users.get(root);
      next();
    } catch {
      res.status(500).json({ error: "无法读取插件数据" });
    }
  });
  const route = (fn) => (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      res
        .status(400)
        .json({ error: redact(e.message, req.failover.store.keys()) });
    }
  };
  router.get(
    "/config",
    route((req, res) =>
      res.json({
        version: VERSION,
        updateSupported: true,
        canUpdate: req.user?.profile?.admin === true,
        nativeAvailable: Boolean(host?.readSecret),
        logStorageAvailable: !req.failover.jobs.storageError,
        ...req.failover.store.publicConfig(),
      }),
    ),
  );
  router.post(
    "/config",
    route((req, res) =>
      res.json({
        ...req.failover.store.save(req.body),
        version: VERSION,
        updateSupported: true,
        canUpdate: req.user?.profile?.admin === true,
        nativeAvailable: Boolean(host?.readSecret),
      }),
    ),
  );
  router.post(
    "/jobs",
    route((req, res) => {
      if (updater.state.state === "updating" || updater.state.restartRequired)
        return res
          .status(409)
          .json({ error: "插件更新中或等待重启，请重启酒馆后生成" });
      const native = req.body.nativeFirst === true;
      if (native && !req.failover.store.config.nativeFirst)
        throw new Error("原生连接联动已关闭");
      const input = structuredClone(req.body.request);
      if (
        host?.postProcessPrompt &&
        input?.custom_prompt_post_processing &&
        Array.isArray(input.messages)
      ) {
        input.messages = host.postProcessPrompt(
          input.messages,
          input.custom_prompt_post_processing,
          host.getPromptNames({ body: input }),
        );
        delete input.custom_prompt_post_processing;
      }
      res.json(
        req.failover.jobs.create(req.body.id, input, {
          generation: req.body.generation,
          nativeNode: native
            ? nativeNode(input, req.user.directories, host)
            : null,
        }),
      );
    }),
  );
  router.get(
    "/jobs/:id",
    route((req, res) => {
      const job = req.failover.jobs.get(req.params.id, true);
      job
        ? res.json(job)
        : res.status(404).json({ error: "任务不存在或已结束" });
    }),
  );
  router.post(
    "/jobs/:id/cancel",
    route((req, res) =>
      res.json(
        req.failover.jobs.cancel(req.params.id, req.body?.reason) || {
          state: "cancelled",
        },
      ),
    ),
  );
  router.get(
    "/records",
    route((req, res) => res.json(req.failover.jobs.list())),
  );
  router.post(
    "/jobs/:id/switch",
    route((req, res) =>
      res.json(req.failover.jobs.switchNode(req.params.id, req.body?.nodeId)),
    ),
  );
  router.post("/models", async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on("close", abort);
    try {
      const node = req.failover.store.previewNode(req.body?.node, false);
      res.json(
        await listModels(
          node,
          AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        ),
      );
    } catch (e) {
      if (!res.destroyed)
        res
          .status(e.status || 400)
          .json({
            error: e.status
              ? `获取模型失败（HTTP ${e.status}），可手动填写模型 ID`
              : "无法获取模型列表，请检查地址和网络，或手动填写模型 ID",
          });
    } finally {
      res.off("close", abort);
    }
  });
  router.post(
    "/jobs/:id/ack",
    route((req, res) => {
      req.failover.jobs.acknowledge(req.params.id);
      res.json({ ok: true });
    }),
  );
  router.post(
    "/jobs/:id/events",
    route((req, res) => {
      const ok = req.failover.jobs.clientEvent(req.params.id, req.body?.stage);
      res.status(ok ? 200 : 400).json({ ok });
    }),
  );
  router.get(
    "/diagnostics",
    route((req, res) =>
      res.json({
        schema: 2,
        pluginVersion: VERSION,
        exportedAt: Date.now(),
        logStorageAvailable: !req.failover.jobs.storageError,
        update: { ...updater.state },
        records: req.failover.jobs.list(),
      }),
    ),
  );
  router.get(
    "/update/status",
    route((req, res) =>
      res.json({
        ...updater.state,
        canUpdate: req.user?.profile?.admin === true,
      }),
    ),
  );
  router.get("/update/check", async (req, res) => {
    if (req.user?.profile?.admin !== true)
      return res.status(403).json({ error: "仅酒馆管理员可检查和安装更新" });
    try {
      res.json(await updater.check());
    } catch {
      res.status(502).json({
        error: "无法取得 GitHub 正式版更新信息，请检查网络或下载完整安装包",
      });
    }
  });
  router.post(
    "/update",
    route((req, res) => {
      if (req.user?.profile?.admin !== true)
        return res.status(403).json({ error: "仅酒馆管理员可更新服务端插件" });
      res.json(updater.start(req.user.directories.extensions));
    }),
  );
  router.post(
    "/records/clear",
    route((req, res) => {
      req.failover.jobs.clearLogs();
      res.json({ ok: true });
    }),
  );
  router.post(
    "/test",
    route((req, res) => {
      if (updater.state.state === "updating" || updater.state.restartRequired)
        return res
          .status(409)
          .json({ error: "插件更新中或等待重启，请重启酒馆后测试" });
      const node = req.body.node
        ? req.failover.store.previewNode(req.body.node)
        : req.failover.store.config.nodes.find((n) => n.id === req.body.nodeId);
      if (!node) throw new Error("节点不存在");
      res.json(
        req.failover.jobs.create(
          req.body.id || randomUUID(),
          {
            messages: [{ role: "user", content: "Reply with OK." }],
            max_tokens: 256,
            ...(node.protocol === "gemini" ? { reasoning_effort: "min" } : {}),
          },
          {
            testNode: node.id,
            previewNode: node,
            testSettings: req.failover.store.validate({
              ...req.failover.store.publicConfig(),
              ...Object.fromEntries(
                [
                  "waitMode",
                  "timeoutSeconds",
                  "headerSeconds",
                  "firstTokenSeconds",
                  "idleSeconds",
                ]
                  .filter((k) => req.body.settings?.[k] !== undefined)
                  .map((k) => [k, req.body.settings[k]]),
              ),
            }),
          },
        ),
      );
    }),
  );
}
export async function exit() {
  for (const { jobs } of users.values()) jobs.close();
  users.clear();
}
