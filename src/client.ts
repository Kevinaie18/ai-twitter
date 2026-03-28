import { OpenRouter } from '@openrouter/sdk';

let cachedClient: OpenRouter | null = null;
let cachedApiKey: string | null = null;

/**
 * Get or create an OpenRouter client. Reuses the instance if the API key
 * hasn't changed (hot-reload safe — if .env is re-read with a new key,
 * the client is recreated).
 */
export function getOpenRouterClient(apiKey: string): OpenRouter {
  if (cachedClient && cachedApiKey === apiKey) return cachedClient;
  cachedClient = new OpenRouter({ apiKey });
  cachedApiKey = apiKey;
  return cachedClient;
}
