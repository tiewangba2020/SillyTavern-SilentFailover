import http from "node:http";
export async function nativeProvider(port = 0) {
  let mode = "success";
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === "/calls") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(calls));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/control") {
      mode = JSON.parse(raw).mode;
      calls.length = 0;
      res.end("{}");
      return;
    }
    if (req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "native-test" }] }));
      return;
    }
    const body = JSON.parse(raw);
    const protocol = req.url.includes("/messages")
      ? "claude"
      : req.url.includes("/models/")
        ? "gemini"
        : "openai";
    calls.push({
      path: req.url,
      protocol,
      body,
      bearer: req.headers.authorization,
      claudeKey: req.headers["x-api-key"],
      geminiKey: req.headers["x-goog-api-key"],
      version: req.headers["anthropic-version"],
    });
    if (
      mode === "fail" ||
      (mode === "recover" && calls.length === 1) ||
      (mode === "chain" && protocol === "openai")
    ) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Native authentication failed",
            code: "invalid_api_key",
          },
        }),
      );
      return;
    }
    if (mode === "slow") {
      const timer = setTimeout(() => res.end("{}"), 120000);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    const text = "Native complete OK";
    const stream = body.stream || req.url.includes("streamGenerateContent");
    const frames =
      protocol === "claude"
        ? [
            {
              type: "message_start",
              message: { id: "claude-mock", usage: { input_tokens: 5 } },
            },
            {
              type: "content_block_delta",
              delta: { type: "text_delta", text },
            },
            { type: "message_delta", delta: { stop_reason: "end_turn" } },
            { type: "message_stop" },
          ]
        : protocol === "gemini"
          ? [
              { candidates: [{ content: { parts: [{ text }] } }] },
              {
                candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
              },
            ]
          : [
              { choices: [{ delta: { content: text } }] },
              { choices: [{ delta: {}, finish_reason: "stop" }] },
            ];
    if (stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const partial =
        mode === "partial" || (mode === "chain" && protocol === "claude");
      const selected = partial
        ? frames.slice(0, protocol === "claude" ? 2 : 1)
        : frames;
      res.end(
        selected.map((f) => "data: " + JSON.stringify(f) + "\n\n").join("") +
          (!partial && protocol === "openai" ? "data: [DONE]\n\n" : ""),
      );
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        protocol === "claude"
          ? { content: [{ type: "text", text }], stop_reason: "end_turn" }
          : protocol === "gemini"
            ? {
                candidates: [
                  { content: { parts: [{ text }] }, finishReason: "STOP" },
                ],
              }
            : {
                choices: [
                  { message: { content: text }, finish_reason: "stop" },
                ],
              },
      ),
    );
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
if (process.argv.includes("--serve"))
  console.log((await nativeProvider(9108)).url);
