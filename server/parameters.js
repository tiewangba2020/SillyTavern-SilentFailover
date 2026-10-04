// Google rolls the "no prefilled model turn" rule out model by model instead of by
// major version. Verified so far: gemini-3.5-flash-lite, gemini-3.6-flash,
// gemini-3.7-flash and gemini-3.8-flash reject a trailing model turn, while pro and
// older models (for example gemini-3.1-pro) still accept it as a prefill. The host
// only rewrites a fixed list of older models, and not at all for OpenAI-compatible
// relays that forward to Gemini themselves, so the check lives here.
const NO_PREFILL_MODEL = /gemini-(\d+)\.(\d+)(?:[.-][a-z0-9.-]*)?-(flash|lite)/i;
export function rejectsTrailingModelTurn(model) {
  const found = NO_PREFILL_MODEL.exec(String(model || ""));
  if (!found) return false;
  const major = Number(found[1]);
  if (major !== 3) return major > 3;
  const minor = Number(found[2]);
  return minor > 5 || (minor === 5 && found[3].toLowerCase() === "lite");
}
export function adaptParameters(node, input) {
  const payload = structuredClone(input);
  const adjustments = [];
  const change = (parameter, value, reason) => {
    if (payload[parameter] === value) return;
    adjustments.push({
      parameter,
      from: payload[parameter] ?? null,
      to: value,
      reason,
    });
    payload[parameter] = value;
  };
  const claude =
    node.protocol === "claude" ||
    /(?:^|[\/\]】\s])claude-/i.test(node.model || "");
  if (
    claude &&
    Number.isFinite(payload.temperature) &&
    (payload.temperature > 1 || payload.temperature < 0)
  )
    change(
      "temperature",
      Math.max(0, Math.min(1, payload.temperature)),
      "Claude 温度范围为 0 到 1",
    );
  if (
    rejectsTrailingModelTurn(node.model) &&
    Array.isArray(payload.messages) &&
    payload.messages.at(-1)?.role === "assistant"
  ) {
    payload.messages[payload.messages.length - 1].role = "user";
    adjustments.push({
      parameter: "trailing_model_turn",
      from: "assistant",
      to: "user",
      reason: "该 Gemini 模型不接受以模型轮结尾的请求",
    });
  }
  return { payload, adjustments };
}
