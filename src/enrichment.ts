import { OpenRouter } from '@openrouter/sdk';
import type { Tweet, Entity, Theme, Config } from './types.js';
import { ENRICHMENT_SYSTEM } from './prompts.js';
import {
  getDb,
  getUnenrichedTweets,
  markEnrichmentComplete,
  markEnrichmentFailed,
  insertEmbedding,
  insertDirectionalCall,
  getPriceData,
  getAllThemeDescriptions,
  incrementThemeCount,
  insertUnmatchedTopic,
} from './db.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface HaikuTweetResult {
  tweet_id: string;
  entities: {
    tickers: string[];
    countries: string[];
    people: string[];
    topics: string[];
  };
  topic_description?: string;
  themes: string[];
  sentiment: 'bullish' | 'bearish' | 'neutral';
  sentiment_confidence: number;
  sentiment_reasoning?: string;
  summary: string;
}

interface HaikuBatchResponse {
  tweets: HaikuTweetResult[];
}

interface BatchCost {
  haiku_input_tokens: number;
  haiku_output_tokens: number;
  openai_embedding_tokens: number;
  estimated_usd: number;
}

// ─── Cost tracking ──────────────────────────────────────────────────────────

// Approximate pricing (USD per 1M tokens)
const HAIKU_INPUT_COST_PER_M = 1.0; // $1.00 / 1M input tokens
const HAIKU_OUTPUT_COST_PER_M = 5.0; // $5.00 / 1M output tokens
const OPENAI_EMBED_COST_PER_M = 0.02; // $0.02 / 1M tokens

interface DailyCostEntry {
  date: string;
  haiku_input_tokens: number;
  haiku_output_tokens: number;
  openai_embedding_tokens: number;
  estimated_usd: number;
  batches: number;
}

const dailyCosts: Map<string, DailyCostEntry> = new Map();

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function trackCost(cost: BatchCost): void {
  const key = todayKey();
  const existing = dailyCosts.get(key) ?? {
    date: key,
    haiku_input_tokens: 0,
    haiku_output_tokens: 0,
    openai_embedding_tokens: 0,
    estimated_usd: 0,
    batches: 0,
  };

  existing.haiku_input_tokens += cost.haiku_input_tokens;
  existing.haiku_output_tokens += cost.haiku_output_tokens;
  existing.openai_embedding_tokens += cost.openai_embedding_tokens;
  existing.estimated_usd += cost.estimated_usd;
  existing.batches += 1;

  dailyCosts.set(key, existing);
}

export function getDailyCost(): DailyCostEntry {
  const key = todayKey();
  return (
    dailyCosts.get(key) ?? {
      date: key,
      haiku_input_tokens: 0,
      haiku_output_tokens: 0,
      openai_embedding_tokens: 0,
      estimated_usd: 0,
      batches: 0,
    }
  );
}

// ─── Haiku entity extraction ────────────────────────────────────────────────

async function callHaiku(
  apiKey: string,
  tweets: Tweet[],
): Promise<{ result: HaikuBatchResponse; inputTokens: number; outputTokens: number }> {
  const client = new OpenRouter({ apiKey });

  const tweetsPayload = tweets.map((t) => ({
    tweet_id: t.id,
    author: `@${t.author_handle}`,
    text: t.text,
    created_at: t.created_at,
    likes: t.engagement_likes,
    retweets: t.engagement_retweets,
  }));

  const response = await client.chat.send({
    model: 'anthropic/claude-haiku-4.5',
    maxTokens: 4096,
    messages: [
      { role: 'system' as const, content: ENRICHMENT_SYSTEM },
      {
        role: 'user' as const,
        content: `Analyze the following ${tweets.length} tweet(s) and return structured JSON:\n\n${JSON.stringify(tweetsPayload, null, 2)}`,
      },
    ],
  });

  const textContent = response.choices?.[0]?.message?.content;
  if (!textContent || typeof textContent !== 'string') {
    throw new Error('Haiku returned no text content');
  }

  // Extract JSON from the response (handle markdown code blocks)
  let jsonStr = textContent.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  const parsed = JSON.parse(jsonStr) as HaikuBatchResponse;

  return {
    result: parsed,
    inputTokens: (response.usage as any)?.prompt_tokens ?? 0,
    outputTokens: (response.usage as any)?.completion_tokens ?? 0,
  };
}

// ─── Embeddings via OpenRouter ──────────────────────────────────────────────

async function callOpenAIEmbeddings(
  apiKey: string,
  texts: string[],
): Promise<{ embeddings: number[][]; totalTokens: number }> {
  const client = new OpenRouter({ apiKey });

  const response = await client.embeddings.generate({
    model: 'openai/text-embedding-3-small',
    input: texts,
    encodingFormat: 'float',
    dimensions: 1536,
  });

  if (typeof response === 'string') {
    throw new Error('Embeddings API returned unexpected string response');
  }

  const embeddings = [...response.data]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => d.embedding as number[]);

  const totalTokens = response.usage?.totalTokens ?? 0;

  return { embeddings, totalTokens };
}

