import { Failure } from "./errors.js";
import { adaptParameters } from "./parameters.js";

export function prepare(node, payload, host) {
  payload = adaptParameters(node, payload).payload;
  const p = { ...node.request, ...payload };
  const protocol = node.protocol || "openai";
  if (protocol === "openai")
    return {
      url: node.url.endsWith("/chat/completions")
        ? node.url
        : node.url + "/chat/completions",
      headers: node.key ? { Authorization: `Bearer ${node.key}` } : {},
      body: { ...payload, model: node.model, stream: node.stream },
    };
  if (!host)
    throw new Failure(
      "Native protocol helpers unavailable; restart SillyTavern after updating",
      { category: "configuration" },
    );
  if (p.response_format || p.json_schema)
    throw new Failure(
      "Structured output is currently supported only by OpenAI-compatible nodes",
      { category: "configuration" },
    );
  const names = host.getPromptNames({ body: p });
  if (protocol === "claude") {
    const converted = host.convertClaudeMessages(
      structuredClone(p.messages),
      p.assistant_prefill,
      p.use_sysprompt !== false,
      false,
      names,
    );
    const body = {
      model: node.model,
      messages: converted.messages,
      max_tokens: p.max_tokens ?? p.max_completion_tokens ?? 1024,
      stream: node.stream,
      temperature: p.temperature,
      top_p: p.top_p,
      top_k: p.top_k,
      ...(p.stop?.length ? { stop_sequences: p.stop } : {}),
      ...(p.use_sysprompt !== false ? { system: converted.systemPrompt } : {}),
    };
    const adaptive = /^claude-(opus-4-6|sonnet-4-6|opus-4-7)/.test(node.model);
    const budget = /^claude-(3-7|opus-4|sonnet-4|haiku-4-5)/.test(node.model)
      ? host.calculateClaudeBudgetTokens(
          body.max_tokens,
          p.reasoning_effort || "auto",
          node.stream,
          adaptive,
        )
      : null;
    if (typeof budget === "string" || Number.isInteger(budget)) {
      body.thinking =
        typeof budget === "string"
          ? { type: "adaptive" }
          : { type: "enabled", budget_tokens: budget };
      if (typeof budget === "string") body.output_config = { effort: budget };
      else if (body.max_tokens <= 1024) body.max_tokens += 1024;
      delete body.temperature;
      delete body.top_p;
      delete body.top_k;
      if (body.messages.at(-1)?.role === "assistant")
        body.messages.at(-1).role = "user";
    } else if (
      /^claude-(opus-4-1|sonnet-4-5|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6)/.test(
        node.model,
      )
    ) {
      if (body.top_p < 1) delete body.temperature;
      else delete body.top_p;
    }
    if (/^claude-opus-4-7/.test(node.model)) {
      delete body.temperature;
      delete body.top_p;
      delete body.top_k;
    }
    return {
      url: node.url.endsWith("/messages") ? node.url : node.url + "/messages",
      headers: { "x-api-key": node.key, "anthropic-version": "2023-06-01" },
      body,
    };
  }
  const converted = host.convertGooglePrompt(
    structuredClone(p.messages),
    node.model,
    p.use_sysprompt !== false,
    names,
  );
  const generationConfig = {
    maxOutputTokens: p.max_tokens ?? p.max_completion_tokens ?? 1024,
    temperature: p.temperature,
    topP: p.top_p,
    topK: p.top_k || undefined,
    ...(p.stop?.length ? { stopSequences: p.stop } : {}),
    ...(p.seed != null ? { seed: p.seed } : {}),
  };
  if (/^gemini-(2\.5|3)/.test(node.model)) {
    const budget = host.calculateGoogleBudgetTokens(
      generationConfig.maxOutputTokens,
      p.reasoning_effort || "auto",
      node.model,
    );
    generationConfig.thinkingConfig = {
      includeThoughts: p.include_reasoning === true,
      ...(typeof budget === "number" ? { thinkingBudget: budget } : {}),
      ...(typeof budget === "string" ? { thinkingLevel: budget } : {}),
    };
  }
  const base = node.url.replace(/\/v1(beta)?$/, "");
  return {
    url: `${base}/v1beta/models/${encodeURIComponent(node.model)}:${node.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
    headers: { "x-goog-api-key": node.key },
    body: {
      contents: converted.contents,
      generationConfig,
      safetySettings: host.safety,
      ...(p.use_sysprompt !== false &&
      converted.system_instruction?.parts?.length
        ? { systemInstruction: converted.system_instruction }
        : {}),
    },
  };
}

export function nativeCompletion(data, protocol) {
  if (data?.error) return data;
  if (protocol === "claude" && Array.isArray(data.content)) {
    if (
      data.content.some(
        (x) => !["text", "thinking", "redacted_thinking"].includes(x.type),
      )
    )
      throw new Failure("Non-text Claude completion", { category: "protocol" });
    return {
      id: data.id,
      model: data.model,
      usage: data.usage,
      choices: [
        {
          message: {
            role: "assistant",
            content: data.content
              .filter((x) => x.type === "text")
              .map((x) => x.text)
              .join(""),
            reasoning_content: data.content
              .filter((x) => x.type === "thinking")
              .map((x) => x.thinking)
              .join(""),
          },
          finish_reason: data.stop_reason || "stop",
        },
      ],
    };
  }
  if (protocol === "gemini") {
    const c = data.candidates?.[0];
    const parts = c?.content?.parts || [];
    if (parts.some((x) => x.functionCall || x.inlineData))
      throw new Failure("Non-text Gemini completion", { category: "protocol" });
    if (!c && data.promptFeedback?.blockReason)
      throw new Failure(
        "Gemini blocked prompt: " + data.promptFeedback.blockReason,
        { category: "permission" },
      );
    return {
      id: data.responseId,
      model: data.modelVersion,
      usage: data.usageMetadata,
      choices: c
        ? [
            {
              message: {
                role: "assistant",
                content: parts
                  .filter((x) => !x.thought)
                  .map((x) => x.text || "")
                  .join(""),
                reasoning_content: parts
                  .filter((x) => x.thought)
                  .map((x) => x.text || "")
                  .join(""),
              },
              finish_reason:
                c.finishReason === "SAFETY" ? "content_filter" : c.finishReason,
            },
          ]
        : [],
    };
  }
  return data;
}
