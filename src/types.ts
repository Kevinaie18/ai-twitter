// ─── Configuration ───────────────────────────────────────────────────────────

export interface ListConfigYaml {
  id: string;
  name: string;
  scrape_interval_min: number;
  active: boolean;
}

export interface Config {
  lists: ListConfigYaml[];
  digest: {
    timezone: string;
    morning_hour: number;
    evening_hour: number;
  };
  consensus: {
    threshold_pct: number;
  };
  enrichment: {
    batch_size: number;
    max_tweets_per_scrape: number;
  };
  dashboard: {
    port: number;
  };
  scraper: {
    max_pages_per_scrape: number;
  };
}

// ─── Core Data ──────────────────────────────────────────────────────────────

export interface Tweet {
  id: string;
  list_id: string;
  author_id: string;
  author_handle: string;
  author_name: string;
  text: string;
  created_at: string;
  scraped_at: string;
  engagement_likes: number;
  engagement_retweets: number;
  engagement_replies: number;
  is_thread: boolean;
  thread_id: string | null;
  media_urls: string[];
  quoted_tweet_id: string | null;
}

export interface Enrichment {
  tweet_id: string;
  entities: Entity[];
  themes: Theme[];
  sentiment: string;
  sentiment_confidence: number;
  novelty_score: number;
  summary: string;
  status: 'pending' | 'complete' | 'failed';
  enriched_at: string | null;
}

export interface Entity {
  tweet_id: string;
  entity_type: string;
  entity_value: string;
}

export interface Theme {
  tweet_id: string;
  theme: string;
}

// ─── Consensus ──────────────────────────────────────────────────────────────

export interface ConsensusSnapshot {
  id: string;
  list_id: string;
  theme: string;
  snapshot_at: string;
  total_accounts: number;
  bullish_count: number;
  bearish_count: number;
  neutral_count: number;
  consensus_pct: number;
  consensus_direction: string;
}

// ─── Accounts ───────────────────────────────────────────────────────────────

export interface Account {
  author_id: string;
  author_handle: string;
  author_name: string;
  follower_count: number;
  first_seen_at: string;
  last_seen_at: string;
}

// ─── List Config (runtime / DB) ─────────────────────────────────────────────

export interface ListConfig {
  list_id: string;
  name: string;
  description: string;
  scrape_interval_min: number;
  active: boolean;
  added_at: string;
}

// ─── Digest ─────────────────────────────────────────────────────────────────

export interface DigestResult {
  list_id: string;
  text: string;
  themes_covered: string[];
  tweet_count: number;
  generated_at: string;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export type ScraperErrorType =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'parse'
  | 'unknown';

export class ScraperError extends Error {
  public readonly type: ScraperErrorType;
  public readonly retryable: boolean;

  constructor(type: ScraperErrorType, message: string) {
    super(message);
    this.name = 'ScraperError';
    this.type = type;
    this.retryable = type === 'rate_limit' || type === 'timeout';
  }
}
