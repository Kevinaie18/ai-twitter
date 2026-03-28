import { schedule, ScheduledTask } from 'node-cron';
import { Bot } from 'grammy';
import { loadConfig, loadEnv, getRequiredEnv } from './config.js';
import { initDb, getDb, getLastScrapedTweetId, insertTweets, upsertAccount, syncCredibilityTags, syncListConfigs, seedThemeRegistry, getLastDigestSnapshot } from './db.js';
import { scrapeList } from './scraper.js';
import { enrichBatch, discoverNewThemes } from './enrichment.js';
import { generateDigest } from './digest.js';
import { createBot, sendDigest, sendAlert } from './bot.js';
import { createDashboard } from './dashboard/index.js';
import { resolveOpenCalls, setThemeTickerOverrides } from './intelligence.js';
import type { Config } from './types.js';
import { sanitizeError } from './utils.js';

// ─── Shutdown coordination ───────────────────────────────────────────────────
let shuttingDown = false;
const cronTasks: ScheduledTask[] = [];

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', String(err));
  // Don't exit — systemd will restart if needed
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', String(reason));
});

async function main() {
  console.log('[init] Twitter Intel Digest starting...');

  const config = loadConfig();
  const env = loadEnv();

  // Init database
  initDb('data/intel.db');
  syncListConfigs(config);
  syncCredibilityTags(config);
  seedThemeRegistry();
  if (config.theme_tickers) setThemeTickerOverrides(config.theme_tickers);
  console.log('[init] Database ready');

  // Init Telegram bot
  const bot = createBot(
    getRequiredEnv(env, 'TELEGRAM_BOT_TOKEN'),
    env,
    config,
  );
  const chatId = getRequiredEnv(env, 'TELEGRAM_CHAT_ID');

  // Start bot (non-blocking)
  bot.start({ onStart: () => console.log('[init] Telegram bot ready') });

  // Start dashboard (capture server handle for graceful shutdown)
  const dashboardPort = config.dashboard?.port || 3000;
  const defaultListId = config.lists.find(l => l.active)?.id || '';
  const server = createDashboard(dashboardPort, env, { defaultListId });
  console.log(`[init] Dashboard at http://localhost:${dashboardPort}`);

  // ─── Startup scrape (cold boot data freshness) ─────────
  for (const list of config.lists.filter(l => l.active)) {
    runScrape(list.id, list.name, env, config, chatId, bot);
  }
  console.log('[init] Startup scrape triggered for all active lists');

  // ─── Pre-digest pipeline (scrape + enrich + themes) ─────────
  // Runs twice daily, ~1h before each digest, instead of continuous crons.
  // For a small list this completes in <1 minute.
  const offsetMin = config.digest?.pre_digest_offset_min ?? 60;
  const morningHour = config.digest?.morning_hour ?? 7;
  const eveningHour = config.digest?.evening_hour ?? 18;

  function computePipelineCron(digestHour: number, offsetMinutes: number): string {
    const totalMinutes = digestHour * 60 - offsetMinutes;
    const adjusted = ((totalMinutes % 1440) + 1440) % 1440; // handle wrap-around
    return `${adjusted % 60} ${Math.floor(adjusted / 60)} * * *`;
  }

  for (const [label, digestHour] of [['morning', morningHour], ['evening', eveningHour]] as const) {
    const cron = computePipelineCron(digestHour as number, offsetMin);
    const task = schedule(cron, async () => {
      if (shuttingDown) return;
      try {
        await runPreDigestPipeline(label, config, chatId, bot);
      } catch (err) {
        console.error(`[pipeline] ${label} pipeline failed:`, String(err));
        await sendAlert(bot, chatId, `⚠️ ${label} pre-digest pipeline failed: ${sanitizeError(err)}`);
      }
    });
    cronTasks.push(task);
  }
  console.log(`[init] Pre-digest pipeline at ${computePipelineCron(morningHour, offsetMin)} and ${computePipelineCron(eveningHour, offsetMin)} UTC`);

  // ─── Digest cron (morning + evening) ─────────

  for (const hour of [morningHour, eveningHour]) {
    const digestType = hour === morningHour ? 'morning' as const : 'evening' as const;
    const digestTask = schedule(`0 ${hour} * * *`, async () => {
      if (shuttingDown) return;
      const freshEnv = loadEnv();
      const apiKey = getRequiredEnv(freshEnv, 'OPENROUTER_API_KEY');

      // Each digest covers the window since the LAST digest was generated.
      // Fallback: morning looks back 12h, evening looks back to morning hour.
      // This prevents overlapping windows that re-analyze the same tweets.
      // NOTE: `since` must be scoped per-list to avoid list N inheriting list N-1's value.
      for (const list of config.lists.filter(l => l.active)) {
        const lastSnapshot = getLastDigestSnapshot(list.id);
        let since: string;
        if (lastSnapshot) {
          // Start from where the last digest left off
          since = lastSnapshot.generated_at;
        } else if (hour === morningHour) {
          since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
        } else {
          // Evening: start from morning hour today
          const today = new Date();
          today.setUTCHours(morningHour, 0, 0, 0);
          since = today.toISOString();
        }

        try {
          console.log(`[digest] Generating ${digestType} for "${list.name}" (since ${since})...`);
          const result = await generateDigest(list.id, list.name, since, apiKey, config, digestType, 'scheduled');
          await sendDigest(bot, chatId, result);
          console.log(`[digest] Sent for "${list.name}" (${result.tweet_count} tweets, delta: ${result.delta ? 'yes' : 'no'})`);
        } catch (err) {
          console.error(`[digest] Error for "${list.name}":`, sanitizeError(err));
          await sendAlert(bot, chatId, `⚠️ Digest generation failed for ${list.name}: ${sanitizeError(err)}`);
        }
      }
    });
    cronTasks.push(digestTask);
  }
  console.log(`[init] Digests scheduled at ${morningHour}:00 and ${eveningHour}:00 UTC`);

  // ─── Initial digest bootstrap (first boot only) ─────────
  // If no digest snapshot exists for any active list, run a full-corpus initial
  // digest to establish baselines for WHAT CHANGED delta tracking.
  setTimeout(async () => {
    try {
      const freshEnv = loadEnv();
      const apiKey = freshEnv.OPENROUTER_API_KEY;
      if (!apiKey) return;

      for (const list of config.lists.filter(l => l.active)) {
        const lastSnapshot = getLastDigestSnapshot(list.id);
        if (!lastSnapshot) {
          console.log(`[digest] No prior snapshot for "${list.name}" — running initial baseline digest...`);
          const since = new Date(0).toISOString(); // All tweets ever
          const result = await generateDigest(list.id, list.name, since, apiKey, config, 'manual', 'initial');
          console.log(`[digest] Initial baseline for "${list.name}": ${result.tweet_count} tweets, ${result.themes_covered.length} themes`);
          // Don't send to Telegram — this is a background bootstrap, not a user-facing digest
        }
      }
    } catch (err) {
      console.error('[digest] Initial baseline failed (non-fatal):', sanitizeError(err));
    }
  }, 30_000); // Wait 30s for enrichment to have some data

  // ─── Track record resolution cron (daily at midnight UTC) ─────────
  if (config.track_record?.enabled) {
    const trTask = schedule('0 0 * * *', () => {
      if (shuttingDown) return;
      try {
        const result = resolveOpenCalls(config);
        if (result.resolved > 0 || result.expired > 0) {
          console.log(`[track-record] Resolved ${result.resolved}, expired ${result.expired}`);
        }
      } catch (err) {
        console.error('[track-record] Resolution error:', String(err));
      }
    });
    cronTasks.push(trTask);
    console.log('[init] Track record resolution scheduled daily at 00:00 UTC');
  }

  // ─── Graceful shutdown ─────────────────────────────────────────────────────
  function gracefulShutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received — shutting down gracefully...`);

    // 1. Stop crons
    for (const task of cronTasks) task.stop();

    // 2. Stop bot
    try { bot.stop(); } catch { /* already stopped */ }

    // 3. Close HTTP server
    try { server.close(); } catch { /* already closed */ }

    // 4. Close database
    try { getDb().close(); } catch { /* already closed */ }

    console.log('[shutdown] Clean shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  console.log('[init] All systems ready ✓');
}

async function runScrape(
  listId: string,
  listName: string,
  env: Record<string, string>,
  config: Config,
  chatId: string,
  bot: Bot,
): Promise<void> {
  try {
    const freshEnv = loadEnv(); // Hot-reload cookies
    const authToken = getRequiredEnv(freshEnv, 'TWITTER_AUTH_TOKEN');
    const ct0 = getRequiredEnv(freshEnv, 'TWITTER_CT0');
    const lastId = getLastScrapedTweetId(listId);

    const result = await scrapeList(listId, authToken, ct0, {
      maxPages: config.scraper?.max_pages_per_scrape || 10,
      lastKnownTweetId: lastId || undefined,
    });

    if (result.tweets.length > 0) {
      insertTweets(result.tweets);
      for (const account of result.accounts) {
        upsertAccount(account);
      }
      console.log(`[scrape] ${listName}: ${result.tweets.length} tweets, ${result.accounts.length} accounts${result.parseFailures > 0 ? `, ${result.parseFailures} parse failures` : ''}`);
    }

    // Parse failure alerting (>10% = schema drift warning)
    if (result.parseFailures > 0) {
      const total = result.tweets.length + result.parseFailures;
      const failRate = result.parseFailures / total;
      if (failRate > 0.1) {
        await sendAlert(bot, chatId, `⚠️ Scraper parse failure rate ${Math.round(failRate * 100)}% for ${listName} — X may have changed their API response format`);
      }
    }
  } catch (err: any) {
    console.error(`[scrape] ${listName} error:`, err.message);
    // Immediate alert on auth failure
    if (err.type === 'auth') {
      await sendAlert(bot, chatId, `🔴 Scraper auth failed for ${listName} — refresh cookies in .env`);
    } else if (err.type === 'rate_limit') {
      console.log(`[scrape] ${listName}: rate limited, will retry next cycle`);
    }
  }
}

// ─── Pre-Digest Pipeline ────────────────────────────────────────────────────

async function runPreDigestPipeline(
  label: string,
  config: Config,
  chatId: string,
  bot: Bot,
): Promise<void> {
  const startTime = Date.now();
  console.log(`[pipeline] ${label} pre-digest pipeline starting...`);

  // Phase 1: Scrape all active lists
  const freshEnv = loadEnv();
  for (const list of config.lists.filter(l => l.active)) {
    await runScrape(list.id, list.name, freshEnv, config, chatId, bot);
  }
  console.log(`[pipeline] ${label} scrape complete (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);

  // Phase 2: Drain enrichment queue
  let apiKey: string;
  try {
    apiKey = getRequiredEnv(freshEnv, 'OPENROUTER_API_KEY');
  } catch {
    console.error(`[pipeline] ${label} OPENROUTER_API_KEY missing — skipping enrichment & themes`);
    return;
  }

  let totalProcessed = 0;
  let totalFailed = 0;
  let batchCount = 0;
  const MAX_BATCHES = 100; // Safety: 100 × 25 = 2500 tweets max

  while (batchCount < MAX_BATCHES && !shuttingDown) {
    try {
      const result = await enrichBatch(apiKey, config);
      totalProcessed += result.processed;
      totalFailed += result.failed;
      batchCount++;
      if (result.throttled) {
        console.warn(`[pipeline] ${label} enrichment throttled — daily cost budget reached`);
        break;
      }
      if (result.processed === 0 && result.failed === 0) break;
    } catch (err) {
      console.error(`[pipeline] ${label} enrichment batch ${batchCount + 1} failed:`, sanitizeError(err));
      batchCount++;
      // Continue draining — one failed batch shouldn't stop the rest
      // But if 3 consecutive batches fail, the API is probably down
      if (batchCount >= 3 && totalProcessed === 0) {
        console.error(`[pipeline] ${label} 3 consecutive enrichment failures — aborting enrichment`);
        break;
      }
    }
  }
  console.log(`[pipeline] ${label} enrichment complete: ${totalProcessed} processed, ${totalFailed} failed, ${batchCount} batches (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);

  // Phase 3: Theme discovery
  try {
    const themeResult = await discoverNewThemes(apiKey);
    if (themeResult.created > 0) {
      console.log(`[pipeline] ${label} discovered ${themeResult.created} new themes`);
    }
  } catch (err) {
    console.error(`[pipeline] ${label} theme discovery error (non-fatal):`, sanitizeError(err));
  }

  console.log(`[pipeline] ${label} complete in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

main().catch(err => {
  console.error('[FATAL] Startup failed:', sanitizeError(err));
  process.exit(1);
});