// ─── Novelty scoring ────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

function computeNoveltyScore(
  embedding: number[],
  themes: string[],
): number {
  const db = getDb();

  let maxSimilarity = 0;
  let totalExisting = 0;

  for (const theme of themes) {
    // Get the 50 most recent tweet IDs on this theme
    const themeRows = db
      .prepare(
        `SELECT tt.tweet_id
         FROM tweet_themes tt
         JOIN tweets t ON tt.tweet_id = t.id
         WHERE tt.theme = ?
         ORDER BY t.created_at DESC
         LIMIT 50`,
      )
      .all(theme) as Array<{ tweet_id: string }>;

    totalExisting += themeRows.length;

    for (const row of themeRows) {
      // Retrieve the embedding for this existing tweet
      try {
        const embRow = db
          .prepare(
            `SELECT embedding FROM tweet_embeddings WHERE tweet_id = ?`,
          )
          .get(row.tweet_id) as { embedding: Buffer } | undefined;

        if (embRow) {
          const existingEmbedding = Array.from(
            new Float32Array(
              embRow.embedding.buffer,
              embRow.embedding.byteOffset,
              embRow.embedding.byteLength / 4,
            ),
          );
          const sim = cosineSimilarity(embedding, existingEmbedding);
          if (sim > maxSimilarity) {
            maxSimilarity = sim;
          }
        }
      } catch {
        // Skip if embedding can't be read
      }
    }
  }

  // If fewer than 5 tweets exist on any of the themes, default to 1.0
  if (totalExisting < 5) {
    return 1.0;
  }

  return 1 - maxSimilarity;
}

// ─── Theme matching via embedding similarity ───────────────────────────────

// Cache: theme descriptions → embeddings (built lazily)
let themeEmbeddingCache: Map<string, number[]> | null = null;

function matchTopicToTheme(
  tweetEmbedding: number[],
  topicDescription: string,
): string | null {
  const db = getDb();

  // Build or refresh cache from theme registry
  if (!themeEmbeddingCache) {
    themeEmbeddingCache = new Map();
    const themes = getAllThemeDescriptions();
    for (const t of themes) {
      // Use the most recent tweet embedding for each theme as a proxy
      const row = db.prepare(`
        SELECT te.embedding FROM tweet_embeddings te
        JOIN tweet_themes tt ON te.tweet_id = tt.tweet_id
        WHERE tt.theme = ?
        ORDER BY te.rowid DESC LIMIT 1
      `).get(t.theme) as { embedding: Buffer } | undefined;

      if (row) {
        const emb = Array.from(new Float32Array(
          row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4,
        ));
        themeEmbeddingCache.set(t.theme, emb);
      }
    }
  }

  // Find best matching theme by cosine similarity
  let bestTheme: string | null = null;
  let bestSimilarity = 0;
  const MATCH_THRESHOLD = 0.82;

  for (const [theme, themeEmb] of themeEmbeddingCache) {
    const sim = cosineSimilarity(tweetEmbedding, themeEmb);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestTheme = theme;
    }
  }

  if (bestSimilarity >= MATCH_THRESHOLD && bestTheme) {
    return bestTheme;
  }

  return null;
}

// Invalidate cache when new themes are created
export function invalidateThemeEmbeddingCache(): void {
  themeEmbeddingCache = null;
}

// ─── Main enrichment pipeline ───────────────────────────────────────────────

