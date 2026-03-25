import Anthropic from '@anthropic-ai/sdk';
import {
  getDb,
  getDigestTweets,
  getTweetsByTheme,
} from './db.js';
import type { DigestResult, ConsensusSnapshot } from './types.js';
import {
  generateAllSnapshots,
  detectConsensusAlerts,
  detectEmergingNarratives,
  getPriceAfterConsensus,
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
): Promise<DigestResult> {
  const now = new Date().toISOString();

  // Step 1: Get all tweets with enrichments for the window
  const tweets = getDigestTweets(listId, since);

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
  // Compute data age: days between earliest tweet and now
  const earliestTweet = tweets[tweets.length - 1];
  const dataAgeDays = earliestTweet
    ? Math.floor(
        (Date.now() - new Date(earliestTweet.created_at).getTime()) /
          (1000 * 60 * 60 * 24),
      )
    : 0;
  const emerging = detectEmergingNarratives(listId, dataAgeDays);

  // Step 5: Cluster tweets by theme
  const themeClusters = clusterByTheme(listId, since, tweets, snapshotByTheme);

  // Step 6: Rank themes — unique accounts > total engagement > novelty
  themeClusters.sort((a, b) => {
    if (b.uniqueAccounts !== a.uniqueAccounts)
      return b.uniqueAccounts - a.uniqueAccounts;
    if (b.totalEngagement !== a.totalEngagement)
      return b.totalEngagement - a.totalEngagement;
    return b.avgNovelty - a.avgNovelty;
  });

  const themesCovered = themeClusters.map((c) => c.theme);

  // Step 7: Try Opus, fall back to raw stats
  try {
    const digestText = await callOpus(
      apiKey,
      listName,
      tweets.length,
      since,
      themeClusters,
      alerts,
      emerging,
    );

    return {
      list_id: listId,
      text: digestText,
      themes_covered: themesCovered,
      tweet_count: tweets.length,
      generated_at: now,
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
): Promise<string> {
  const anthropic = new Anthropic({ apiKey });

  // Build structured prompt sections
  const sections: string[] = [];

  // Header context
  sections.push(`You are generating a financial intelligence digest for the Twitter/X list "${listName}".`);
  sections.push(`Time window: since ${since}`);
  sections.push(`Total tweets analyzed: ${tweetCount}`);
  sections.push('');

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

  // Theme clusters with representative tweets
  sections.push('=== THEME CLUSTERS (ranked by importance) ===');
  for (const cluster of clusters.slice(0, 8)) {
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
      sections.push(
        `  @${tw.author_handle}${sentiment} (${eng} eng): ${tw.text.slice(0, 280)}`,
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

  const systemPrompt = `You are a senior financial intelligence analyst producing a concise Twitter/X digest for institutional investors.

Your output format MUST be:

📊 DIGEST: [List Name] | [tweet count] tweets | [time window]

🔴 CONSENSUS ALERT (only if alerts exist)
- One bullet per alert with the theme, direction, percentage, and historical context if available.

📌 TOP THEMES (ranked)
For each theme (up to 6):
- Theme name with brief 1-2 sentence synthesis of the conversation
- Key accounts and their positions
- Consensus reading if available
- Any price backtesting data

🧵 NOTABLE THREADS (only if threads exist)
- Brief description of significant threads

💡 EMERGING (only if emerging narratives exist)
- New topics gaining traction

Rules:
- Be concise. No filler. Financial-professional tone.
- Use specific numbers and account handles.
- Synthesize, don't just list tweets.
- If consensus is strong (>75%), highlight it prominently.
- Include price data only when available and relevant.
- Maximum 800 words total.`;

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-0-20250514',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Generate the digest from the following data:\n\n${dataPrompt}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Opus returned no text content');
  }

  return textBlock.text.trim();
}
