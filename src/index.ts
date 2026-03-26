import { schedule } from 'node-cron';
import { Bot } from 'grammy';
import { loadConfig, loadEnv, getRequiredEnv } from './config.js';
import { initDb, getUnenrichedTweets, getLastScrapedTweetId, getScrapeHealth, syncCredibilityTags, syncListConfigs, seedThemeRegistry, getLastDigestSnapshot } from './db.js';
import { discoverQueryHash, scrapeList } from './scraper.js';
import { enrichBatch, discoverNewThemes } from './enrichment.js';
import { generateDigest } from './digest.js';
import { createBot, sendDigest, sendAlert } from './bot.js';
import { createDashboard } from './dashboard/index.js';
import { resolveOpenCalls, setThemeTickerOverrides } from './intelligence.js';
import type { Config } from './types.js';

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  // Don't exit — systemd will restart if needed
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
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

  // Start dashboard
  const dashboardPort = config.dashboard?.port || 3000;
  const defaultListId = config.lists.find(l => l.active)?.id || '';
  createDashboard(dashboardPort, env, { defaultListId });
  console.log(`[init] Dashboard at http://localhost:${dashboardPort}`);

  // ─── Scrape cron (every 2h by default) ─────────
  for (const list of config.lists.filter(l => l.active)) {
    const interval = list.scrape_interval_min || 120;
    // Run immediately on startup, then on schedule
    runScrape(list.id, list.name, env, config, chatId, bot);

    schedule(`*/${interval} * * * *`, () => {
      runScrape(list.id, list.name, env, config, chatId, bot);
    });
    console.log(`[init] Scrape scheduled every ${interval}min for list "${list.name}"`);
  }

  // ─── Enrichment cron (every 5 min) ─────────
  schedule('*/5 * * * *', async () => {
    try {
      const freshEnv = loadEnv(); // Hot-reload API keys
      const result = await enrichBatch(
        getRequiredEnv(freshEnv, 'OPENROUTER_API_KEY'),
        config,
      );
      if (result.processed > 0) {
        console.log(`[enrich] Processed ${result.processed}, failed ${result.failed}`);
      }
    } catch (err) {
      console.error('[enrich] Error:', err);
    }
  });
  console.log('[init] Enrichment scheduled every 5min');

  // ─── Theme discovery cron (every 6 hours) ─────────
  schedule('0 */6 * * *', async () => {
    try {
      const freshEnv = loadEnv();
      const result = await discoverNewThemes(
        getRequiredEnv(freshEnv, 'OPENROUTER_API_KEY'),
      );
      if (result.created > 0) {
        console.log(`[themes] Discovered ${result.created} new themes, ignored ${result.ignored} orphans`);
      }
    } catch (err) {
      console.error('[themes] Discovery error:', err);
    }
  });
  console.log('[init] Theme discovery scheduled every 6h');

  // ─── Digest cron (morning + evening) ─────────
  const morningHour = config.digest?.morning_hour ?? 7;
  const eveningHour = config.digest?.evening_hour ?? 18;

  for (const hour of [morningHour, eveningHour]) {
    const digestType = hour === morningHour ? 'morning' as const : 'evening' as const;
    schedule(`0 ${hour} * * *`, async () => {
      const freshEnv = loadEnv();
      const apiKey = getRequiredEnv(freshEnv, 'OPENROUTER_API_KEY');
      const since = hour === morningHour
        ? new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString() // last 12h
        : new Date(Date.now() - 11 * 60 * 60 * 1000).toISOString(); // since morning

      for (const list of config.lists.filter(l => l.active)) {
        try {
          console.log(`[digest] Generating for "${list.name}"...`);
          const result = await generateDigest(list.id, list.name, since, apiKey, config, digestType, 'scheduled');
          await sendDigest(bot, chatId, result);
          console.log(`[digest] Sent for "${list.name}" (${result.tweet_count} tweets, delta: ${result.delta ? 'yes' : 'no'})`);
        } catch (err) {
          console.error(`[digest] Error for "${list.name}":`, err);
          await sendAlert(bot, chatId, `⚠️ Digest generation failed for ${list.name}: ${err}`);
        }
      }
    });
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
      console.error('[digest] Initial baseline failed (non-fatal):', err);
    }
  }, 30_000); // Wait 30s for enrichment to have some data

  // ─── Track record resolution cron (daily at midnight UTC) ─────────
  if (config.track_record?.enabled) {
    schedule('0 0 * * *', () => {
      try {
        const result = resolveOpenCalls(config);
        if (result.resolved > 0 || result.expired > 0) {
          console.log(`[track-record] Resolved ${result.resolved}, expired ${result.expired}`);
        }
      } catch (err) {
        console.error('[track-record] Resolution error:', err);
      }
    });
    console.log('[init] Track record resolution scheduled daily at 00:00 UTC');
  }

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
      // Import here to avoid circular deps
      const { insertTweets, upsertAccount } = await import('./db.js');
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

main().catch(err => {
  console.error('[FATAL] Startup failed:', err);
  process.exit(1);
});
