// ─── Configuration ───────────────────────────────────────────────────────────

export interface ListConfigYaml {
  id: string;
  name: string;
  scrape_interval_min: number;
  active: boolean;
}

export type CredibilityTag = 'journalist' | 'institutional' | 'analyst' | 'aggregator' | 'unverified';

export interface Config {
  lists: ListConfigYaml[];
  digest: {
    timezone: string;
    morning_hour: number;
    evening_hour: number;
    max_themes?: number;          // default 4
    delta_enabled?: boolean;      // default true
    format?: 'single' | 'split'; // default 'single'
    tldr_max_words?: number;      // default 150
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
  signal_floor?: {
    min_accounts?: number;        // default 3
    min_engagement?: number;      // default 50
  };
  accounts?: {
    credibility_tags?: Record<string, CredibilityTag>;
    default_tag?: CredibilityTag; // default 'unverified'
  };
  track_record?: {
    enabled?: boolean;            // default false
    resolution_days?: number;     // default 5
    min_confidence?: number;      // default 0.6
    hit_threshold_pct?: number;   // default 0.5
    min_calls_to_display?: number; // default 5
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
  credibility_tag?: CredibilityTag;
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
  tldr?: string;
  themes_covered: string[];
  tweet_count: number;
  generated_at: string;
  delta?: DigestDelta;
}

// ─── Digest Snapshots (for delta tracking) ─────────────────────────────────

export interface DigestSnapshot {
  id: string;
  list_id: string;
  generated_at: string;
  digest_type: 'morning' | 'evening' | 'manual';
  tweet_count: number;
  themes_json: string;
  consensus_json: string;
  alerts_json: string;
  emerging_json: string;
  digest_text: string;
}

export interface DigestDelta {
  new_themes: string[];
  dropped_themes: string[];
  consensus_shifts: Array<{
    theme: string;
    old_direction: string;
    old_pct: number;
    new_direction: string;
    new_pct: number;
  }>;
}

// ─── Track Record Engine ────────────────────────────────────────────────────

export interface DirectionalCall {
  id: string;
  author_id: string;
  author_handle: string;
  tweet_id: string;
  theme: string;
  ticker: string | null;
  direction: 'bullish' | 'bearish';
  confidence: number;
  call_date: string;
  price_at_call: number | null;
  resolution_days: number;
  resolved_at: string | null;
  price_at_resolve: number | null;
  price_change_pct: number | null;
  hit: boolean | null;
  status: 'open' | 'resolved' | 'expired' | 'no_data';
}

export interface AuthorTrackRecord {
  author_id: string;
  author_handle: string;
  total_calls: number;
  resolved_calls: number;
  hits: number;
  misses: number;
  hit_rate: number;
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
