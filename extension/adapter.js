export const ENDPOINT = "http://sillytavern-failover.invalid/v1";
import { usageForHost } from "../server/usage.js";
export const API = "/api/plugins/silent-failover";
export const cancelled = () =>
  new DOMException("Silent failover stopped", "AbortError");
const json = (value) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const delay = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(cancelled());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
export function installAdapter(
  context,
  onLocalRecord = () => {},
  lifecycle = {},
) {
  const previous = window.fetch;
  const active = new Map();
  let disposed = false;
  async function api(path, body, signal) {
    const response = await previous(API + path, {
      method: body === undefined ? "GET" : "POST",
      headers: context().getRequestHeaders(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
        : AbortSignal.timeout(12000),
    });
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(data.error || "服务端请求失败"), {
        status: response.status,
      });
    return data;
  }
  async function wrapper(input, init) {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.href,
    );
    if (
      disposed ||
      url.origin !== location.origin ||
      url.pathname !== "/api/backends/chat-completions/generate"
    )
      return previous(input, init);
    let body;
    try {
      body =
        typeof init?.body === "string"
          ? JSON.parse(init.body)
          : input instanceof Request
            ? await input.clone().json()
            : null;
    } catch {
      return previous(input, init);
    }
    if (
      !["custom", "openai", "claude", "makersuite"].includes(
        body?.chat_completion_source,
      )
    )
      return previous(input, init);
    await lifecycle.flush?.();
    const settings = await api("/config").catch(
      () => lifecycle.config?.() || null,
    );
    if (!settings?.enabled) return previous(input, init);
    const nativeFirst = settings.nativeFirst !== false;
    const id = crypto.randomUUID();
    const saved = lifecycle.start?.();
    const preferredNodeId = lifecycle.takePreferredNode?.(saved?.type);
    const controller = new AbortController();
    const originalSignal =
      init?.signal || (input instanceof Request ? input.signal : null);
    const abort = () => controller.abort("client_aborted");
    originalSignal?.addEventListener("abort", abort, { once: true });
    if (originalSignal?.aborted) abort();
    active.set(id, controller);
    let phase = "create_job";
    try {
      let job;
      let lastContact = Date.now();
      while (!job) {
        try {
          job = await api(
            "/jobs",
            {
              id,
              request: body,
              nativeFirst,
              generation: saved?.type,
              preferredNodeId,
            },
            controller.signal,
          );
          lastContact = Date.now();
        } catch (e) {
          if (
            controller.signal.aborted ||
            (e.status && e.status < 500) ||
            Date.now() - lastContact > 55000
          )
            throw e;
          await delay(1000, controller.signal);
        }
      }
      phase = "poll_job";
      while (["running", "waiting"].includes(job.state)) {
        await delay(600, controller.signal);
        try {
          job = await api("/jobs/" + id, undefined, controller.signal);
          lastContact = Date.now();
        } catch (e) {
          if (
            controller.signal.aborted ||
            e.status === 404 ||
            Date.now() - lastContact > 55000
          )
            throw e;
        }
      }
      if (controller.signal.aborted || job.state !== "succeeded")
        throw cancelled();
      void api("/jobs/" + id + "/ack", {}).catch(() => {});
      phase = "prepare_response";
      const handoff = (response) => {
        void api("/jobs/" + id + "/events", {
          stage: "response_prepared",
        }).catch(() => {});
        return response;
      };
      if (!body.stream) {
        const usage = usageForHost(job.result.tokenUsage);
        return handoff(json({ ...job.result, ...(usage ? { usage } : {}) }));
      }
      const choice = job.result.choices[0];
      const source = body.chat_completion_source;
      const usage = usageForHost(job.result.tokenUsage, source);
      if (source === "claude" || source === "makersuite") {
        const message = choice.message;
        const chunks =
          source === "claude"
            ? [
                ...(message.reasoning_content
                  ? [
                      {
                        type: "content_block_delta",
                        index: 0,
                        delta: {
                          type: "thinking_delta",
                          thinking: message.reasoning_content,
                        },
                      },
                    ]
                  : []),
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: message.content },
                },
                {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn" },
                  ...(usage ? { usage } : {}),
                },
                { type: "message_stop" },
              ]
            : [
                ...(message.reasoning_content
                  ? [
                      {
                        candidates: [
                          {
                            content: {
                              parts: [
                                {
                                  text: message.reasoning_content,
                                  thought: true,
                                },
                              ],
                            },
                          },
                        ],
                      },
                    ]
                  : []),
                {
                  ...(usage ? { usageMetadata: usage } : {}),
                  candidates: [
                    {
                      content: { parts: [{ text: message.content }] },
                      finishReason: "STOP",
                    },
                  ],
                },
              ];
        return handoff(
          new Response(
            chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
              "data: [DONE]\n\n",
            {
              headers: { "Content-Type": "text/event-stream" },
            },
          ),
        );
      }
      const chunk = {
        id: job.result.id,
        object: "chat.completion.chunk",
        model: job.result.model,
        ...(usage ? { usage } : {}),
        choices: [
          {
            index: 0,
            delta: choice.message,
            finish_reason: choice.finish_reason,
          },
        ],
      };
      return handoff(
        new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    } catch (e) {
      void api("/jobs/" + id + "/events", { stage: "client_failed" }).catch(
        () => {},
      );
      if (!controller.signal.aborted && e.name !== "AbortError")
        onLocalRecord({
          id,
          started: Date.now(),
          state: "invalid",
          status: Number.isInteger(e.status) ? e.status : null,
          phase,
          errorType: [
            "TypeError",
            "SyntaxError",
            "TimeoutError",
            "AbortError",
          ].includes(e.name)
            ? e.name
            : "Error",
          reason: "服务端连接不可用或请求无效",
          attempts: [],
        });
      void api("/jobs/" + id + "/cancel", {
        reason: controller.signal.aborted
          ? controller.signal.reason || "client_aborted"
          : "client_error",
      }).catch(() => {});
      await lifecycle.failed?.(saved);
      throw cancelled();
    } finally {
      active.delete(id);
      originalSignal?.removeEventListener("abort", abort);
    }
  }
  window.fetch = wrapper;
  return {
    api,
    cancel(reason = "client_aborted") {
      for (const controller of active.values()) controller.abort(reason);
    },
    dispose() {
      disposed = true;
      this.cancel("plugin_disabled");
      if (window.fetch === wrapper) window.fetch = previous;
    },
    get active() {
      return active.size;
    },
  };
}
