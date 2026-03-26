import { OpenRouter } from '@openrouter/sdk';
import {
  getDb,
  getDigestTweets,
  getTweetsByTheme,
  getLastDigestSnapshot,
  insertDigestSnapshot,
  getTopTrackRecords,
  getAccountCredibilityTag,
} from './db.js';
import type { DigestResult, ConsensusSnapshot, Config, DigestDelta } from './types.js';
import { DIGEST_SYSTEM, TLDR_SYSTEM } from './prompts.js';
import {
  generateAllSnapshots,
  detectConsensusAlerts,
  detectEmergingNarratives,
  getPriceAfterConsensus,
  computeDigestDelta,
  type ConsensusAlert,
  type EmergingNarrative,
  type PriceResult,
} from './intelligence.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ThemeCluster {
  theme: string;
  tweets: any[];
  uniqueAccounts: number;
  totalEngagement: number;
  avgNovelty: number;
  consensus?: ConsensusSnapshot;
  priceData?: PriceResult | null;
}

// ─── Digest Generation ───────────────────────────────────────────────────────

/**
 * Generate a full digest for a list using Claude Opus.
 *
 * 1. Get digest tweets (with enrichments) from DB
 * 2. Generate all consensus snapshots
 * 3. Detect consensus alerts
 * 4. Detect emerging narratives
 * 5. Cluster tweets by theme, rank, and build structured prompt
 * 6. Call Opus to generate the digest text
 * 7. Fall back to raw stats if Opus fails
 */
