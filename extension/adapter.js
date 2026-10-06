export const ENDPOINT = "http://sillytavern-failover.invalid/v1";
import { usageForHost } from "../server/usage.js";
import { requestId, requestDeadline } from "./browser-compat.js";
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
// 酒馆自己的生成路径（openai.js 的 sendOpenAIRequest）会先发 CHAT_COMPLETION_SETTINGS_READY，
// 紧接着才 fetch /api/backends/chat-completions/generate；别的扩展借道
// ChatCompletionService / ConnectionManagerRequestService 打同一个端点时不会发这个事件。
// 用它把「酒馆主生成」和「扩展自建的独立请求」区分开，后者必须原样放行，否则会抢走对方的 API 配置。
export const HOST_GENERATION_WINDOW_MS = 15000;
export function shouldIntercept(
  body,
  pendingAt,
  discriminatorAvailable,
  now = Date.now(),
) {
  if (
    !["custom", "openai", "claude", "makersuite"].includes(
      body?.chat_completion_source,
    )
  )
    return false;
  // 旧版酒馆没有该事件，无法区分来源，退回「全部接管」的原行为。
  if (!discriminatorAvailable) return true;
  return pendingAt !== 0 && now - pendingAt < HOST_GENERATION_WINDOW_MS;
}
export function installAdapter(
  context,
  onLocalRecord = () => {},
  lifecycle = {},
) {
  const previous = window.fetch;
  const active = new Map();
  let disposed = false;
  const eventTypes = context().eventTypes || {};
  const hostReadyEvent = eventTypes.CHAT_COMPLETION_SETTINGS_READY;
  const discriminatorAvailable = typeof hostReadyEvent === "string";
  let hostGenerationAt = 0;
  const markHostGeneration = () => {
    hostGenerationAt = Date.now();
  };
  const clearHostGeneration = () => {
    hostGenerationAt = 0;
  };
  const hostSubscriptions = [];
  if (discriminatorAvailable)
    for (const [event, fn] of [
      [hostReadyEvent, markHostGeneration],
      [eventTypes.GENERATION_STOPPED, clearHostGeneration],
      [eventTypes.CHAT_CHANGED, clearHostGeneration],
    ])
      if (typeof event === "string") {
        context().eventSource.on(event, fn);
        hostSubscriptions.push([event, fn]);
      }
  async function api(path, body, signal) {
    const deadline = requestDeadline(signal);
    try {
      const response = await previous(API + path, {
        method: body === undefined ? "GET" : "POST",
        headers: context().getRequestHeaders(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: deadline.signal,
      });
      const statusMessage = {
        401: "酒馆登录已失效，请重新登录后刷新页面",
        403: "酒馆拒绝了插件请求，请刷新页面重新登录，并检查访问权限或 CSRF 错误",
        404: "此酒馆未找到插件服务端，请确认两部分安装在手机访问的同一个酒馆中，并重启酒馆后台",
      }[response.status];
      let data;
      try {
        data = await response.json();
      } catch {
        if (deadline.signal.aborted) throw deadline.signal.reason;
        throw Object.assign(
          new Error(
            statusMessage ||
              "服务端返回的不是有效 JSON，请检查登录状态、代理设置和酒馆后台日志",
          ),
          { status: response.status },
        );
      }
      if (!response.ok)
        throw Object.assign(
          new Error(statusMessage || data?.error || "服务端请求失败"),
          {
            status: response.status,
          },
        );
      return data;
    } finally {
      deadline.dispose();
    }
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
    const pending = hostGenerationAt;
    hostGenerationAt = 0;
    if (!shouldIntercept(body, pending, discriminatorAvailable))
      return previous(input, init);
    await lifecycle.flush?.();
    const settings = await api("/config").catch(
      () => lifecycle.config?.() || null,
    );
    if (!settings?.enabled) return previous(input, init);
    const nativeFirst = settings.nativeFirst !== false;
    const id = requestId();
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
      for (const [event, fn] of hostSubscriptions.splice(0))
        context().eventSource.removeListener(event, fn);
      if (window.fetch === wrapper) window.fetch = previous;
    },
    get active() {
      return active.size;
    },
  };
}
