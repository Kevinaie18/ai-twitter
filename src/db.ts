import Database from 'better-sqlite3';
import path from 'path';
import { createRequire } from 'module';
import type {
  Tweet,
  Account,
  ConsensusSnapshot,
  Entity,
  Theme,
} from './types.js';

// ─── Module-level DB instance ────────────────────────────────────────────────

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

// ─── Initialization ──────────────────────────────────────────────────────────

export function initDb(dbPath: string): Database.Database {
  db = new Database(dbPath);

  // Enable WAL mode for concurrent reads
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Load sqlite-vec extension
  try {
    const require = createRequire(import.meta.url);
    const sqliteVecPath = require.resolve('sqlite-vec');
    const extDir = path.dirname(sqliteVecPath);
    // sqlite-vec npm package exposes a .node or .so/.dylib file
    // Try common extension file patterns
    const possibleExts = ['vec0.dylib', 'vec0.so', 'vec0.dll', 'vec0'];
    let loaded = false;
    for (const ext of possibleExts) {
      try {
        db.loadExtension(path.join(extDir, ext));
        loaded = true;
        break;
      } catch {
        // try next
      }
    }
    if (!loaded) {
      // Try loading the path directly from the package
      try {
        const sqliteVec = require('sqlite-vec');
        if (typeof sqliteVec.loadable === 'function') {
          db.loadExtension(sqliteVec.loadable());
          loaded = true;
        } else if (typeof sqliteVec.load === 'function') {
          sqliteVec.load(db);
          loaded = true;
        }
      } catch {
        console.warn('sqlite-vec extension not loaded — vector search unavailable');
      }
    }
  } catch {
    console.warn('sqlite-vec package not found — vector search unavailable');
  }

  createTables();
  return db;
}

function createTables(): void {
  db.exec(`
    -- ─── Core tables ───────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS tweets (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_handle TEXT NOT NULL,
      author_name TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      scraped_at TEXT NOT NULL,
      engagement_likes INTEGER NOT NULL DEFAULT 0,
      engagement_retweets INTEGER NOT NULL DEFAULT 0,
      engagement_replies INTEGER NOT NULL DEFAULT 0,
      is_thread INTEGER NOT NULL DEFAULT 0,
      thread_id TEXT,
      media_urls TEXT NOT NULL DEFAULT '[]',
      quoted_tweet_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tweets_list_id ON tweets(list_id);
    CREATE INDEX IF NOT EXISTS idx_tweets_created_at ON tweets(created_at);
    CREATE INDEX IF NOT EXISTS idx_tweets_author_id ON tweets(author_id);
    CREATE INDEX IF NOT EXISTS idx_tweets_list_created ON tweets(list_id, created_at);

    -- ─── Accounts ──────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS accounts (
      author_id TEXT PRIMARY KEY,
      author_handle TEXT NOT NULL,
      author_name TEXT NOT NULL,
      follower_count INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    -- ─── Enrichments ───────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS enrichments (
      tweet_id TEXT PRIMARY KEY REFERENCES tweets(id),
      sentiment TEXT,
      sentiment_confidence REAL,
      novelty_score REAL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      enriched_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_enrichments_status ON enrichments(status);

    -- ─── Entity junction table ─────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS tweet_entities (
      tweet_id TEXT NOT NULL REFERENCES tweets(id),
      entity_type TEXT NOT NULL,
      entity_value TEXT NOT NULL,
      PRIMARY KEY (tweet_id, entity_type, entity_value)
    );

    CREATE INDEX IF NOT EXISTS idx_tweet_entities_value ON tweet_entities(entity_value);
    CREATE INDEX IF NOT EXISTS idx_tweet_entities_type ON tweet_entities(entity_type);

    -- ─── Theme junction table ──────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS tweet_themes (
      tweet_id TEXT NOT NULL REFERENCES tweets(id),
      theme TEXT NOT NULL,
      PRIMARY KEY (tweet_id, theme)
    );

    CREATE INDEX IF NOT EXISTS idx_tweet_themes_theme ON tweet_themes(theme);

    -- ─── Consensus snapshots ───────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS consensus_snapshots (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      theme TEXT NOT NULL,
      snapshot_at TEXT NOT NULL,
      total_accounts INTEGER NOT NULL,
      bullish_count INTEGER NOT NULL,
      bearish_count INTEGER NOT NULL,
      neutral_count INTEGER NOT NULL,
      consensus_pct REAL NOT NULL,
      consensus_direction TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_consensus_list_theme ON consensus_snapshots(list_id, theme);
    CREATE INDEX IF NOT EXISTS idx_consensus_snapshot_at ON consensus_snapshots(snapshot_at);

    -- ─── List configs (runtime / DB) ───────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS list_configs (
      list_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      scrape_interval_min INTEGER NOT NULL DEFAULT 30,
      active INTEGER NOT NULL DEFAULT 1,
      added_at TEXT NOT NULL
    );

    -- ─── Prices (for backtesting) ──────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS prices (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      close REAL NOT NULL,
      PRIMARY KEY (ticker, date)
    );

    -- ─── FTS5 full-text search ─────────────────────────────────────────────────

    CREATE VIRTUAL TABLE IF NOT EXISTS tweets_fts USING fts5(
      text,
      content='tweets',
      content_rowid='rowid'
    );

    -- FTS sync triggers
    CREATE TRIGGER IF NOT EXISTS tweets_ai AFTER INSERT ON tweets BEGIN
      INSERT INTO tweets_fts(rowid, text) VALUES (new.rowid, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS tweets_ad AFTER DELETE ON tweets BEGIN
      INSERT INTO tweets_fts(tweets_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS tweets_au AFTER UPDATE ON tweets BEGIN
      INSERT INTO tweets_fts(tweets_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO tweets_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);

  // sqlite-vec virtual table (may fail if extension not loaded)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS tweet_embeddings USING vec0(
        tweet_id TEXT PRIMARY KEY,
        embedding float[1536]
      );
    `);
  } catch {
    console.warn('Could not create tweet_embeddings vec0 table — sqlite-vec may not be loaded');
  }
}

