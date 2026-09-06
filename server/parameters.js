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
  if (Number.isInteger(node.maxTokens) && node.maxTokens > 0) {
    const fields = ["max_tokens", "max_completion_tokens"].filter(
      (k) => payload[k] != null,
    );
    if (!fields.length) fields.push("max_tokens");
    for (const key of fields) {
      const value = payload[key];
      if (value == null || value > node.maxTokens)
        change(key, node.maxTokens, "节点输出上限");
    }
  }
  return { payload, adjustments };
}
