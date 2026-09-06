import { pathToFileURL } from "node:url";
import path from "node:path";

export async function loadNativeSecrets() {
  // SillyTavern sets cwd to its server directory before loading plugins.
  const moduleUrl = pathToFileURL(
    path.resolve("src/endpoints/secrets.js"),
  ).href;
  try {
    const host = await import(moduleUrl);
    const converters = await import(
      pathToFileURL(path.resolve("src/prompt-converters.js")).href
    );
    const constants = await import(
      pathToFileURL(path.resolve("src/constants.js")).href
    );
    return {
      ...converters,
      readSecret: host.readSecret,
      safety: constants.GEMINI_SAFETY,
    };
  } catch {
    return null;
  }
}

export function nativeNode(input, directories, host) {
  if (!host?.readSecret) throw new Error("当前酒馆无法读取原生密钥接口");
  const sources = {
    custom: {
      protocol: "openai",
      key: "api_key_custom",
      url: input?.custom_url,
    },
    openai: {
      protocol: "openai",
      key: "api_key_openai",
      url: "https://api.openai.com/v1",
    },
    claude: {
      protocol: "claude",
      key: "api_key_claude",
      url: "https://api.anthropic.com/v1",
    },
    makersuite: {
      protocol: "gemini",
      key: "api_key_makersuite",
      url: "https://generativelanguage.googleapis.com",
    },
  };
  const source = sources[input?.chat_completion_source];
  if (!source)
    throw new Error("原生联动支持 Custom、OpenAI、Claude 和 Google AI Studio");
  const proxy =
    input.chat_completion_source !== "custom" && input.reverse_proxy;
  const url = new URL(proxy || source.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname === "sillytavern-failover.invalid"
  )
    throw new Error("原生 API 地址无效");
  if (
    typeof input.model !== "string" ||
    !input.model.trim() ||
    input.model.length > 200
  )
    throw new Error("原生模型不能为空或过长");
  if (input.secret_id != null && typeof input.secret_id !== "string")
    throw new Error("原生密钥 ID 无效");
  return {
    id: "__native_connection__",
    name: "酒馆原生连接",
    url: url.href.replace(/\/+$/, ""),
    model: input.model,
    stream: input.stream === true,
    key: proxy
      ? String(input.proxy_password || "")
      : host.readSecret(directories, source.key, input.secret_id ?? null) || "",
    enabled: true,
    priority: -1,
    protocol: source.protocol,
    request: structuredClone({ ...input, proxy_password: undefined }),
  };
}