// ─── Tweet Operations ────────────────────────────────────────────────────────

export function insertTweets(tweets: Tweet[]): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO tweets (
      id, list_id, author_id, author_handle, author_name, text,
      created_at, scraped_at, engagement_likes, engagement_retweets,
      engagement_replies, is_thread, thread_id, media_urls, quoted_tweet_id
    ) VALUES (
      @id, @list_id, @author_id, @author_handle, @author_name, @text,
      @created_at, @scraped_at, @engagement_likes, @engagement_retweets,
      @engagement_replies, @is_thread, @thread_id, @media_urls, @quoted_tweet_id
    )
  `);

  const insertMany = db.transaction((items: Tweet[]) => {
    for (const tweet of items) {
      insert.run({
        id: tweet.id,
        list_id: tweet.list_id,
        author_id: tweet.author_id,
        author_handle: tweet.author_handle,
        author_name: tweet.author_name,
        text: tweet.text,
        created_at: tweet.created_at,
        scraped_at: tweet.scraped_at,
        engagement_likes: tweet.engagement_likes,
        engagement_retweets: tweet.engagement_retweets,
        engagement_replies: tweet.engagement_replies,
        is_thread: tweet.is_thread ? 1 : 0,
        thread_id: tweet.thread_id,
        media_urls: JSON.stringify(tweet.media_urls),
        quoted_tweet_id: tweet.quoted_tweet_id,
      });
    }
  });

  insertMany(tweets);
}

// ─── Account Operations ──────────────────────────────────────────────────────

export function upsertAccount(account: Account): void {
  db.prepare(`
    INSERT INTO accounts (author_id, author_handle, author_name, follower_count, first_seen_at, last_seen_at)
    VALUES (@author_id, @author_handle, @author_name, @follower_count, @first_seen_at, @last_seen_at)
    ON CONFLICT(author_id) DO UPDATE SET
      author_handle = @author_handle,
      author_name = @author_name,
      follower_count = @follower_count,
      last_seen_at = @last_seen_at
  `).run({
    author_id: account.author_id,
    author_handle: account.author_handle,
    author_name: account.author_name,
    follower_count: account.follower_count,
    first_seen_at: account.first_seen_at,
    last_seen_at: account.last_seen_at,
  });
}

// ─── Enrichment Operations ───────────────────────────────────────────────────

export function getUnenrichedTweets(limit: number): Tweet[] {
  const rows = db.prepare(`
    SELECT t.*
    FROM tweets t
    LEFT JOIN enrichments e ON t.id = e.tweet_id
    WHERE e.tweet_id IS NULL OR e.status = 'failed'
    ORDER BY t.created_at DESC
    LIMIT ?
  `).all(limit) as any[];

  return rows.map(rowToTweet);
}

export function markEnrichmentComplete(
  tweetId: string,
  data: {
    entities: Entity[];
    themes: Theme[];
    sentiment: string;
    sentiment_confidence: number;
    novelty_score: number;
    summary: string;
  }
): void {
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    // Upsert enrichment row
    db.prepare(`
      INSERT INTO enrichments (tweet_id, sentiment, sentiment_confidence, novelty_score, summary, status, enriched_at)
      VALUES (?, ?, ?, ?, ?, 'complete', ?)
      ON CONFLICT(tweet_id) DO UPDATE SET
        sentiment = excluded.sentiment,
        sentiment_confidence = excluded.sentiment_confidence,
        novelty_score = excluded.novelty_score,
        summary = excluded.summary,
        status = 'complete',
        enriched_at = excluded.enriched_at
    `).run(
      tweetId,
      data.sentiment,
      data.sentiment_confidence,
      data.novelty_score,
      data.summary,
      now,
    );

    // Insert entities into junction table
    const insertEntity = db.prepare(`
      INSERT OR IGNORE INTO tweet_entities (tweet_id, entity_type, entity_value)
      VALUES (?, ?, ?)
    `);
    for (const entity of data.entities) {
      insertEntity.run(tweetId, entity.entity_type, entity.entity_value);
    }

    // Insert themes into junction table
    const insertTheme = db.prepare(`
      INSERT OR IGNORE INTO tweet_themes (tweet_id, theme)
      VALUES (?, ?)
    `);
    for (const theme of data.themes) {
      insertTheme.run(tweetId, theme.theme);
    }
  });

  tx();
}

export function markEnrichmentFailed(tweetId: string): void {
  db.prepare(`
    INSERT INTO enrichments (tweet_id, status)
    VALUES (?, 'failed')
    ON CONFLICT(tweet_id) DO UPDATE SET status = 'failed'
  `).run(tweetId);
}

// ─── Embedding / Vector Operations ───────────────────────────────────────────

export function insertEmbedding(tweetId: string, embedding: number[]): void {
  const float32 = new Float32Array(embedding);
  db.prepare(`
    INSERT INTO tweet_embeddings (tweet_id, embedding)
    VALUES (?, ?)
  `).run(tweetId, Buffer.from(float32.buffer));
}

export function searchSimilar(embedding: number[], limit: number): Array<{ tweet_id: string; distance: number }> {
  const float32 = new Float32Array(embedding);
  const rows = db.prepare(`
    SELECT tweet_id, distance
    FROM tweet_embeddings
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(Buffer.from(float32.buffer), limit) as Array<{ tweet_id: string; distance: number }>;

  return rows;
}

