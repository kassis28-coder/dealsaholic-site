export function joyLinkRetryDelayMs(response, data, fallbackMs = 60_000) {
  const headerSeconds = Number(response?.headers?.get?.("retry-after"));
  if (Number.isFinite(headerSeconds) && headerSeconds > 0) {
    return Math.ceil(headerSeconds * 1000);
  }

  const message = String(data?.error || data?.message || "");
  const match = message.match(/resets?\s+in\s+(\d+)s/i);
  if (match) return Math.max(1, Number(match[1])) * 1000;

  return fallbackMs;
}

export function isJoyLinkRateLimit(response, data) {
  return response?.status === 429 || /rate\s*limit/i.test(String(data?.error || data?.message || ""));
}
