import { Bot } from 'grammy';
import { OpenRouter } from '@openrouter/sdk';
import {
  getDb,
  searchSimilar,
  searchTweetsFTS,
  getLatestConsensusForAllThemes,
  getConsensusSnapshots,
  getTweetsByTheme,
  getAccountStats,
  getScrapeHealth,
  getUnenrichedTweets,
  getAuthorTrackRecord,
} from './db.js';
import type { ConsensusSnapshot } from './types.js';
import { getDailyCost } from './enrichment.js';

// ─── Telegram Helpers ────────────────────────────────────────────────────────

const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Escape special characters for Telegram MarkdownV2.
 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Split a long message at paragraph boundaries respecting Telegram's 4096 char limit.
 * Falls back to hard splits if a single paragraph exceeds the limit.
 */
function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split('\n\n');
  let current = '';

  for (const para of paragraphs) {
    // If adding this paragraph would exceed the limit, flush current
    if (current.length > 0 && current.length + 2 + para.length > TELEGRAM_MAX_LENGTH) {
      chunks.push(current);
      current = '';
    }

    // If a single paragraph exceeds the limit, hard-split it
    if (para.length > TELEGRAM_MAX_LENGTH) {
      if (current.length > 0) {
        chunks.push(current);
        current = '';
      }
      let remaining = para;
      while (remaining.length > TELEGRAM_MAX_LENGTH) {
        // Try to split at a newline within the limit
        let splitIdx = remaining.lastIndexOf('\n', TELEGRAM_MAX_LENGTH);
        if (splitIdx === -1 || splitIdx < TELEGRAM_MAX_LENGTH / 2) {
          // Fall back to splitting at last space within limit
          splitIdx = remaining.lastIndexOf(' ', TELEGRAM_MAX_LENGTH);
        }
        if (splitIdx === -1 || splitIdx < TELEGRAM_MAX_LENGTH / 2) {
          splitIdx = TELEGRAM_MAX_LENGTH;
        }
        chunks.push(remaining.slice(0, splitIdx));
        remaining = remaining.slice(splitIdx).trimStart();
      }
      if (remaining.length > 0) {
        current = remaining;
      }
    } else {
      current = current.length > 0 ? current + '\n\n' + para : para;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Send a potentially long message, splitting across multiple messages if needed.
 */
async function sendLongMessage(bot: Bot, chatId: string, text: string, parseMode?: 'MarkdownV2' | 'HTML', replyToMessageId?: number): Promise<void> {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const opts: Record<string, any> = {};
    if (parseMode) opts.parse_mode = parseMode;
    // Only reply to the message for the first chunk
    if (i === 0 && replyToMessageId) opts.reply_to_message_id = replyToMessageId;
    try {
      await bot.api.sendMessage(chatId, chunks[i], Object.keys(opts).length > 0 ? opts : undefined);
    } catch (err) {
      if (parseMode) {
        const fallbackOpts: Record<string, any> = {};
        if (i === 0 && replyToMessageId) fallbackOpts.reply_to_message_id = replyToMessageId;
        await bot.api.sendMessage(chatId, chunks[i], Object.keys(fallbackOpts).length > 0 ? fallbackOpts : undefined);
      } else {
        throw err;
      }
    }
  }
}

// ─── Push Functions ──────────────────────────────────────────────────────────

/**
 * Send a formatted digest message to a chat. Supports split format (TL;DR + deep dive as reply).
 */
export async function sendDigest(bot: Bot, chatId: string, digest: string | import('./types.js').DigestResult): Promise<void> {
  if (typeof digest === 'string') {
    await sendLongMessage(bot, chatId, digest);
    return;
  }

  if (digest.tldr) {
    // Send TL;DR first, then full digest as threaded reply
    const tldrMsg = await bot.api.sendMessage(chatId, digest.tldr);
    await sendLongMessage(bot, chatId, digest.text, undefined, tldrMsg.message_id);
  } else {
    await sendLongMessage(bot, chatId, digest.text);
  }
}

/**
 * Send a consensus/health alert to a chat.
 */
export async function sendAlert(bot: Bot, chatId: string, alertText: string): Promise<void> {
  await sendLongMessage(bot, chatId, alertText);
}

// ─── Semantic Search for /ask ────────────────────────────────────────────────

function createClient(apiKey: string): OpenRouter {
  return new OpenRouter({ apiKey });
}

async function embedQuery(apiKey: string, query: string): Promise<number[]> {
  const client = createClient(apiKey);
  const response = await client.embeddings.generate({
    model: 'openai/text-embedding-3-small',
    input: query,
    encodingFormat: 'float',
    dimensions: 1536,
  });
  if (typeof response === 'string') {
    throw new Error('Embeddings API returned unexpected string response');
  }
  return response.data[0].embedding as number[];
}

async function askSonnet(
  apiKey: string,
  query: string,
  tweets: any[],
): Promise<string> {
  const client = createClient(apiKey);

  const tweetContext = tweets
    .map((tw, i) => {
      const date = tw.created_at ? tw.created_at.slice(0, 10) : 'unknown';
      return `[${i + 1}] @${tw.author_handle} (${date}): ${tw.text}`;
    })
    .join('\n\n');

  const response = await client.chat.send({
    model: 'anthropic/claude-sonnet-4.6',
    maxTokens: 1024,
    messages: [
      { role: 'system' as const, content: `You are a financial intelligence assistant. Answer the user's question based ONLY on the provided tweets. Be concise and specific. Cite sources using @handle references. If the tweets don't contain enough information to answer, say so clearly.` },
      {
        role: 'user' as const,
        content: `Question: ${query}\n\nHere are the ${tweets.length} most relevant tweets from our database:\n\n${tweetContext}\n\nProvide a concise, specific answer with @handle citations.`,
      },
    ],
  });

  const textContent = response.choices?.[0]?.message?.content;
  if (!textContent) {
    throw new Error('Sonnet returned no text content');
  }

  return String(textContent).trim();
}

async function synthesizeWithHaiku(
  apiKey: string,
  systemPrompt: string,
  data: string,
): Promise<string | null> {
  if (!apiKey) return null;
  try {
    const client = createClient(apiKey);
    const response = await client.chat.send({
      model: 'anthropic/claude-haiku-4.5',
      maxTokens: 512,
      messages: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: data },
      ],
    });
    const content = response.choices?.[0]?.message?.content;
    if (!content) return null;
    return String(content).trim();
  } catch (err) {
    console.warn('[bot] Haiku synthesis failed:', err);
    return null;
  }
}