export async function generateDigest(
  listId: string,
  listName: string,
  since: string,
  apiKey: string,
  config: Config,
  digestType: 'morning' | 'evening' | 'manual' = 'manual',
  mode: 'initial' | 'scheduled' | 'manual' = 'scheduled',
): Promise<DigestResult> {
  const now = new Date().toISOString();

  // Step 1: Get tweets — cap depends on mode
  // initial: no cap (full corpus baseline), scheduled: 500 cap, manual: no cap
  let tweets = getDigestTweets(listId, since);
  if (mode === 'scheduled' && tweets.length > 500) {
    console.warn(`[digest] Window returned ${tweets.length} tweets — capping to 500 most recent`);
    tweets = tweets.slice(0, 500); // Already sorted by created_at DESC
  }

  if (tweets.length === 0) {
    return {
      list_id: listId,
      text: `📊 DIGEST: ${listName}\n\nQuiet period — no tweets captured since ${since}.\nCheck back later or verify scraper health.`,
      themes_covered: [],
      tweet_count: 0,
      generated_at: now,
    };
  }

  // Step 2: Generate all consensus snapshots for the window
  const snapshots = generateAllSnapshots(listId, since);
  const snapshotByTheme = new Map<string, ConsensusSnapshot>();
  for (const s of snapshots) {
    snapshotByTheme.set(s.theme, s);
  }

  // Step 3: Detect consensus alerts
  const alerts = detectConsensusAlerts(listId, 70);

  // Step 4: Detect emerging narratives
  const earliestTweet = tweets[tweets.length - 1];
  const dataAgeDays = earliestTweet
    ? Math.floor(
        (Date.now() - new Date(earliestTweet.created_at).getTime()) /
          (1000 * 60 * 60 * 24),
      )
    : 0;
  const emerging = detectEmergingNarratives(listId, dataAgeDays);

  // Step 5: Cluster tweets by theme
  let themeClusters = clusterByTheme(listId, since, tweets, snapshotByTheme);

  // Step 5.5: Apply signal noise floor
  const minAccounts = config.signal_floor?.min_accounts ?? 3;
  const minEngagement = config.signal_floor?.min_engagement ?? 50;
  themeClusters = themeClusters.filter(c =>
    c.uniqueAccounts >= minAccounts && c.totalEngagement >= minEngagement
  );

  // Step 6: Rank themes — unique accounts > signal density > novelty
  // Signal density = directional accounts / total accounts (how aligned are they)
  // This deprioritizes themes dominated by aggregator noise (high engagement, low signal)
  themeClusters.sort((a, b) => {
    if (b.uniqueAccounts !== a.uniqueAccounts)
      return b.uniqueAccounts - a.uniqueAccounts;
    // Tiebreaker: directional signal density (% of accounts that are bullish or bearish)
    const aSignal = a.consensus ? (a.consensus.bullish_count + a.consensus.bearish_count) / Math.max(1, a.consensus.total_accounts) : 0;
    const bSignal = b.consensus ? (b.consensus.bullish_count + b.consensus.bearish_count) / Math.max(1, b.consensus.total_accounts) : 0;
    if (Math.abs(bSignal - aSignal) > 0.1)
      return bSignal - aSignal;
    return b.avgNovelty - a.avgNovelty;
  });

  const maxThemes = config.digest?.max_themes ?? 4;
  const themesCovered = themeClusters.slice(0, maxThemes).map((c) => c.theme);

  // Step 6.5: Compute delta from previous digest
  let delta: DigestDelta | undefined;
  if (config.digest?.delta_enabled !== false) {
    const previousSnapshot = getLastDigestSnapshot(listId);
    delta = computeDigestDelta(themesCovered, snapshotByTheme, previousSnapshot);
    // Only include delta if there's actual content
    if (delta.new_themes.length === 0 && delta.dropped_themes.length === 0 && delta.consensus_shifts.length === 0) {
      delta = undefined;
    }
  }

  // Step 6.6: Get track records for accounts in digest
  const minCallsToDisplay = config.track_record?.min_calls_to_display ?? 5;
  const trackRecords = config.track_record?.enabled ? getTopTrackRecords(listId, minCallsToDisplay) : [];

  // Step 7: Try Opus, fall back to raw stats
  try {
    const digestText = await callOpus(
      apiKey,
      listName,
      tweets.length,
      since,
      themeClusters.slice(0, maxThemes),
      alerts,
      emerging,
      delta,
      trackRecords,
    );

    // Step 7.5: Generate TL;DR if split format
    let tldr: string | undefined;
    if (config.digest?.format === 'split') {
      try {
        tldr = await generateTldr(apiKey, digestText, config.digest?.tldr_max_words ?? 150);
      } catch (err) {
        console.warn('[digest] TL;DR generation failed, will send full digest:', err);
      }
    }

    // Step 8: Persist digest snapshot for delta tracking
    const consensusState: Record<string, { direction: string; pct: number }> = {};
    for (const [theme, snap] of snapshotByTheme) {
      consensusState[theme] = { direction: snap.consensus_direction, pct: snap.consensus_pct };
    }

    insertDigestSnapshot({
      list_id: listId,
      generated_at: now,
      digest_type: digestType,
      tweet_count: tweets.length,
      themes_json: JSON.stringify(themesCovered),
      consensus_json: JSON.stringify(consensusState),
      alerts_json: JSON.stringify(alerts),
      emerging_json: JSON.stringify(emerging),
      digest_text: digestText,
    });

    return {
      list_id: listId,
      text: digestText,
      tldr,
      themes_covered: themesCovered,
      tweet_count: tweets.length,
      generated_at: now,
      delta,
    };
  } catch (err) {
    console.error('[digest] Opus call failed, falling back to raw stats:', err);
    return generateRawStatsDigest(listId, listName, since);
  }
}

// ─── Raw Stats Fallback ──────────────────────────────────────────────────────

/**
 * Fallback digest without LLM. Just theme counts, top engagement tweets,
 * and consensus numbers.
 */
