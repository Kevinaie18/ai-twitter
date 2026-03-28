/**
 * Sanitize error for logging — strips auth tokens, cookies, API keys.
 * Truncates stack traces to 5 frames.
 */
export function sanitizeError(err: unknown): string {
  const raw = err instanceof Error
    ? `${err.message}\n${err.stack ?? ''}`
    : String(err);

  let cleaned = raw
    // Strip Bearer tokens
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [REDACTED]')
    // Strip API keys, auth headers, cookies
    .replace(/(?:api[_-]?key|authorization|cookie|x-api-key|ct0|auth_token)[=:]\s*[^\s,;'"\n]+/gi, '$1=[REDACTED]')
    // Strip base64-looking long tokens (40+ chars)
    .replace(/[A-Za-z0-9+/=]{40,}/g, '[TOKEN_REDACTED]');

  // Truncate stack trace to first 5 frames
  const lines = cleaned.split('\n');
  const stackStart = lines.findIndex(l => l.trimStart().startsWith('at '));
  if (stackStart >= 0 && lines.length > stackStart + 5) {
    cleaned = [...lines.slice(0, stackStart + 5), '    ... (truncated)'].join('\n');
  }

  return cleaned;
}

/**
 * Parse an integer safely with bounds. Returns fallback on NaN or out-of-range.
 */
export function safeInt(val: string | undefined, fallback: number, max: number = 10000): number {
  if (!val) return fallback;
  const n = parseInt(val, 10);
  if (isNaN(n) || n < 0) return fallback;
  return Math.min(n, max);
}

/**
 * Extract JSON from LLM output. Handles:
 * - Raw JSON
 * - JSON wrapped in ```json ... ``` fences
 * - JSON wrapped in ``` ... ``` fences (no language tag)
 * Returns the parsed object, or throws if unparseable.
 */
export function extractJsonFromLlm<T = unknown>(text: string): T {
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }
  return JSON.parse(jsonStr) as T;
}