function getTweetsByIds(tweetIds: string[]): any[] {
  const db = getDb();
  if (tweetIds.length === 0) return [];
  const placeholders = tweetIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT t.*, e.sentiment, e.summary
       FROM tweets t
       LEFT JOIN enrichments e ON t.id = e.tweet_id
       WHERE t.id IN (${placeholders})`,
    )
    .all(...tweetIds);
}

// ─── Bot Creation ────────────────────────────────────────────────────────────

/**
 * Create and configure the Telegram bot with all commands registered.
 * The bot is NOT started — call bot.start() from the orchestrator.
 */
export function createBot(token: string, env: Record<string, string>): Bot {
  const bot = new Bot(token);

  // Register commands in Telegram's menu (the / autocomplete list)
  bot.api.setMyCommands([
    { command: 'ask', description: 'Search tweets and get AI answers' },
    { command: 'consensus', description: 'View consensus for all themes' },
    { command: 'theme', description: 'Deep dive on a theme' },
    { command: 'who', description: 'Account summary and track record' },
    { command: 'compare', description: 'Cross-list divergence' },
    { command: 'status', description: 'System health and API costs' },
  ]).catch(err => console.warn('[bot] Failed to set command menu:', err));

  const openrouterKey = env.OPENROUTER_API_KEY ?? '';

  // ─── /ask <query> ───────────────────────────────────────────────────────────

  bot.command('ask', async (ctx) => {
    const query = ctx.match;
    if (!query || query.trim().length === 0) {
      await ctx.reply('Usage: /ask <your question>\n\nExample: /ask What is the sentiment on NVDA today?');
      return;
    }

    await ctx.reply('Searching...');

    try {
      let tweets: any[] = [];
      let searchMethod = 'semantic';

      // Try semantic search first via OpenAI embedding + sqlite-vec
      try {
        if (!openrouterKey) throw new Error('No OpenRouter API key configured');
        const queryEmbedding = await embedQuery(openrouterKey, query.trim());
        const similar = searchSimilar(queryEmbedding, 20);

        if (similar.length > 0) {
          const tweetIds = similar.map((s) => s.tweet_id);
          tweets = getTweetsByIds(tweetIds);
        }
      } catch (embErr) {
        console.warn('[bot /ask] Embedding search failed, falling back to FTS:', embErr);
        searchMethod = 'keyword';
      }

      // Fallback to FTS5 keyword search
      if (tweets.length === 0) {
        searchMethod = 'keyword';
        // Clean query for FTS5: remove special chars that break FTS syntax
        const ftsQuery = query.trim().replace(/['"():*^~]/g, ' ').trim();
        if (ftsQuery.length > 0) {
          tweets = searchTweetsFTS(ftsQuery, 20);
        }
      }

      if (tweets.length === 0) {
        await ctx.reply('No relevant tweets found for your query. Try different keywords.');
        return;
      }

      // Call Sonnet to synthesize an answer
      if (!openrouterKey) {
        // No OpenRouter key — return raw results
        const lines = tweets.slice(0, 10).map(
          (tw: any) =>
            `@${tw.author_handle} (${tw.created_at?.slice(0, 10) ?? ''}): ${tw.text.slice(0, 200)}`,
        );
        await sendLongMessage(
          bot,
          ctx.chat.id.toString(),
          `Found ${tweets.length} tweets (${searchMethod} search). No OpenRouter API key — showing raw results:\n\n${lines.join('\n\n')}`,
        );
        return;
      }

      const answer = await askSonnet(openrouterKey, query.trim(), tweets);
      const header = `Search: ${searchMethod} | ${tweets.length} tweets analyzed\n\n`;
      await sendLongMessage(bot, ctx.chat.id.toString(), header + answer);
    } catch (err) {
      console.error('[bot /ask] Error:', err);
      await ctx.reply('An error occurred while processing your question. Please try again.');
    }
  });

  // ─── /consensus ─────────────────────────────────────────────────────────────

  bot.command('consensus', async (ctx) => {
    try {
      const db = getDb();

      // Get all active list IDs
      const lists = db
        .prepare(`SELECT list_id, name FROM list_configs WHERE active = 1`)
        .all() as Array<{ list_id: string; name: string }>;

      if (lists.length === 0) {
        await ctx.reply('No active lists configured.');
        return;
      }

      const sections: string[] = [];

      for (const list of lists) {
        const snapshots = getLatestConsensusForAllThemes(list.list_id);

        if (snapshots.length === 0) {
          sections.push(`${list.name}: Need more data — consensus available after 24h of scraping.`);
          continue;
        }

        const lines: string[] = [`${list.name}:`];

        for (const snap of snapshots as ConsensusSnapshot[]) {
          // Get 7d rolling average for comparison
          const historicalRows = db
            .prepare(
              `SELECT AVG(consensus_pct) AS avg_pct
               FROM consensus_snapshots
               WHERE list_id = ? AND theme = ?
                 AND snapshot_at >= datetime('now', '-7 days')`,
            )
            .get(list.list_id, snap.theme) as { avg_pct: number | null };

          const avg7d = historicalRows?.avg_pct ?? snap.consensus_pct;
          const diff = snap.consensus_pct - avg7d;
          const arrow = diff > 2 ? '\u25B2' : diff < -2 ? '\u25BC' : '\u2014';

          lines.push(
            `  ${snap.theme}: ${snap.consensus_direction} (${snap.consensus_pct.toFixed(0)}%) ${arrow} vs 7d avg`,
          );
        }

        sections.push(lines.join('\n'));
      }

      const header = 'CONSENSUS MAP\n\n';
      await sendLongMessage(bot, ctx.chat.id.toString(), header + sections.join('\n\n'));
    } catch (err) {
      console.error('[bot /consensus] Error:', err);
      await ctx.reply('Failed to retrieve consensus data.');
    }
  });

  // ─── /theme <name> ──────────────────────────────────────────────────────────

  bot.command('theme', async (ctx) => {
    const themeName = ctx.match?.trim().toLowerCase();
    if (!themeName) {
      await ctx.reply('Usage: /theme <name>\n\nExample: /theme semis');
      return;
    }

    try {
      const db = getDb();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      // Sentiment trend: last 7 days of consensus snapshots
      const lists = db
        .prepare(`SELECT list_id, name FROM list_configs WHERE active = 1`)
        .all() as Array<{ list_id: string; name: string }>;

      const sections: string[] = [`THEME DEEP DIVE: ${themeName.toUpperCase()}\n`];

      for (const list of lists) {
        // Consensus trend
        const snapshots = getConsensusSnapshots(list.list_id, themeName, 7);

        if (snapshots.length > 0) {
          sections.push(`Sentiment Trend (${list.name}, 7d):`);
          for (const snap of snapshots.slice(0, 7)) {
            const date = snap.snapshot_at?.slice(0, 10) ?? '';
            sections.push(
              `  ${date}: ${snap.consensus_direction} ${snap.consensus_pct.toFixed(0)}% (${snap.bullish_count}B/${snap.bearish_count}b/${snap.neutral_count}N)`,
            );
          }
          sections.push('');
        }

        // Top tweets by engagement
        const tweets = getTweetsByTheme(themeName, sevenDaysAgo, list.list_id);

        if (tweets.length > 0) {
          const sorted = [...tweets].sort(
            (a: any, b: any) =>
              (b.engagement_likes + b.engagement_retweets + b.engagement_replies) -
              (a.engagement_likes + a.engagement_retweets + a.engagement_replies),
          );

          sections.push(`Top Tweets (${list.name}):`);
          for (const tw of sorted.slice(0, 5)) {
            const eng = tw.engagement_likes + tw.engagement_retweets + tw.engagement_replies;
            const sentiment = tw.sentiment ? ` [${tw.sentiment}]` : '';
            sections.push(
              `  @${tw.author_handle}${sentiment} (${eng} eng): ${tw.text.slice(0, 150)}`,
            );
          }
          sections.push('');

          // Key accounts posting on this theme
          const accountCounts = new Map<string, { handle: string; count: number }>();
          for (const tw of tweets) {
            const existing = accountCounts.get(tw.author_id) ?? { handle: tw.author_handle, count: 0 };
            existing.count++;
            accountCounts.set(tw.author_id, existing);
          }

          const topAccounts = [...accountCounts.values()]
            .sort((a, b) => b.count - a.count)
            .slice(0, 8);

          if (topAccounts.length > 0) {
            sections.push(`Key Accounts (${list.name}):`);
            for (const acct of topAccounts) {
              sections.push(`  @${acct.handle}: ${acct.count} tweets`);
            }
            sections.push('');
          }
        } else {
          sections.push(`No tweets found for theme "${themeName}" in ${list.name} (last 7d).`);
          sections.push('');
        }
      }

      const rawData = sections.join('\n');

      // AI synthesis: summarize the theme data into actionable intelligence
      const synthesis = await synthesizeWithHaiku(
        openrouterKey,
        `You are a financial intelligence analyst. Summarize this theme data into 3-4 sentences of actionable intelligence. Focus on: what the consensus is, who the key voices are, what's the debate, and what to watch next. Be concise and specific. Use @handles.`,
        rawData,
      );

      if (synthesis) {
        await sendLongMessage(bot, ctx.chat.id.toString(), `${synthesis}\n\n---\n\n${rawData}`);
      } else {
        await sendLongMessage(bot, ctx.chat.id.toString(), rawData);
      }
    } catch (err) {
      console.error('[bot /theme] Error:', err);
      await ctx.reply('Failed to retrieve theme data.');
    }
  });

  // ─── /who <handle> ──────────────────────────────────────────────────────────

  bot.command('who', async (ctx) => {
    const handle = ctx.match?.trim().replace(/^@/, '');
    if (!handle) {
      await ctx.reply('Usage: /who <handle>\n\nExample: /who elonmusk');
      return;
    }

    try {
      const db = getDb();

      // Look up author_id by handle
      const account = db
        .prepare(`SELECT * FROM accounts WHERE author_handle = ? COLLATE NOCASE`)
        .get(handle) as any;

      if (!account) {
        await ctx.reply(`Account @${handle} not found in our database.`);
        return;
      }

      const stats = getAccountStats(account.author_id);
      if (!stats) {
        await ctx.reply(`No stats available for @${handle}.`);
        return;
      }

      const lines: string[] = [];
      const credTag = account.credibility_tag && account.credibility_tag !== 'unverified'
        ? ` [${account.credibility_tag}]`
        : '';
      lines.push(`ACCOUNT: @${stats.author_handle} (${stats.author_name})${credTag}`);
      lines.push(`Followers: ${stats.follower_count.toLocaleString()}`);
      lines.push(`Total tweets tracked: ${stats.tweet_count}`);
      lines.push(`First seen: ${stats.first_seen_at?.slice(0, 10) ?? 'N/A'}`);
      lines.push(`Last seen: ${stats.last_seen_at?.slice(0, 10) ?? 'N/A'}`);
      lines.push('');

      // Themes
      if (stats.top_themes && stats.top_themes.length > 0) {
        lines.push('Top Themes:');
        for (const th of stats.top_themes) {
          lines.push(`  ${th.theme}: ${th.count} tweets`);
        }
        lines.push('');
      }

      // Sentiment lean
      if (stats.sentiment_lean && stats.sentiment_lean.length > 0) {
        lines.push('Sentiment Lean:');
        const total = stats.sentiment_lean.reduce((s: number, r: any) => s + r.count, 0);
        for (const sl of stats.sentiment_lean) {
          const pct = total > 0 ? ((sl.count / total) * 100).toFixed(0) : '0';
          lines.push(`  ${sl.sentiment}: ${sl.count} (${pct}%)`);
        }
        lines.push('');
      }

      // Track record
      const trackRecord = getAuthorTrackRecord(account.author_id);
      if (trackRecord && trackRecord.resolved_calls > 0) {
        lines.push('Track Record:');
        lines.push(`  Total calls: ${trackRecord.total_calls}`);
        lines.push(`  Resolved: ${trackRecord.resolved_calls} (${(trackRecord.hit_rate * 100).toFixed(0)}% hit rate)`);
        lines.push(`  Hits: ${trackRecord.hits} | Misses: ${trackRecord.misses}`);
        lines.push('');
      }

      // Recent tweets
      const recentTweets = db
        .prepare(
          `SELECT t.*, e.sentiment
           FROM tweets t
           LEFT JOIN enrichments e ON t.id = e.tweet_id
           WHERE t.author_id = ?
           ORDER BY t.created_at DESC
           LIMIT 5`,
        )
        .all(account.author_id) as any[];

      if (recentTweets.length > 0) {
        lines.push('Recent Tweets:');
        for (const tw of recentTweets) {
          const sentiment = tw.sentiment ? ` [${tw.sentiment}]` : '';
          const date = tw.created_at?.slice(0, 10) ?? '';
          lines.push(`  ${date}${sentiment}: ${tw.text.slice(0, 150)}`);
        }
      }

      const rawData = lines.join('\n');

      // AI synthesis: characterize this account in 2-3 sentences
      const synthesis = await synthesizeWithHaiku(
        openrouterKey,
        `You are a financial intelligence analyst. Based on this account profile, write a 2-3 sentence characterization: what kind of voice is this person (macro trader, sector specialist, news aggregator, contrarian), what's their typical conviction level, and how reliable are they based on the data. Be direct and specific.`,
        rawData,
      );

      if (synthesis) {
        await sendLongMessage(bot, ctx.chat.id.toString(), `${synthesis}\n\n---\n\n${rawData}`);
      } else {
        await sendLongMessage(bot, ctx.chat.id.toString(), rawData);
      }
    } catch (err) {
      console.error('[bot /who] Error:', err);
      await ctx.reply('Failed to retrieve account data.');
    }
  });

  // ─── /compare ───────────────────────────────────────────────────────────────

  bot.command('compare', async (ctx) => {
    try {
      const db = getDb();

      const lists = db
        .prepare(`SELECT list_id, name FROM list_configs WHERE active = 1`)
        .all() as Array<{ list_id: string; name: string }>;

      if (lists.length < 2) {
        await ctx.reply('Cross-list comparison requires 2+ active lists.');
        return;
      }

      // Get latest consensus for each list
      const listConsensus = new Map<string, Map<string, ConsensusSnapshot>>();
      const listNames = new Map<string, string>();

      for (const list of lists) {
        listNames.set(list.list_id, list.name);
        const snapshots = getLatestConsensusForAllThemes(list.list_id);
        const themeMap = new Map<string, ConsensusSnapshot>();
        for (const snap of snapshots as ConsensusSnapshot[]) {
          themeMap.set(snap.theme, snap);
        }
        listConsensus.set(list.list_id, themeMap);
      }

      // Find themes present in 2+ lists with different consensus directions
      const allThemes = new Set<string>();
      for (const [, themeMap] of listConsensus) {
        for (const theme of themeMap.keys()) {
          allThemes.add(theme);
        }
      }

      const divergences: string[] = [];

      for (const theme of allThemes) {
        const listDirections: Array<{ listName: string; direction: string; pct: number }> = [];

        for (const [listId, themeMap] of listConsensus) {
          const snap = themeMap.get(theme);
          if (snap) {
            listDirections.push({
              listName: listNames.get(listId) ?? listId,
              direction: snap.consensus_direction,
              pct: snap.consensus_pct,
            });
          }
        }

        // Need 2+ lists with this theme
        if (listDirections.length < 2) continue;

        // Check if directions diverge
        const directions = new Set(listDirections.map((d) => d.direction));
        if (directions.size > 1) {
          const details = listDirections
            .map((d) => `${d.listName}: ${d.direction} (${d.pct.toFixed(0)}%)`)
            .join(' vs ');
          divergences.push(`  ${theme}: ${details}`);
        }
      }

      if (divergences.length === 0) {
        await ctx.reply(
          'CROSS-LIST COMPARISON\n\nNo divergences found — all active lists agree on consensus directions for shared themes.',
        );
        return;
      }

      const header = `CROSS-LIST DIVERGENCE\n\nThemes where lists disagree:\n\n`;
      await sendLongMessage(bot, ctx.chat.id.toString(), header + divergences.join('\n'));
    } catch (err) {
      console.error('[bot /compare] Error:', err);
      await ctx.reply('Failed to run cross-list comparison.');
    }
  });

  // ─── /status ────────────────────────────────────────────────────────────────

  bot.command('status', async (ctx) => {
    try {
      const db = getDb();
      const lines: string[] = ['SYSTEM STATUS\n'];

      // Scraper health per list
      const health = getScrapeHealth();
      const lists = db
        .prepare(`SELECT list_id, name FROM list_configs WHERE active = 1`)
        .all() as Array<{ list_id: string; name: string }>;

      const healthMap = new Map(health.map((h) => [h.list_id, h.tweet_count]));

      lines.push('Scraper Status (last 2h):');
      if (lists.length === 0) {
        lines.push('  No active lists configured.');
      } else {
        for (const list of lists) {
          const count = healthMap.get(list.list_id) ?? 0;
          const status = count > 0 ? `${count} tweets scraped` : 'NO DATA (check scraper)';
          lines.push(`  ${list.name}: ${status}`);
        }
      }
      lines.push('');

      // Enrichment queue
      const pending = getUnenrichedTweets(1);
      const pendingCount = db
        .prepare(
          `SELECT COUNT(*) AS cnt
           FROM tweets t
           LEFT JOIN enrichments e ON t.id = e.tweet_id
           WHERE e.tweet_id IS NULL OR e.status = 'failed'`,
        )
        .get() as { cnt: number };
      lines.push(`Enrichment Queue: ${pendingCount.cnt} tweets pending`);

      // Total tweets and enrichments
      const totalTweets = db.prepare(`SELECT COUNT(*) AS cnt FROM tweets`).get() as { cnt: number };
      const totalEnriched = db
        .prepare(`SELECT COUNT(*) AS cnt FROM enrichments WHERE status = 'complete'`)
        .get() as { cnt: number };
      lines.push(`Total Tweets: ${totalTweets.cnt}`);
      lines.push(`Enriched: ${totalEnriched.cnt}`);
      lines.push('');

      // Last digest time (approximate from consensus snapshots)
      const lastSnapshot = db
        .prepare(`SELECT MAX(snapshot_at) AS last_at FROM consensus_snapshots`)
        .get() as { last_at: string | null };
      lines.push(
        `Last Consensus Snapshot: ${lastSnapshot.last_at?.slice(0, 19).replace('T', ' ') ?? 'None'}`,
      );

      // Daily API cost
      const cost = getDailyCost();
      lines.push('');
      lines.push(`Daily API Cost (${cost.date}):`);
      lines.push(`  Estimated: $${cost.estimated_usd.toFixed(4)}`);
      lines.push(`  Haiku tokens: ${cost.haiku_input_tokens} in / ${cost.haiku_output_tokens} out`);
      lines.push(`  OpenAI embed tokens: ${cost.openai_embedding_tokens}`);
      lines.push(`  Batches processed: ${cost.batches}`);

      await sendLongMessage(bot, ctx.chat.id.toString(), lines.join('\n'));
    } catch (err) {
      console.error('[bot /status] Error:', err);
      await ctx.reply('Failed to retrieve system status.');
    }
  });

  // ─── Default handler for unknown commands ───────────────────────────────────

  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) {
      await ctx.reply(
        'Unknown command. Available commands:\n' +
          '/ask <query> — Search tweets and get AI-synthesized answers\n' +
          '/consensus — View consensus for all themes\n' +
          '/theme <name> — Deep dive on a theme\n' +
          '/who <handle> — Account summary\n' +
          '/compare — Cross-list divergence\n' +
          '/status — System health',
      );
    }
  });

  return bot;
}