// ─── Query Operations ────────────────────────────────────────────────────────

export function getTweetsByTheme(theme: string, since: string, listId?: string): any[] {
  if (listId) {
    return db.prepare(`
      SELECT t.*, e.sentiment, e.sentiment_confidence, e.novelty_score, e.summary
      FROM tweets t
      JOIN tweet_themes tt ON t.id = tt.tweet_id
      LEFT JOIN enrichments e ON t.id = e.tweet_id
      WHERE tt.theme = ? AND t.created_at >= ? AND t.list_id = ?
      ORDER BY t.created_at DESC
    `).all(theme, since, listId);
  }
  return db.prepare(`
    SELECT t.*, e.sentiment, e.sentiment_confidence, e.novelty_score, e.summary
    FROM tweets t
    JOIN tweet_themes tt ON t.id = tt.tweet_id
    LEFT JOIN enrichments e ON t.id = e.tweet_id
    WHERE tt.theme = ? AND t.created_at >= ?
    ORDER BY t.created_at DESC
  `).all(theme, since);
}

export function getTweetsByEntity(entityValue: string, since: string): any[] {
  return db.prepare(`
    SELECT t.*, e.sentiment, e.sentiment_confidence, e.novelty_score, e.summary
    FROM tweets t
    JOIN tweet_entities te ON t.id = te.tweet_id
    LEFT JOIN enrichments e ON t.id = e.tweet_id
    WHERE te.entity_value = ? AND t.created_at >= ?
    ORDER BY t.created_at DESC
  `).all(entityValue, since);
}

