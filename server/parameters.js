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
  return { payload, adjustments };
}
