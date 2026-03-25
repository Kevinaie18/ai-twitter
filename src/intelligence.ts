import {
  getDb,
  getTweetsByTheme,
  getThemeAccountSentiments,
  getRecentThemes,
  insertConsensusSnapshot,
  getPriceData,
} from './db.js';
import type { ConsensusSnapshot } from './types.js';

// ─── Theme-to-ticker mapping for backtesting ─────────────────────────────────

const THEME_TICKER_MAP: Record<string, string[]> = {
  energy: ['CL=F', 'BZ=F'],
  crypto: ['BTC-USD', 'ETH-USD'],
  semis: ['SOXX', 'NVDA', 'AMD'],
  ai_infra: ['NVDA', 'MSFT', 'GOOGL'],
  macro: ['SPY', 'TLT', 'DXY'],
  china_asia: ['FXI', 'KWEB', 'EWJ'],
  options: ['VIX', 'SPY'],
  geopolitics: ['GLD', 'TLT', 'DXY'],
};

// ─── Consensus Snapshot Generation ───────────────────────────────────────────

/**
 * Generate a consensus snapshot for a single theme.
 * One vote per unique account: group all tweets by author, take the majority
 * sentiment per author (tie = neutral, thread = 1 vote with majority across
 * its tweets).
 */
export function generateConsensusSnapshot(
  listId: string,
  theme: string,
  since: string,
): ConsensusSnapshot | null {
  // Get per-author sentiment counts for this theme in the window
  const rows = getThemeAccountSentiments(listId, theme, since);

  if (rows.length === 0) return null;

  // Group by author_id -> { bullish, bearish, neutral }
  const authorVotes = new Map<
    string,
    { bullish: number; bearish: number; neutral: number }
  >();

  for (const row of rows) {
    const existing = authorVotes.get(row.author_id) ?? {
      bullish: 0,
      bearish: 0,
      neutral: 0,
    };

    const sentiment = row.sentiment?.toLowerCase() ?? 'neutral';
    if (sentiment === 'bullish') {
      existing.bullish += row.tweet_count;
    } else if (sentiment === 'bearish') {
      existing.bearish += row.tweet_count;
    } else {
      existing.neutral += row.tweet_count;
    }

    authorVotes.set(row.author_id, existing);
  }

  // Determine majority sentiment per author (tie = neutral)
  let bullishCount = 0;
  let bearishCount = 0;
  let neutralCount = 0;

  for (const [, votes] of authorVotes) {
    if (votes.bullish > votes.bearish && votes.bullish > votes.neutral) {
      bullishCount++;
    } else if (votes.bearish > votes.bullish && votes.bearish > votes.neutral) {
      bearishCount++;
    } else {
      // Tie or neutral majority
      neutralCount++;
    }
  }

  const totalAccounts = authorVotes.size;
  const maxCount = Math.max(bullishCount, bearishCount, neutralCount);
  const consensusPct =
    totalAccounts > 0 ? (maxCount / totalAccounts) * 100 : 0;

  let consensusDirection: string;
  if (bullishCount >= bearishCount && bullishCount >= neutralCount) {
    consensusDirection = 'bullish';
  } else if (bearishCount >= bullishCount && bearishCount >= neutralCount) {
    consensusDirection = 'bearish';
  } else {
    consensusDirection = 'neutral';
  }

  const snapshot: Omit<ConsensusSnapshot, 'id'> = {
    list_id: listId,
    theme,
    snapshot_at: new Date().toISOString(),
    total_accounts: totalAccounts,
    bullish_count: bullishCount,
    bearish_count: bearishCount,
    neutral_count: neutralCount,
    consensus_pct: Math.round(consensusPct * 100) / 100,
    consensus_direction: consensusDirection,
  };

  insertConsensusSnapshot(snapshot);

  return {
    id: '', // Will be assigned by DB
    ...snapshot,
  };
}

// ─── Generate All Snapshots ──────────────────────────────────────────────────

/**
 * Run generateConsensusSnapshot for every theme that appears in the time window.
 */
export function generateAllSnapshots(
  listId: string,
  since: string,
): ConsensusSnapshot[] {
  const db = getDb();

  // Get all distinct themes for tweets in this list since the window
  const themes = db
    .prepare(
      `SELECT DISTINCT tt.theme
       FROM tweet_themes tt
       JOIN tweets t ON tt.tweet_id = t.id
       WHERE t.list_id = ? AND t.created_at >= ?
       ORDER BY tt.theme`,
    )
    .all(listId, since) as Array<{ theme: string }>;

  const snapshots: ConsensusSnapshot[] = [];

  for (const { theme } of themes) {
    const snapshot = generateConsensusSnapshot(listId, theme, since);
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }

  return snapshots;
}

// ─── Consensus Alerts ────────────────────────────────────────────────────────

export interface ConsensusAlert {
  theme: string;
  consensus_pct: number;
  direction: string;
  rolling_7d_avg: number;
  historical_date?: string;
  historical_direction?: string;
}

/**
 * For each theme with recent tweets:
 * 1. Get latest consensus snapshot
 * 2. Compute 7-day rolling avg using window function query
 * 3. If current consensus_pct > thresholdPct AND current > rolling_7d_avg + 15, alert
 * 4. Find historical: last time consensus on this theme was > thresholdPct
 */
