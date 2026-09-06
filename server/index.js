import { Store } from "./store.js";
import { Jobs } from "./jobs.js";
import { redact } from "./errors.js";
import { randomUUID } from "node:crypto";
import { loadNativeSecrets, nativeNode } from "./native.js";
import { attempt } from "./upstream.js";
export const info = {
  id: "silent-failover",
  name: "Silent API Failover",
  description: "Private sequential and cyclic API failover jobs",
};
const users = new Map();
export async function init(router, options = {}) {
  const host = options.host ?? (await loadNativeSecrets());
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
            attempt: (node, payload, signal, settings) =>
              attempt(node, payload, signal, settings, host),
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
        version: "1.1.1",
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
        nativeAvailable: Boolean(host?.readSecret),
      }),
    ),
  );
  router.post(
    "/jobs",
    route((req, res) => {
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
    "/jobs/:id/ack",
    route((req, res) => {
      req.failover.jobs.acknowledge(req.params.id);
      res.json({ ok: true });
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
      const node = req.failover.store.config.nodes.find(
        (n) => n.id === req.body.nodeId,
      );
      if (!node) throw new Error("节点不存在");
      res.json(
        req.failover.jobs.create(
          randomUUID(),
          {
            messages: [{ role: "user", content: "Reply with OK." }],
            max_tokens: node.protocol && node.protocol !== "openai" ? 256 : 8,
            ...(node.protocol === "gemini" ? { reasoning_effort: "min" } : {}),
          },
          { testNode: req.body.nodeId },
        ),
      );
    }),
  );
}
export async function exit() {
  for (const { jobs } of users.values()) jobs.close();
  users.clear();
}
