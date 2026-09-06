export const generationType = (value) =>
  [
    "normal",
    "quiet",
    "regenerate",
    "swipe",
    "continue",
    "impersonate",
  ].includes(value)
    ? value
    : "unknown";

export function completionSummary(data) {
  const choice = data?.choices?.[0];
  const message = choice?.message;
  const length = (s) => (typeof s === "string" ? s.length : 0);
  return {
    choices: Array.isArray(data?.choices) ? data.choices.length : 0,
    textChars: length(message?.content),
    reasoningChars: length(message?.reasoning_content || message?.reasoning),
    refusal: Boolean(message?.refusal),
    finishReason: [
      "stop",
      "length",
      "content_filter",
      "tool_calls",
      "end_turn",
      "max_tokens",
      "stop_sequence",
    ].includes(choice?.finish_reason)
      ? choice.finish_reason
      : "other",
  };
}
