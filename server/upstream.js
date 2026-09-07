import { createParser } from "eventsource-parser";
import { Failure } from "./errors.js";
import { prepare, nativeCompletion } from "./protocols.js";
import { completionSummary } from "./diagnostics.js";
import { Agent, fetch } from "undici";
import { tokenUsage } from "./usage.js";
// Keep fetch and its dispatcher on the same Undici version across Node releases.
const providerAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const LIMIT = 8 * 1024 * 1024;
export function normalizeRequest(input) {
  if (!input || !Array.isArray(input.messages) || !input.messages.length)
    throw new Error("请求缺少消息");
  if (input.n != null && input.n !== 1) throw new Error("暂不支持多个候选回复");
  if (input.enable_web_search || input.request_images)
    throw new Error("故障转移目前只支持文本聊天，不支持联网搜索或图像生成");
  if (
    input.tools?.length ||
    input.functions?.length ||
    input.tool_choice ||
    input.function_call
  )
    throw new Error("暂不支持工具调用");
  if (
    input.messages.some(
      (m) =>
        !["user", "assistant", "system", "developer"].includes(m.role) ||
        typeof m.content !== "string",
    )
  )
    throw new Error("第一版只支持文本聊天消息");
  if (
    input.custom_include_body?.trim() ||
    input.custom_exclude_body?.trim() ||
    input.custom_include_headers?.trim()
  )
    throw new Error(
      "故障转移暂不支持酒馆自定义请求体和请求头，请在原生连接设置中检查这些参数",
    );
  const out = { messages: structuredClone(input.messages) };
  for (const name of [
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "frequency_penalty",
    "presence_penalty",
    "stop",
    "seed",
    "logit_bias",
    "response_format",
    "reasoning_effort",
    "verbosity",
  ])
    if (input[name] != null) out[name] = structuredClone(input[name]);
  if (input.json_schema)
    out.response_format = {
      type: "json_schema",
      json_schema: {
        name: input.json_schema.name || "response",
        strict: input.json_schema.strict ?? true,
        schema: input.json_schema.value,
      },
    };
  return out;
}
function providerFailure(data, status, phase = "response") {
  return new Failure(
    data?.error?.message || data?.message || "API request failed",
    { status, code: data?.error?.code || data?.error?.type, phase },
  );
}
function validate(data) {
  if (data?.error) throw providerFailure(data, 200);
  const choice = data?.choices?.[0];
  if (choice?.message?.tool_calls?.length)
    throw new Failure("Unexpected tool calls", {
      category: "protocol",
      phase: "parse",
    });
  const text = choice?.message?.content;
  if (
    !choice ||
    (!String(text ?? "").trim() &&
      !choice.message?.refusal &&
      choice.finish_reason !== "content_filter")
  )
    throw new Failure("Empty or invalid completion", {
      category: "protocol",
      phase: "parse",
    });
  if (typeof text !== "string" && text != null)
    throw new Failure("Non-text completion", {
      category: "protocol",
      phase: "parse",
    });
  if (!text && choice.message?.refusal)
    choice.message.content = choice.message.refusal;
  return data;
}
export async function attempt(
  node,
  payload,
  parent,
  settings,
  host = null,
  diagnostics = {},
) {
  const started = Date.now();
  diagnostics.bytes = 0;
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const timeError = (phase) =>
    new Failure("API timeout", { category: "timeout", phase });
  let timer;
  const arm = (seconds, phase) => {
    clearTimeout(timer);
    if (settings.waitMode === "patient" || !seconds) return;
    timer = setTimeout(
      () => controller.abort(timeError(phase)),
      seconds * 1000,
    );
  };
  const total =
    settings.waitMode !== "patient" && settings.timeoutSeconds
      ? setTimeout(
          () => controller.abort(timeError("total")),
          settings.timeoutSeconds * 1000,
        )
      : null;
  let reader;
  let captureProgress = () => {};
  try {
    arm(settings.headerSeconds, "headers");
    const prepared = prepare(node, payload, host);
    const response = await fetch(prepared.url, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...prepared.headers,
      },
      body: JSON.stringify(prepared.body),
      signal,
      dispatcher: providerAgent,
    });
    diagnostics.httpStatus = response.status;
    diagnostics.headersMs = Date.now() - started;
    const mime = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    diagnostics.contentType = [
      "application/json",
      "text/event-stream",
      "text/html",
      "text/plain",
    ].includes(mime)
      ? mime
      : mime
        ? "other"
        : "missing";
    arm(settings.firstTokenSeconds, "first_data");
    reader = response.body?.getReader();
    if (!reader)
      throw new Failure("Missing response body", { category: "protocol" });
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    let done = false;
    let finish = null;
    let content = "";
    let reasoning = "";
    let refusal = "";
    let usage;
    let responseId;
    captureProgress = () => {
      const tokens = tokenUsage(usage, node.protocol);
      if (tokens) diagnostics.usage = tokens;
      if (content || reasoning || refusal)
        diagnostics.completion = completionSummary({
          choices: [
            {
              message: { content, reasoning_content: reasoning, refusal },
              finish_reason: finish,
            },
          ],
        });
    };
    const isSse = response.ok && mime === "text/event-stream";
    diagnostics.parser = isSse ? "sse" : "json";
    const parser = createParser({
      onEvent(event) {
        if (event.data === "[DONE]") {
          done = true;
          return;
        }
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          throw new Failure("Invalid SSE JSON", {
            category: "protocol",
            phase: "parse",
          });
        }
        const reported =
          node.protocol === "gemini"
            ? data.usageMetadata
            : data.usage || data.message?.usage;
        if (reported) usage = { ...usage, ...reported };
        captureProgress();
        if (data.error) throw providerFailure(data, 200, "stream");
        if (node.protocol === "claude") {
          if (data.type === "message_start") {
            responseId = data.message?.id;
            usage = { ...usage, ...data.message?.usage };
          }
          if (data.type === "content_block_start") {
            if (
              !["text", "thinking", "redacted_thinking"].includes(
                data.content_block?.type,
              )
            )
              throw new Failure("Non-text Claude stream", {
                category: "protocol",
              });
            content += data.content_block?.text || "";
            reasoning += data.content_block?.thinking || "";
          }
          if (data.type === "content_block_delta") {
            content += data.delta?.text || "";
            reasoning += data.delta?.thinking || "";
            if (data.delta?.text || data.delta?.thinking)
              arm(settings.idleSeconds, "idle");
          }
          if (data.type === "message_delta") {
            finish = data.delta?.stop_reason || finish;
            usage = { ...usage, ...data.usage };
          }
          if (data.type === "message_stop") done = true;
          return;
        }
        if (node.protocol === "gemini") {
          const parsed = nativeCompletion(data, "gemini");
          const choice = parsed.choices?.[0];
          content += choice?.message?.content || "";
          reasoning += choice?.message?.reasoning_content || "";
          if (choice?.message?.content || choice?.message?.reasoning_content)
            arm(settings.idleSeconds, "idle");
          if (choice?.finish_reason) finish = choice.finish_reason;
          if (parsed.usage) usage = { ...usage, ...parsed.usage };
          if (parsed.id) responseId = parsed.id;
          return;
        }
        if (data.usage) usage = { ...usage, ...data.usage };
        if (data.id) responseId = data.id;
        const c = data.choices?.[0];
        if (!c) return;
        if (c.delta?.tool_calls?.length)
          throw new Failure("Unexpected tool calls", {
            category: "protocol",
            phase: "parse",
          });
        const delta = c.delta || c.message || {};
        if (
          delta.content ||
          delta.reasoning_content ||
          delta.reasoning ||
          delta.refusal ||
          c.finish_reason
        )
          arm(settings.idleSeconds, "idle");
        content += delta.content || "";
        reasoning += delta.reasoning_content || delta.reasoning || "";
        refusal += delta.refusal || "";
        if (c.finish_reason) finish = c.finish_reason;
      },
    });
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      diagnostics.bytes = bytes;
      diagnostics.firstDataMs ??= Date.now() - started;
      diagnostics.lastDataMs = Date.now() - started;
      arm(settings.idleSeconds, "idle");
      if (bytes > LIMIT)
        throw new Failure("Response exceeds 8 MiB", {
          category: "limit",
          phase: "read",
        });
      const decoded = decoder.decode(chunk.value, { stream: true });
      if (isSse) {
        parser.feed(decoded);
        captureProgress();
        if (done) break;
      } else {
        text += decoded;
      }
    }
    if (isSse) parser.feed(decoder.decode());
    else text += decoder.decode();
    if (!response.ok) {
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        diagnostics.bodyShape = !text.trim()
          ? "empty"
          : /^\s*</.test(text)
            ? "html_or_xml"
            : "non_json";
        data = { message: "API returned a non-JSON error response" };
      }
      const error = providerFailure(data, response.status);
      const reported = tokenUsage(
        node.protocol === "gemini" ? data?.usageMetadata : data?.usage,
        node.protocol,
      );
      if (reported) diagnostics.usage = reported;
      const retry = response.headers.get("retry-after");
      if (retry) {
        const seconds = Number(retry);
        error.retryAt = Number.isFinite(seconds)
          ? Date.now() + Math.max(0, seconds) * 1000
          : Date.parse(retry);
      }
      throw error;
    }
    if (isSse) {
      diagnostics.streamEnded = done;
      diagnostics.completion = completionSummary({
        choices: [
          {
            message: { content, reasoning_content: reasoning, refusal },
            finish_reason: finish,
          },
        ],
      });
      if (!done && !finish)
        throw new Failure("Stream ended before completion", {
          category: "interrupted",
          phase: "stream",
        });
      return validate({
        id: responseId || "failover",
        object: "chat.completion",
        model: node.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content,
              ...(reasoning ? { reasoning_content: reasoning } : {}),
              ...(refusal ? { refusal } : {}),
            },
            finish_reason: finish || "stop",
          },
        ],
        ...(usage ? { usage } : {}),
      });
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      diagnostics.bodyShape = !text.trim()
        ? "empty"
        : /^\s*</.test(text)
          ? "html_or_xml"
          : /^\s*(data:|event:)/.test(text)
            ? "sse_with_wrong_content_type"
            : "invalid_json";
      throw new Failure("Invalid JSON response", {
        category: "protocol",
        phase: "parse",
      });
    }
    diagnostics.bodyShape = Array.isArray(data)
      ? "array"
      : data && typeof data === "object"
        ? "object"
        : "scalar";
    const tokens = tokenUsage(
      node.protocol === "gemini" ? data?.usageMetadata : data?.usage,
      node.protocol,
    );
    if (tokens) diagnostics.usage = tokens;
    const completion = nativeCompletion(data, node.protocol);
    diagnostics.completion = completionSummary(completion);
    return validate(completion);
  } catch (error) {
    captureProgress();
    if (diagnostics.usage) diagnostics.usagePartial = true;
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(total);
    await reader?.cancel().catch(() => {});
  }
}
