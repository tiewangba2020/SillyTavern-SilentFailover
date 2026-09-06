import { test, expect, vi } from "vitest";
import { listModels } from "../../server/models.js";
import { Store } from "../../server/store.js";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
test("draft validation preserves saved keys without committing edited nodes", () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "sf-draft-"));
  try {
    const s = new Store(root);
    s.save({ nodes: [{ id: "one", name: "saved", model: "saved", url: "https://example.com/v1", key: "test-private-key" }] });
    const before = fs.readFileSync(s.file, "utf8");
    const node = s.previewNode({ ...s.publicConfig().nodes[0], model: "draft" });
    expect(node.key).toBe("test-private-key");
    expect(node.model).toBe("draft");
    expect(fs.readFileSync(s.file, "utf8")).toBe(before);
    expect(() => s.validate({ ...s.publicConfig(), maxRounds: 1.5 })).toThrow("整数");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("native model pagination filters Gemini methods and keeps key out of URLs/results", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", async (url, options) => {
    expect(String(url)).not.toContain("test-private-key");
    expect(new URL(url).pathname).toBe("/v1beta/models");
    expect(options.headers["x-goog-api-key"]).toBe("test-private-key");
    calls++;
    return Response.json(calls === 1 ? { models: [{ name: "models/text-one", supportedGenerationMethods: ["generateContent"] }, { name: "models/embed", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "page2" } : { models: [{ name: "models/text-two", supportedGenerationMethods: ["generateContent"] }] });
  });
  try {
    const result = await listModels({ url: "https://example.com", protocol: "gemini", key: "test-private-key" }, new AbortController().signal);
    expect(result.models).toEqual(["text-one", "text-two"]);
    expect(calls).toBe(2);
  } finally { vi.unstubAllGlobals(); }
});
test("OpenAI and Claude models use their correct authentication headers", async () => {
  for (const protocol of ["openai", "claude"]) {
    vi.stubGlobal("fetch", async (url, options) => {
      expect(String(url)).toBe("https://example.com/v1/models");
      expect(options.headers[protocol === "openai" ? "Authorization" : "x-api-key"]).toBe(protocol === "openai" ? "Bearer test-private-key" : "test-private-key");
      return Response.json({ data: [{ id: "one" }, { id: "one" }, { id: "two" }] });
    });
    try { expect((await listModels({ protocol, url: "https://example.com/v1", key: "test-private-key" }, new AbortController().signal)).models).toEqual(["one", "two"]); }
    finally { vi.unstubAllGlobals(); }
  }
});