export function generateRawStatsDigest(
  listId: string,
  listName: string,
  since: string,
): DigestResult {
  const now = new Date().toISOString();
  const db = getDb();
  const tweets = getDigestTweets(listId, since);

  if (tweets.length === 0) {
    return {
      list_id: listId,
      text: `📊 DIGEST: ${listName}\n\nNo tweets in window since ${since}.`,
      themes_covered: [],
      tweet_count: 0,
      generated_at: now,
    };
  }

  // Theme counts
  const themeCounts = db
    .prepare(
      `SELECT tt.theme, COUNT(DISTINCT t.id) AS tweet_count, COUNT(DISTINCT t.author_id) AS account_count
       FROM tweet_themes tt
       JOIN tweets t ON tt.tweet_id = t.id
       WHERE t.list_id = ? AND t.created_at >= ?
       GROUP BY tt.theme
       ORDER BY account_count DESC, tweet_count DESC`,
    )
    .all(listId, since) as Array<{
    theme: string;
    tweet_count: number;
    account_count: number;
  }>;

  // Top engagement tweets
  const topTweets = tweets
    .sort(
      (a: any, b: any) =>
        b.engagement_likes +
        b.engagement_retweets +
        b.engagement_replies -
        (a.engagement_likes + a.engagement_retweets + a.engagement_replies),
    )
    .slice(0, 5);

  // Sentiment breakdown
  const sentimentCounts = db
    .prepare(
      `SELECT e.sentiment, COUNT(*) AS cnt
       FROM enrichments e
       JOIN tweets t ON e.tweet_id = t.id
       WHERE t.list_id = ? AND t.created_at >= ? AND e.status = 'complete'
       GROUP BY e.sentiment
       ORDER BY cnt DESC`,
    )
    .all(listId, since) as Array<{ sentiment: string; cnt: number }>;

  // Latest consensus snapshots
  const consensusRows = db
    .prepare(
      `SELECT cs.*
       FROM consensus_snapshots cs
       INNER JOIN (
         SELECT theme, MAX(snapshot_at) AS max_at
         FROM consensus_snapshots
         WHERE list_id = ?
         GROUP BY theme
       ) latest ON cs.theme = latest.theme AND cs.snapshot_at = latest.max_at
       WHERE cs.list_id = ?
       ORDER BY cs.consensus_pct DESC
       LIMIT 5`,
    )
    .all(listId, listId) as any[];

  // Build text
  const lines: string[] = [];

  lines.push(`📊 DIGEST: ${listName}`);
  lines.push(`Period: since ${since} | ${tweets.length} tweets analyzed`);
  lines.push('');

  // Sentiment summary
  if (sentimentCounts.length > 0) {
    lines.push('SENTIMENT BREAKDOWN:');
    for (const s of sentimentCounts) {
      lines.push(`  ${s.sentiment}: ${s.cnt}`);
    }
    lines.push('');
  }

  // Theme rankings
  if (themeCounts.length > 0) {
    lines.push('📌 THEMES (by unique accounts):');
    for (const tc of themeCounts.slice(0, 8)) {
      lines.push(
        `  • ${tc.theme}: ${tc.account_count} accounts, ${tc.tweet_count} tweets`,
      );
    }
    lines.push('');
  }

  // Consensus
  if (consensusRows.length > 0) {
    lines.push('CONSENSUS:');
    for (const cs of consensusRows) {
      lines.push(
        `  • ${cs.theme}: ${cs.consensus_pct}% ${cs.consensus_direction} (${cs.total_accounts} accounts)`,
      );
    }
    lines.push('');
  }

  // Top tweets
  if (topTweets.length > 0) {
    lines.push('TOP TWEETS (by engagement):');
    for (const tw of topTweets) {
      const engagement =
        tw.engagement_likes + tw.engagement_retweets + tw.engagement_replies;
      const preview = tw.text.slice(0, 120).replace(/\n/g, ' ');
      lines.push(`  @${tw.author_handle} (${engagement} eng): ${preview}...`);
    }
    lines.push('');
  }

  lines.push('[Raw stats fallback — LLM generation unavailable]');

  const themesCovered = themeCounts.map((tc) => tc.theme);

  return {
    list_id: listId,
    text: lines.join('\n'),
    themes_covered: themesCovered,
    tweet_count: tweets.length,
    generated_at: now,
  };
}

// ─── Theme Clustering ────────────────────────────────────────────────────────

function clusterByTheme(
  listId: string,
  since: string,
  allTweets: any[],
  snapshotByTheme: Map<string, ConsensusSnapshot>,
): ThemeCluster[] {
  const db = getDb();

  // Get all theme assignments for tweets in the window
  const themeAssignments = db
    .prepare(
      `SELECT tt.tweet_id, tt.theme
       FROM tweet_themes tt
       JOIN tweets t ON tt.tweet_id = t.id
       WHERE t.list_id = ? AND t.created_at >= ?`,
    )
    .all(listId, since) as Array<{ tweet_id: string; theme: string }>;

  // Build tweet lookup
  const tweetMap = new Map<string, any>();
  for (const tw of allTweets) {
    tweetMap.set(tw.id, tw);
  }

  // Group tweets by theme
  const themeGroups = new Map<string, any[]>();
  for (const { tweet_id, theme } of themeAssignments) {
    const tweet = tweetMap.get(tweet_id);
    if (!tweet) continue;

    const group = themeGroups.get(theme) ?? [];
    group.push(tweet);
    themeGroups.set(theme, group);
  }

  // Build clusters
  const clusters: ThemeCluster[] = [];

  for (const [theme, tweets] of themeGroups) {
    const uniqueAuthors = new Set(tweets.map((t: any) => t.author_id));
    const totalEngagement = tweets.reduce(
      (sum: number, t: any) =>
        sum +
        (t.engagement_likes ?? 0) +
        (t.engagement_retweets ?? 0) +
        (t.engagement_replies ?? 0),
      0,
    );
    const noveltyScores = tweets
      .map((t: any) => t.novelty_score ?? 0)
      .filter((n: number) => n > 0);
    const avgNovelty =
      noveltyScores.length > 0
        ? noveltyScores.reduce((a: number, b: number) => a + b, 0) /
          noveltyScores.length
        : 0;

    // Get price backtesting data if consensus exists
    const consensus = snapshotByTheme.get(theme);
    let priceData: PriceResult | null = null;
    if (consensus) {
      priceData = getPriceAfterConsensus(theme, consensus.snapshot_at, 5);
    }

    clusters.push({
      theme,
      tweets,
      uniqueAccounts: uniqueAuthors.size,
      totalEngagement,
      avgNovelty,
      consensus,
      priceData,
    });
  }

  return clusters;
}

