import { test, expect } from "vitest";
import { completeApiUrl } from "../../server/url.js";
import { Store, DEFAULTS } from "../../server/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("URL completion preserves versioned/native/full endpoints and is optional", () => {
  for (const protocol of ["openai", "claude"])
    expect(completeApiUrl("https://example.com/proxy/", protocol)).toBe(
      "https://example.com/proxy/v1",
    );
  for (const suffix of [
    "/v1",
    "/proxy/v1",
    "/v1beta",
    "/v2",
    "/chat/completions",
    "/v1/messages",
    "/proxy/v1/chat/completions",
  ])
    expect(completeApiUrl("https://example.com" + suffix)).toBe(
      "https://example.com" + suffix,
    );
  expect(completeApiUrl("https://example.com", "gemini")).toBe(
    "https://example.com",
  );
  expect(completeApiUrl("https://example.com/proxy", "openai", false)).toBe(
    "https://example.com/proxy",
  );
});

test("new config defaults to native first, draft URL policy is respected and old output caps are removed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-url-"));
  try {
    const store = new Store(dir);
    expect(DEFAULTS.nativeFirst).toBe(true);
    const node = {
      id: "n",
      name: "A",
      model: "m",
      url: "https://example.com",
      key: "test",
      maxTokens: 12,
    };
    expect(store.previewNode(node, false, { autoCompleteUrl: false }).url).toBe(
      "https://example.com",
    );
    expect(store.previewNode(node).url).toBe("https://example.com/v1");
    store.save({ ...store.publicConfig(), nodes: [node] });
    expect(store.config.nodes[0]).not.toHaveProperty("maxTokens");
    expect(store.config.nativeFirst).toBe(true);
    store.save({ ...store.publicConfig(), nativeFirst: false });
    expect(new Store(dir).config.nativeFirst).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
