const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export function tokenUsage(raw, protocol = "openai") {
  if (!raw || typeof raw !== "object") return undefined;
  let values;
  if (protocol === "claude") {
    const input = count(raw.input_tokens),
      read = count(raw.cache_read_input_tokens),
      write = count(raw.cache_creation_input_tokens);
    const output = count(raw.output_tokens);
    const fullInput =
      input === undefined ? undefined : input + (read || 0) + (write || 0);
    values = {
      inputTokens: fullInput,
      outputTokens: output,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      totalTokens:
        fullInput !== undefined && output !== undefined
          ? fullInput + output
          : undefined,
    };
  } else if (protocol === "gemini") {
    const output = count(raw.candidatesTokenCount),
      reasoning = count(raw.thoughtsTokenCount);
    values = {
      inputTokens: raw.promptTokenCount,
      outputTokens:
        output === undefined ? undefined : output + (reasoning || 0),
      totalTokens: raw.totalTokenCount,
      reasoningTokens: reasoning,
      cacheReadTokens: raw.cachedContentTokenCount,
    };
  } else {
    values = {
      inputTokens: raw.prompt_tokens,
      outputTokens: raw.completion_tokens,
      totalTokens: raw.total_tokens,
      reasoningTokens: raw.completion_tokens_details?.reasoning_tokens,
      cacheReadTokens: raw.prompt_tokens_details?.cached_tokens,
    };
  }
  const clean = Object.fromEntries(
    Object.entries(values).filter(([, v]) => count(v) !== undefined),
  );
  return Object.keys(clean).length ? clean : undefined;
}

export function usageForHost(usage, source = "openai") {
  if (!usage) return undefined;
  const {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    reasoningTokens: reasoning,
    cacheReadTokens: read,
    cacheWriteTokens: write,
  } = usage;
  const fields =
    source === "claude"
      ? {
          input_tokens:
            input === undefined
              ? undefined
              : Math.max(0, input - (read || 0) - (write || 0)),
          output_tokens: output,
          cache_read_input_tokens: read,
          cache_creation_input_tokens: write,
        }
      : source === "makersuite"
        ? {
            promptTokenCount: input,
            candidatesTokenCount:
              output === undefined
                ? undefined
                : Math.max(0, output - (reasoning || 0)),
            totalTokenCount: total,
            thoughtsTokenCount: reasoning,
            cachedContentTokenCount: read,
          }
        : {
            prompt_tokens: input,
            completion_tokens: output,
            total_tokens: total,
            ...(reasoning === undefined
              ? {}
              : { completion_tokens_details: { reasoning_tokens: reasoning } }),
            ...(read === undefined
              ? {}
              : { prompt_tokens_details: { cached_tokens: read } }),
          };
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  );
}