export function getDigestTweets(listId: string, since: string): any[] {
  return db.prepare(`
    SELECT
      t.*,
      e.sentiment,
      e.sentiment_confidence,
      e.novelty_score,
      e.summary,
      e.status AS enrichment_status
    FROM tweets t
    LEFT JOIN enrichments e ON t.id = e.tweet_id
    WHERE t.list_id = ? AND t.created_at >= ?
    ORDER BY t.created_at DESC
  `).all(listId, since);
}

// ─── Consensus Operations ────────────────────────────────────────────────────

export function insertConsensusSnapshot(snapshot: Omit<ConsensusSnapshot, 'id'>): void {
  const id = `cs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO consensus_snapshots (
      id, list_id, theme, snapshot_at, total_accounts,
      bullish_count, bearish_count, neutral_count,
      consensus_pct, consensus_direction
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    snapshot.list_id,
    snapshot.theme,
    snapshot.snapshot_at,
    snapshot.total_accounts,
    snapshot.bullish_count,
    snapshot.bearish_count,
    snapshot.neutral_count,
    snapshot.consensus_pct,
    snapshot.consensus_direction,
  );
}

export function getConsensusSnapshots(listId: string, theme: string, days: number): any[] {
  return db.prepare(`
    SELECT *
    FROM consensus_snapshots
    WHERE list_id = ? AND theme = ?
      AND snapshot_at >= datetime('now', '-' || ? || ' days')
    ORDER BY snapshot_at DESC
  `).all(listId, theme, days);
}

export function getLatestConsensusForAllThemes(listId: string): any[] {
  return db.prepare(`
    SELECT cs.*
    FROM consensus_snapshots cs
    INNER JOIN (
      SELECT theme, MAX(snapshot_at) AS max_at
      FROM consensus_snapshots
      WHERE list_id = ?
      GROUP BY theme
    ) latest ON cs.theme = latest.theme AND cs.snapshot_at = latest.max_at
    WHERE cs.list_id = ?
    ORDER BY cs.consensus_pct DESC
  `).all(listId, listId);
}

export function getThemeAccountSentiments(
  listId: string,
  theme: string,
  since: string
): Array<{ author_id: string; author_handle: string; sentiment: string; tweet_count: number }> {
  return db.prepare(`
    SELECT
      t.author_id,
      t.author_handle,
      e.sentiment,
      COUNT(*) AS tweet_count
    FROM tweets t
    JOIN tweet_themes tt ON t.id = tt.tweet_id
    JOIN enrichments e ON t.id = e.tweet_id
    WHERE t.list_id = ?
      AND tt.theme = ?
      AND t.created_at >= ?
      AND e.status = 'complete'
    GROUP BY t.author_id, e.sentiment
    ORDER BY tweet_count DESC
  `).all(listId, theme, since) as Array<{
    author_id: string;
    author_handle: string;
    sentiment: string;
    tweet_count: number;
  }>;
}

export function getRecentThemes(listId: string, hours: number): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT tt.theme
    FROM tweet_themes tt
    JOIN tweets t ON tt.tweet_id = t.id
    WHERE t.list_id = ?
      AND t.created_at >= datetime('now', '-' || ? || ' hours')
    ORDER BY tt.theme
  `).all(listId, hours) as Array<{ theme: string }>;

  return rows.map(r => r.theme);
}

// ─── Account Queries ─────────────────────────────────────────────────────────