export function detectConsensusAlerts(
  listId: string,
  thresholdPct: number,
): ConsensusAlert[] {
  const db = getDb();
  const alerts: ConsensusAlert[] = [];

  // Get themes with recent tweets (last 24 hours)
  const recentThemes = getRecentThemes(listId, 24);

  for (const theme of recentThemes) {
    // Get the latest consensus snapshot for this theme
    const latest = db
      .prepare(
        `SELECT *
         FROM consensus_snapshots
         WHERE list_id = ? AND theme = ?
         ORDER BY snapshot_at DESC
         LIMIT 1`,
      )
      .get(listId, theme) as any;

    if (!latest) continue;

    // Compute 7-day rolling average using window function
    const rollingRow = db
      .prepare(
        `SELECT AVG(consensus_pct) AS rolling_avg
         FROM consensus_snapshots
         WHERE list_id = ? AND theme = ?
           AND snapshot_at >= datetime(?, '-7 days')
           AND snapshot_at <= ?`,
      )
      .get(listId, theme, latest.snapshot_at, latest.snapshot_at) as {
      rolling_avg: number | null;
    };

    const rolling7dAvg = rollingRow?.rolling_avg ?? 0;

    // Check threshold conditions
    if (
      latest.consensus_pct > thresholdPct &&
      latest.consensus_pct > rolling7dAvg + 15
    ) {
      // Find historical: last time consensus was above threshold before this snapshot
      const historical = db
        .prepare(
          `SELECT snapshot_at, consensus_direction
           FROM consensus_snapshots
           WHERE list_id = ? AND theme = ?
             AND consensus_pct > ?
             AND snapshot_at < ?
           ORDER BY snapshot_at DESC
           LIMIT 1`,
        )
        .get(listId, theme, thresholdPct, latest.snapshot_at) as
        | { snapshot_at: string; consensus_direction: string }
        | undefined;

      const alert: ConsensusAlert = {
        theme,
        consensus_pct: latest.consensus_pct,
        direction: latest.consensus_direction,
        rolling_7d_avg: Math.round(rolling7dAvg * 100) / 100,
      };

      if (historical) {
        alert.historical_date = historical.snapshot_at;
        alert.historical_direction = historical.consensus_direction;
      }

      alerts.push(alert);
    }
  }

  return alerts;
}

// ─── Emerging Narratives ─────────────────────────────────────────────────────

export interface EmergingNarrative {
  topic: string;
  account_count: number;
  first_mention: string;
}

/**
 * Detect emerging narratives:
 * 1. Get all topics (entity_value of type 'topic') mentioned by >3 unique accounts in last 6 hours
 * 2. Check if topic appeared in last 30 days of history
 * 3. If not in history AND dataAgeDays >= 7 (suppress cold-start), return as emerging
 */
export function detectEmergingNarratives(
  listId: string,
  dataAgeDays: number,
): EmergingNarrative[] {
  // Suppress cold-start: need at least 7 days of data
  if (dataAgeDays < 7) {
    return [];
  }

  const db = getDb();

  // Get topics mentioned by >3 unique accounts in the last 6 hours
  const recentTopics = db
    .prepare(
      `SELECT
         te.entity_value AS topic,
         COUNT(DISTINCT t.author_id) AS account_count,
         MIN(t.created_at) AS first_mention
       FROM tweet_entities te
       JOIN tweets t ON te.tweet_id = t.id
       WHERE te.entity_type = 'topic'
         AND t.list_id = ?
         AND t.created_at >= datetime('now', '-6 hours')
       GROUP BY te.entity_value
       HAVING COUNT(DISTINCT t.author_id) > 3
       ORDER BY account_count DESC`,
    )
    .all(listId) as Array<{
    topic: string;
    account_count: number;
    first_mention: string;
  }>;

  const emerging: EmergingNarrative[] = [];

  for (const row of recentTopics) {
    // Check if this topic appeared in the prior 30 days (excluding the last 6 hours)
    const historicalCount = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM tweet_entities te
         JOIN tweets t ON te.tweet_id = t.id
         WHERE te.entity_type = 'topic'
           AND te.entity_value = ?
           AND t.list_id = ?
           AND t.created_at >= datetime('now', '-30 days')
           AND t.created_at < datetime('now', '-6 hours')`,
      )
      .get(row.topic, listId) as { cnt: number };

    if (historicalCount.cnt === 0) {
      emerging.push({
        topic: row.topic,
        account_count: row.account_count,
        first_mention: row.first_mention,
      });
    }
  }

  return emerging;
}

// ─── Price After Consensus ───────────────────────────────────────────────────

export interface PriceResult {
  ticker: string;
  startPrice: number;
  endPrice: number;
  changePct: number;
}

/**
 * Look up price change for related ticker(s) in the prices table after a
 * consensus event. Maps themes to tickers using THEME_TICKER_MAP.
 */
export function getPriceAfterConsensus(
  theme: string,
  consensusDate: string,
  daysAfter: number,
): PriceResult | null {
  const tickers = THEME_TICKER_MAP[theme];
  if (!tickers || tickers.length === 0) return null;

  const startDate = consensusDate.slice(0, 10); // YYYY-MM-DD
  const endDateObj = new Date(startDate);
  endDateObj.setDate(endDateObj.getDate() + daysAfter);
  const endDate = endDateObj.toISOString().slice(0, 10);

  // Try each ticker until we find one with data
  for (const ticker of tickers) {
    const prices = getPriceData(ticker, startDate, endDate);

    if (prices.length < 2) continue;

    const startPrice = prices[0].close;
    const endPrice = prices[prices.length - 1].close;
    const changePct =
      startPrice !== 0
        ? Math.round(((endPrice - startPrice) / startPrice) * 10000) / 100
        : 0;

    return {
      ticker,
      startPrice,
      endPrice,
      changePct,
    };
  }

  return null;
}
