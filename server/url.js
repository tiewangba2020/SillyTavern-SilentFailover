export function completeApiUrl(value, protocol = "openai", enabled = true) {
  const url = new URL(value);
  let pathname = url.pathname.replace(/\/+$/, "");
  if (
    enabled &&
    protocol !== "gemini" &&
    !/\/v\d+(?:beta\d*|alpha\d*)?(?:\/|$)/i.test(pathname) &&
    !/\/(?:chat\/completions|messages|responses)$/.test(pathname)
  ) {
    pathname += "/v1";
  }
  url.pathname = pathname;
  return url.href.replace(/\/+$/, "");
}