export function getAccountStats(authorId: string): any {
  const account = db.prepare(`
    SELECT * FROM accounts WHERE author_id = ?
  `).get(authorId);

  if (!account) return null;

  const tweetCount = db.prepare(`
    SELECT COUNT(*) AS count FROM tweets WHERE author_id = ?
  `).get(authorId) as { count: number };

  const themes = db.prepare(`
    SELECT tt.theme, COUNT(*) AS count
    FROM tweet_themes tt
    JOIN tweets t ON tt.tweet_id = t.id
    WHERE t.author_id = ?
    GROUP BY tt.theme
    ORDER BY count DESC
    LIMIT 10
  `).all(authorId) as Array<{ theme: string; count: number }>;

  const sentimentLean = db.prepare(`
    SELECT e.sentiment, COUNT(*) AS count
    FROM enrichments e
    JOIN tweets t ON e.tweet_id = t.id
    WHERE t.author_id = ? AND e.status = 'complete'
    GROUP BY e.sentiment
    ORDER BY count DESC
  `).all(authorId) as Array<{ sentiment: string; count: number }>;

  return {
    ...account,
    tweet_count: tweetCount.count,
    top_themes: themes,
    sentiment_lean: sentimentLean,
  };
}

export function getAllAccounts(listId: string): Account[] {
  return db.prepare(`
    SELECT DISTINCT a.*
    FROM accounts a
    JOIN tweets t ON a.author_id = t.author_id
    WHERE t.list_id = ?
    ORDER BY a.follower_count DESC
  `).all(listId) as Account[];
}

// ─── FTS5 Search ─────────────────────────────────────────────────────────────

export function searchTweetsFTS(query: string, limit: number): any[] {
  return db.prepare(`
    SELECT t.*, e.sentiment, e.sentiment_confidence, e.novelty_score, e.summary
    FROM tweets_fts fts
    JOIN tweets t ON t.rowid = fts.rowid
    LEFT JOIN enrichments e ON t.id = e.tweet_id
    WHERE tweets_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit);
}

// ─── Scraper Helpers ─────────────────────────────────────────────────────────

export function getLastScrapedTweetId(listId: string): string | null {
  const row = db.prepare(`
    SELECT id FROM tweets
    WHERE list_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(listId) as { id: string } | undefined;

  return row?.id ?? null;
}

export function getScrapeHealth(): Array<{ list_id: string; tweet_count: number }> {
  return db.prepare(`
    SELECT list_id, COUNT(*) AS tweet_count
    FROM tweets
    WHERE scraped_at >= datetime('now', '-2 hours')
    GROUP BY list_id
  `).all() as Array<{ list_id: string; tweet_count: number }>;
}

// ─── Price Data (Backtesting) ────────────────────────────────────────────────

export function getPriceData(
  ticker: string,
  startDate: string,
  endDate: string
): Array<{ ticker: string; date: string; close: number }> {
  return db.prepare(`
    SELECT ticker, date, close
    FROM prices
    WHERE ticker = ? AND date >= ? AND date <= ?
    ORDER BY date ASC
  `).all(ticker, startDate, endDate) as Array<{ ticker: string; date: string; close: number }>;
}

export function insertPriceData(ticker: string, date: string, close: number): void {
  db.prepare(`
    INSERT OR REPLACE INTO prices (ticker, date, close)
    VALUES (?, ?, ?)
  `).run(ticker, date, close);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rowToTweet(row: any): Tweet {
  return {
    id: row.id,
    list_id: row.list_id,
    author_id: row.author_id,
    author_handle: row.author_handle,
    author_name: row.author_name,
    text: row.text,
    created_at: row.created_at,
    scraped_at: row.scraped_at,
    engagement_likes: row.engagement_likes,
    engagement_retweets: row.engagement_retweets,
    engagement_replies: row.engagement_replies,
    is_thread: Boolean(row.is_thread),
    thread_id: row.thread_id,
    media_urls: typeof row.media_urls === 'string' ? JSON.parse(row.media_urls) : row.media_urls,
    quoted_tweet_id: row.quoted_tweet_id,
  };
}