// ─── Opus Call ────────────────────────────────────────────────────────────────

async function callOpus(
  apiKey: string,
  listName: string,
  tweetCount: number,
  since: string,
  clusters: ThemeCluster[],
  alerts: ConsensusAlert[],
  emerging: EmergingNarrative[],
  delta?: DigestDelta,
  trackRecords?: import('./types.js').AuthorTrackRecord[],
): Promise<string> {
  const client = new OpenRouter({ apiKey });

  // Build structured prompt sections
  const sections: string[] = [];

  // Header context
  const sinceDate = new Date(since);
  const sinceHuman = sinceDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + sinceDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC';
  sections.push(`You are generating a financial intelligence digest for the Twitter/X list "${listName}".`);
  sections.push(`Time window: since ${sinceHuman}`);
  sections.push(`Total tweets in window: ${tweetCount}`);
  sections.push('');

  // Delta section (what changed since last digest) — suppress entirely if no delta data
  if (delta && (delta.new_themes.length > 0 || delta.dropped_themes.length > 0 || delta.consensus_shifts.length > 0)) {
    sections.push('=== WHAT CHANGED SINCE LAST DIGEST ===');
    // Consensus shifts first (most valuable signal)
    for (const shift of delta.consensus_shifts) {
      sections.push(`Consensus shift: ${shift.theme} — ${shift.old_direction} ${shift.old_pct.toFixed(0)}% → ${shift.new_direction} ${shift.new_pct.toFixed(0)}%`);
    }
    if (delta.new_themes.length > 0) {
      sections.push(`New themes entering conversation: ${delta.new_themes.join(', ')}`);
    }
    if (delta.dropped_themes.length > 0) {
      sections.push(`Themes dropped off: ${delta.dropped_themes.join(', ')}`);
    }
    sections.push('');
  }
  // Note: if no delta, we intentionally omit the section entirely (not "no comparison available")

  // Track records
  if (trackRecords && trackRecords.length > 0) {
    sections.push('=== AUTHOR TRACK RECORDS ===');
    for (const tr of trackRecords) {
      sections.push(`@${tr.author_handle}: ${(tr.hit_rate * 100).toFixed(0)}% hit rate (${tr.hits}/${tr.resolved_calls} calls resolved)`);
    }
    sections.push('');
  }

  // Consensus alerts
  if (alerts.length > 0) {
    sections.push('=== CONSENSUS ALERTS ===');
    for (const alert of alerts) {
      let alertLine = `Theme: ${alert.theme} | ${alert.consensus_pct}% ${alert.direction} (7d avg: ${alert.rolling_7d_avg}%)`;
      if (alert.historical_date) {
        alertLine += ` | Last seen above threshold: ${alert.historical_date.slice(0, 10)} (${alert.historical_direction})`;
      }
      sections.push(alertLine);
    }
    sections.push('');
  }

  // Theme clusters with representative tweets (only include themes that pass signal floor)
  sections.push('=== THEME CLUSTERS (ranked by importance) ===');
  for (const cluster of clusters) {
    sections.push(`\n--- ${cluster.theme.toUpperCase()} ---`);
    sections.push(
      `Accounts: ${cluster.uniqueAccounts} | Engagement: ${cluster.totalEngagement} | Novelty: ${cluster.avgNovelty.toFixed(2)}`,
    );

    // Consensus for this theme
    if (cluster.consensus) {
      const c = cluster.consensus;
      sections.push(
        `Consensus: ${c.consensus_pct}% ${c.consensus_direction} (${c.bullish_count}B/${c.bearish_count}b/${c.neutral_count}N out of ${c.total_accounts} accounts)`,
      );
    }

    // Price backtesting
    if (cluster.priceData) {
      const p = cluster.priceData;
      sections.push(
        `Price impact (${p.ticker}, 5d after): ${p.changePct > 0 ? '+' : ''}${p.changePct}% ($${p.startPrice.toFixed(2)} -> $${p.endPrice.toFixed(2)})`,
      );
    }

    // Top 3 tweets by engagement
    const topTweets = [...cluster.tweets]
      .sort(
        (a, b) =>
          b.engagement_likes +
          b.engagement_retweets +
          b.engagement_replies -
          (a.engagement_likes + a.engagement_retweets + a.engagement_replies),
      )
      .slice(0, 3);

    sections.push('Representative tweets:');
    for (const tw of topTweets) {
      const eng =
        tw.engagement_likes + tw.engagement_retweets + tw.engagement_replies;
      const sentiment = tw.sentiment ? ` [${tw.sentiment}]` : '';
      const credTag = getAccountCredibilityTag(tw.author_handle);
      const credLabel = credTag !== 'unverified' ? ` [${credTag}]` : '';
      sections.push(
        `  @${tw.author_handle}${credLabel}${sentiment} (${eng} eng): ${tw.text.slice(0, 280)}`,
      );
    }
  }

  // Notable threads
  const allThreadTweets = clusters
    .flatMap((c) => c.tweets)
    .filter((t: any) => t.is_thread || t.thread_id);
  if (allThreadTweets.length > 0) {
    sections.push('\n=== NOTABLE THREADS ===');
    const uniqueThreads = new Map<string, any>();
    for (const tw of allThreadTweets) {
      const threadKey = tw.thread_id ?? tw.id;
      if (
        !uniqueThreads.has(threadKey) ||
        tw.engagement_likes > (uniqueThreads.get(threadKey)?.engagement_likes ?? 0)
      ) {
        uniqueThreads.set(threadKey, tw);
      }
    }
    const topThreads = [...uniqueThreads.values()]
      .sort(
        (a, b) =>
          b.engagement_likes +
          b.engagement_retweets -
          (a.engagement_likes + a.engagement_retweets),
      )
      .slice(0, 3);
    for (const tw of topThreads) {
      sections.push(
        `  @${tw.author_handle}: ${tw.text.slice(0, 200)}`,
      );
    }
  }

  // Emerging narratives
  if (emerging.length > 0) {
    sections.push('\n=== EMERGING NARRATIVES (new topics, not seen in prior 30 days) ===');
    for (const e of emerging) {
      sections.push(
        `  "${e.topic}" — ${e.account_count} accounts, first mention: ${e.first_mention}`,
      );
    }
  }

  const dataPrompt = sections.join('\n');

  const systemPrompt = DIGEST_SYSTEM(listName, tweetCount, since);

  const response = await client.chat.send({
    model: 'anthropic/claude-opus-4.6',
    maxTokens: 2048,
    messages: [
      { role: 'system' as const, content: systemPrompt },
      {
        role: 'user' as const,
        content: `Generate the digest from the following data:\n\n${dataPrompt}`,
      },
    ],
  });

  const rawContent = response.choices?.[0]?.message?.content;
  if (!rawContent) {
    throw new Error('Opus returned no text content');
  }

  const textContent = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);
  return textContent.trim();
}

// ─── TL;DR Generation ───────────────────────────────────────────────────────

async function generateTldr(
  apiKey: string,
  fullDigest: string,
  maxWords: number,
): Promise<string> {
  const client = new OpenRouter({ apiKey });

  const response = await client.chat.send({
    model: 'anthropic/claude-haiku-4.5',
    maxTokens: 512,
    messages: [
      {
        role: 'system' as const,
        content: TLDR_SYSTEM(maxWords),
      },
      {
        role: 'user' as const,
        content: fullDigest,
      },
    ],
  });

  const rawContent = response.choices?.[0]?.message?.content;
  if (!rawContent) throw new Error('Haiku returned no content for TL;DR');
  return (typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent)).trim();
}