export async function enrichBatch(
  apiKey: string,
  config?: Config,
): Promise<{ processed: number; failed: number }> {
  const BATCH_SIZE = 25;
  const tweets = getUnenrichedTweets(BATCH_SIZE);

  if (tweets.length === 0) {
    return { processed: 0, failed: 0 };
  }

  console.log(`[enrichment] Processing batch of ${tweets.length} tweets`);

  // Run Haiku and OpenAI calls in parallel
  const texts = tweets.map(
    (t) => `@${t.author_handle}: ${t.text}`,
  );

  const [haikuResult, embeddingResult] = await Promise.allSettled([
    callHaiku(apiKey, tweets),
    callOpenAIEmbeddings(apiKey, texts),
  ]);

  // If Haiku call failed, mark all tweets as failed
  if (haikuResult.status === 'rejected') {
    console.error(
      `[enrichment] Haiku call failed for batch:`,
      haikuResult.reason,
    );
    for (const tweet of tweets) {
      markEnrichmentFailed(tweet.id);
    }
    return { processed: 0, failed: tweets.length };
  }

  // If OpenAI embedding call failed, mark all as failed (atomic — need both)
  if (embeddingResult.status === 'rejected') {
    console.error(
      `[enrichment] OpenAI embedding call failed for batch:`,
      embeddingResult.reason,
    );
    for (const tweet of tweets) {
      markEnrichmentFailed(tweet.id);
    }
    return { processed: 0, failed: tweets.length };
  }

  // Both succeeded
  const haiku = haikuResult.value;
  const embeddings = embeddingResult.value;

  // Track cost
  const batchCost: BatchCost = {
    haiku_input_tokens: haiku.inputTokens,
    haiku_output_tokens: haiku.outputTokens,
    openai_embedding_tokens: embeddings.totalTokens,
    estimated_usd:
      (haiku.inputTokens / 1_000_000) * HAIKU_INPUT_COST_PER_M +
      (haiku.outputTokens / 1_000_000) * HAIKU_OUTPUT_COST_PER_M +
      (embeddings.totalTokens / 1_000_000) * OPENAI_EMBED_COST_PER_M,
  };
  trackCost(batchCost);
  console.log(
    `[enrichment] Batch cost: $${batchCost.estimated_usd.toFixed(6)} ` +
      `(Haiku: ${haiku.inputTokens}in/${haiku.outputTokens}out, ` +
      `OpenAI: ${embeddings.totalTokens} embed tokens)`,
  );

  // Build a lookup from tweet_id -> Haiku result
  const haikuMap = new Map<string, HaikuTweetResult>();
  for (const tr of haiku.result.tweets) {
    haikuMap.set(tr.tweet_id, tr);
  }

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < tweets.length; i++) {
    const tweet = tweets[i];
    const haikuData = haikuMap.get(tweet.id);
    const embedding = embeddings.embeddings[i];

    // If individual tweet parsing failed in the Haiku response
    if (!haikuData) {
      console.error(
        `[enrichment] No Haiku result for tweet ${tweet.id} (@${tweet.author_handle})`,
      );
      markEnrichmentFailed(tweet.id);
      failed++;
      continue;
    }

    try {
      // Validate Haiku data against allowed values (LLM trust boundary)
      const VALID_SENTIMENTS = new Set(['bullish', 'bearish', 'neutral']);

      if (
        !haikuData.sentiment ||
        !VALID_SENTIMENTS.has(haikuData.sentiment) ||
        !haikuData.themes ||
        haikuData.themes.length === 0
      ) {
        throw new Error(
          `Invalid Haiku data for tweet ${tweet.id}: missing sentiment or themes`,
        );
      }

      // ── Theme Resolution: Haiku themes + embedding-based matching ──
      // Sanitize any themes Haiku provided
      haikuData.themes = haikuData.themes
        .map(th => th.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, ''))
        .filter(th => th.length > 0);

      // If Haiku returned no themes but gave a topic_description, try to match
      // it against the theme registry using embedding similarity
      if (haikuData.themes.length === 0 && haikuData.topic_description) {
        const matched = matchTopicToTheme(embedding, haikuData.topic_description);
        if (matched) {
          haikuData.themes = [matched];
        } else {
          // No match — store for Sonnet to name later, use "unclassified" for now
          insertUnmatchedTopic(haikuData.topic_description, tweet.id);
          haikuData.themes = ['unclassified'];
        }
      } else if (haikuData.themes.length === 0) {
        haikuData.themes = ['unclassified'];
      }

      // Increment theme counts in registry
      for (const th of haikuData.themes) {
        incrementThemeCount(th);
      }

      // Compute novelty score
      const noveltyScore = computeNoveltyScore(
        embedding,
        haikuData.themes,
      );

      // Build entities
      const entities: Entity[] = [];
      for (const ticker of haikuData.entities.tickers ?? []) {
        entities.push({
          tweet_id: tweet.id,
          entity_type: 'ticker',
          entity_value: ticker,
        });
      }
      for (const country of haikuData.entities.countries ?? []) {
        entities.push({
          tweet_id: tweet.id,
          entity_type: 'country',
          entity_value: country,
        });
      }
      for (const person of haikuData.entities.people ?? []) {
        entities.push({
          tweet_id: tweet.id,
          entity_type: 'person',
          entity_value: person,
        });
      }
      for (const topic of haikuData.entities.topics ?? []) {
        entities.push({
          tweet_id: tweet.id,
          entity_type: 'topic',
          entity_value: topic,
        });
      }

      // Build themes (accept all sanitized themes — core + custom)
      if (haikuData.themes.length === 0) {
        throw new Error(`No themes for tweet ${tweet.id}`);
      }
      const themes: Theme[] = haikuData.themes.map((th) => ({
        tweet_id: tweet.id,
        theme: th,
      }));

      // Store enrichment + embedding atomically
      markEnrichmentComplete(tweet.id, {
        entities,
        themes,
        sentiment: haikuData.sentiment,
        sentiment_confidence: Math.max(0, Math.min(1, Number(haikuData.sentiment_confidence) || 0.5)),
        novelty_score: noveltyScore,
        summary: (haikuData.summary ?? '').slice(0, 120),
      });

      // Insert embedding into sqlite-vec
      try {
        insertEmbedding(tweet.id, embedding);
      } catch (embErr) {
        console.warn(
          `[enrichment] Failed to insert embedding for tweet ${tweet.id} (sqlite-vec may not be loaded):`,
          embErr,
        );
        // Don't mark as failed — enrichment data is still stored
      }

      // Detect and log directional calls for track record engine
      if (config?.track_record?.enabled && haikuData.sentiment !== 'neutral') {
        const minConf = config.track_record.min_confidence ?? 0.6;
        const confidence = Math.max(0, Math.min(1, Number(haikuData.sentiment_confidence) || 0.5));
        if (confidence >= minConf && haikuData.entities.tickers.length > 0) {
          const resolutionDays = config.track_record.resolution_days ?? 5;
          for (const ticker of haikuData.entities.tickers) {
            // Look up current price
            const today = new Date().toISOString().slice(0, 10);
            const prices = getPriceData(ticker, today, today);
            const priceAtCall = prices.length > 0 ? prices[0].close : null;

            insertDirectionalCall({
              author_id: tweet.author_id,
              author_handle: tweet.author_handle,
              tweet_id: tweet.id,
              theme: haikuData.themes[0],
              ticker,
              direction: haikuData.sentiment as 'bullish' | 'bearish',
              confidence,
              call_date: tweet.created_at,
              price_at_call: priceAtCall,
              resolution_days: resolutionDays,
              status: 'open',
            });
          }
        }
      }

      processed++;
    } catch (err) {
      console.error(
        `[enrichment] Failed to process tweet ${tweet.id} (@${tweet.author_handle}):`,
        err,
      );
      markEnrichmentFailed(tweet.id);
      failed++;
    }
  }

  console.log(
    `[enrichment] Batch complete: ${processed} processed, ${failed} failed`,
  );

  return { processed, failed };
}

// ─── Theme Discovery: Sonnet creates new themes from unmatched topics ───────

import { THEME_ARCHITECT_SYSTEM } from './prompts.js';
import {
  getRecentUnmatchedTopics,
  deleteUnmatchedTopics,
  insertThemeRegistryEntry,
} from './db.js';

/**
 * Process unmatched topic descriptions: cluster them and ask Sonnet to name
 * new themes. Called periodically (e.g., every 6 hours).
 * Only creates a theme when 3+ descriptions cluster together.
 */
export async function discoverNewThemes(apiKey: string): Promise<{ created: number; ignored: number }> {
  const unmatched = getRecentUnmatchedTopics(24); // last 24h of unmatched
  if (unmatched.length < 3) {
    return { created: 0, ignored: 0 };
  }

  const existingThemes = getAllThemeDescriptions();
  const client = new OpenRouter({ apiKey });

  const userPrompt = `EXISTING THEMES:\n${existingThemes.map(t => `- ${t.theme}: ${t.description}`).join('\n')}\n\nUNMATCHED TOPIC DESCRIPTIONS (${unmatched.length} tweets):\n${unmatched.map(u => `- "${u.topic_description}"`).join('\n')}`;

  try {
    const response = await client.chat.send({
      model: 'anthropic/claude-sonnet-4.6',
      maxTokens: 1024,
      messages: [
        { role: 'system' as const, content: THEME_ARCHITECT_SYSTEM },
        { role: 'user' as const, content: userPrompt },
      ],
    });

    const textContent = response.choices?.[0]?.message?.content;
    if (!textContent || typeof textContent !== 'string') {
      console.warn('[themes] Sonnet returned no content');
      return { created: 0, ignored: 0 };
    }

    // Parse JSON (handle markdown fences)
    let jsonStr = textContent.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    const parsed = JSON.parse(jsonStr) as {
      new_themes: Array<{ theme: string; description: string; matched_descriptions: string[] }>;
      ignored: string[];
    };

    let created = 0;
    for (const nt of parsed.new_themes) {
      const themeName = nt.theme.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      if (themeName.length > 0) {
        insertThemeRegistryEntry(themeName, nt.description, false);
        created++;
        console.log(`[themes] New theme discovered: "${themeName}" — ${nt.description}`);
      }
    }

    // Clean up processed unmatched topics
    deleteUnmatchedTopics(unmatched.map(u => u.id));

    // Invalidate embedding cache so new themes are used in matching
    invalidateThemeEmbeddingCache();

    return { created, ignored: parsed.ignored?.length ?? 0 };
  } catch (err) {
    console.error('[themes] Sonnet theme discovery failed:', err);
    return { created: 0, ignored: 0 };
  }
}
