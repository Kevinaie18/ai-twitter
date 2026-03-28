import type { Tweet, Account } from './types.js';
import { ScraperError } from './types.js';
import { getKvValue, setKvValue } from './db.js';

// ─── Constants ──────────────────────────────────────────────────────────────

// X's public bearer token (embedded in the web client JS bundle, not a secret)
const BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const GRAPHQL_BASE = 'https://x.com/i/api/graphql';

const FEATURES: Record<string, boolean> = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ScrapeOptions {
  maxPages: number;
  lastKnownTweetId?: string | null;
}

export interface ScrapeResult {
  tweets: Tweet[];
  accounts: Account[];
  parseFailures: number;
}

// ─── Query Hash Discovery ───────────────────────────────────────────────────

/**
 * Fetch the X web client's main JS bundle and extract the query hash
 * for the ListLatestTweetsTimeline GraphQL endpoint.
 *
 * X embeds query hashes in the bundled JS. We look for the operation name
 * "ListLatestTweetsTimeline" and grab the hash that precedes it.
 */
export async function discoverQueryHash(): Promise<string> {
  try {
    // Step 1: Fetch the X homepage to find the main bundle URL
    const homepageRes = await fetch('https://x.com', {
      headers: { 'User-Agent': UA },
    });

    if (!homepageRes.ok) {
      throw new ScraperError(
        'auth',
        `Failed to fetch X homepage: HTTP ${homepageRes.status}`,
      );
    }

    const html = await homepageRes.text();

    // Find the main client bundle script(s) — look for URLs like
    // https://abs.twimg.com/responsive-web/client-web/main.XXXXXXXX.js
    const scriptMatches = html.match(
      /https:\/\/abs\.twimg\.com\/responsive-web\/client-web[-a-z]*\/main\.[a-f0-9]+a?\.js/g,
    );

    if (!scriptMatches?.length) {
      throw new ScraperError(
        'parse',
        'Could not find X client bundle URL in homepage HTML',
      );
    }

    // Step 2: Check each bundle for the ListLatestTweetsTimeline query hash
    for (const bundleUrl of scriptMatches) {
      const bundleRes = await fetch(bundleUrl, {
        headers: { 'User-Agent': UA },
      });

      if (!bundleRes.ok) continue;

      const js = await bundleRes.text();

      // The hash appears near the operation name in a pattern like:
      // queryId:"XXXXXXXX",operationName:"ListLatestTweetsTimeline"
      // or {queryId:"XXXXXXXX",...operationName:"ListLatestTweetsTimeline"}
      const hashMatch = js.match(
        /queryId:\s*"([A-Za-z0-9_-]+)"[^}]*?operationName:\s*"ListLatestTweetsTimeline"/,
      );

      if (hashMatch?.[1]) {
        return hashMatch[1];
      }

      // Alternative pattern: hash appears as a key in an exports map
      const altMatch = js.match(
        /"([A-Za-z0-9_-]{15,})"[^"]*?ListLatestTweetsTimeline/,
      );

      if (altMatch?.[1]) {
        return altMatch[1];
      }
    }

    throw new ScraperError(
      'parse',
      'ListLatestTweetsTimeline query hash not found in any X client bundle',
    );
  } catch (error) {
    if (error instanceof ScraperError) throw error;
    throw new ScraperError(
      'parse',
      `Failed to discover query hash: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ─── List Scraper ───────────────────────────────────────────────────────────

/**
 * Scrape tweets from an X List using the GraphQL ListLatestTweetsTimeline
 * endpoint. Paginates via cursor until one of:
 *   - No more tweet entries in the page (only cursor entries remain)
 *   - We encounter `lastKnownTweetId` (already scraped)
 *   - We hit `maxPages`
 *
 * Requires authenticated session cookies: `auth_token` and `ct0` (CSRF).
 */
export async function scrapeList(
  listId: string,
  authToken: string,
  ct0: string,
  options: ScrapeOptions,
): Promise<ScrapeResult> {
  const { maxPages, lastKnownTweetId } = options;

  // Query hash resolution: cached (if <24h) → discover → cached (any age) → hardcoded
  let queryHash: string;
  const HASH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const HARDCODED_FALLBACK = 'L1DeQfPt7n3LtTvrBqkJ2g';

  const cached = getKvValue('query_hash');
  if (cached && (Date.now() - new Date(cached.updated_at).getTime()) < HASH_TTL_MS) {
    queryHash = cached.value;
  } else {
    try {
      queryHash = await discoverQueryHash();
      setKvValue('query_hash', queryHash);
    } catch {
      // Fall back to cached hash (any age), then hardcoded
      if (cached) {
        console.warn('[scraper] Discovery failed; using stale cached hash');
        queryHash = cached.value;
      } else {
        console.warn('[scraper] Discovery failed, no cache; using hardcoded fallback');
        queryHash = HARDCODED_FALLBACK;
      }
    }
  }

  const allTweets: Tweet[] = [];
  const accountMap = new Map<string, Account>();
  let parseFailures = 0;
  let cursor: string | undefined;
  let hitLastKnown = false;

  for (let page = 0; page < maxPages; page++) {
    const variables: Record<string, unknown> = {
      listId,
      count: 100,
    };
    if (cursor) {
      variables.cursor = cursor;
    }

    const url = new URL(`${GRAPHQL_BASE}/${queryHash}/ListLatestTweetsTimeline`);
    url.searchParams.set('variables', JSON.stringify(variables));
    url.searchParams.set('features', JSON.stringify(FEATURES));

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${BEARER}`,
          'Content-Type': 'application/json',
          'User-Agent': UA,
          'x-csrf-token': ct0,
          Cookie: `auth_token=${authToken}; ct0=${ct0}`,
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-active-user': 'yes',
          'x-twitter-client-language': 'en',
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new ScraperError('timeout', `Request timed out on page ${page + 1}`);
      }
      throw new ScraperError(
        'unknown',
        `Network error on page ${page + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // ── Handle HTTP errors ─────────────────────────────────────────────
    if (response.status === 401 || response.status === 403) {
      throw new ScraperError(
        'auth',
        `Authentication failed (HTTP ${response.status}). Check auth_token and ct0 cookies.`,
      );
    }
    if (response.status === 429) {
      throw new ScraperError(
        'rate_limit',
        'Rate limited by X API. Back off and retry later.',
      );
    }
    if (!response.ok) {
      throw new ScraperError(
        'unknown',
        `X API returned HTTP ${response.status} on page ${page + 1}`,
      );
    }

    // ── Parse JSON ─────────────────────────────────────────────────────
    let json: any;
    try {
      json = await response.json();
    } catch {
      throw new ScraperError('parse', `Invalid JSON response on page ${page + 1}`);
    }

    // ── Navigate to timeline entries ───────────────────────────────────
    const instructions =
      json?.data?.list?.tweets_timeline?.timeline?.instructions;

    if (!Array.isArray(instructions)) {
      throw new ScraperError(
        'parse',
        `Unexpected response structure on page ${page + 1}: no instructions array`,
      );
    }

    // Find the "TimelineAddEntries" or "TimelineAddToModule" instruction
    const addEntries = instructions.find(
      (i: any) =>
        i?.type === 'TimelineAddEntries' || i?.type === 'TimelineAddToModule',
    );

    const entries: any[] = addEntries?.entries ?? [];

    if (!entries.length) {
      // No entries at all — we've exhausted the list
      break;
    }

    // ── Separate tweet entries from cursor entries ──────────────────────
    let tweetEntriesFound = 0;
    let nextCursor: string | undefined;

    for (const entry of entries) {
      const entryId: string | undefined = entry?.entryId;

      // Cursor entries
      if (entryId?.startsWith('cursor-bottom-')) {
        nextCursor = entry?.content?.value;
        continue;
      }

      // Skip non-tweet entries (cursors, promoted, etc.)
      if (!entryId?.startsWith('tweet-')) {
        continue;
      }

      tweetEntriesFound++;

      // ── Parse a single tweet entry ───────────────────────────────────
      try {
        const parsed = parseTweetEntry(entry, listId);
        if (!parsed) {
          parseFailures++;
          continue;
        }

        const { tweet, account } = parsed;

        // Stop if we've reached a tweet we already have
        if (lastKnownTweetId && tweet.id === lastKnownTweetId) {
          hitLastKnown = true;
          break;
        }

        allTweets.push(tweet);

        // Track unique accounts (keep the latest-seen version)
        const existing = accountMap.get(account.author_id);
        if (!existing || account.last_seen_at > existing.last_seen_at) {
          accountMap.set(account.author_id, account);
        }
      } catch (error) {
        parseFailures++;
        console.warn(
          `[scraper] Failed to parse tweet entry ${entryId ?? 'unknown'}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // ── Decide whether to continue paging ──────────────────────────────
    if (hitLastKnown) break;
    if (tweetEntriesFound === 0) break; // Only cursor entries — no more tweets
    if (!nextCursor) break; // No next-page cursor

    cursor = nextCursor;
  }

  return {
    tweets: allTweets,
    accounts: Array.from(accountMap.values()),
    parseFailures,
  };
}

// ─── Tweet Parsing ──────────────────────────────────────────────────────────

export interface ParsedEntry {
  tweet: Tweet;
  account: Account;
}

/**
 * Parse a single timeline entry into a Tweet + Account.
 * Returns null if the entry is malformed (logged as warning, never throws).
 */
export function parseTweetEntry(entry: any, listId: string): ParsedEntry | null {
  // Navigate through the tweet result wrapper.
  // Tweets can be nested under content.itemContent.tweet_results.result,
  // and may have a __typename of "TweetWithVisibilityResults" wrapping the actual tweet.
  let result = entry?.content?.itemContent?.tweet_results?.result;

  // Handle TweetWithVisibilityResults wrapper
  if (result?.__typename === 'TweetWithVisibilityResults') {
    result = result?.tweet;
  }

  // Some entries are tombstones or unavailable tweets
  if (!result || result?.__typename === 'TweetTombstone') {
    return null;
  }

  const legacy = result?.legacy;
  const userResult = result?.core?.user_results?.result;
  const userLegacy = userResult?.legacy;

  // ── Required fields — skip if missing ────────────────────────────────
  const tweetId = legacy?.id_str;
  const authorId = userResult?.rest_id;
  const text = legacy?.full_text;

  if (!tweetId || !authorId || !text) {
    const entryId = entry?.entryId ?? 'unknown';
    console.warn(
      `[scraper] Skipping entry ${entryId}: missing required fields (id=${tweetId}, author=${authorId}, text=${!!text})`,
    );
    return null;
  }

  // ── Author info ──────────────────────────────────────────────────────
  // X moves fields between legacy and core — check both with core first
  const userCore = userResult?.core;
  const authorHandle: string = userCore?.screen_name ?? userLegacy?.screen_name ?? 'unknown';
  const authorName: string = userCore?.name ?? userLegacy?.name ?? authorHandle;
  const followerCount: number = userCore?.followers_count ?? userLegacy?.followers_count ?? 0;

  // ── Engagement metrics ───────────────────────────────────────────────
  const engagementLikes: number = legacy?.favorite_count ?? 0;
  const engagementRetweets: number = legacy?.retweet_count ?? 0;
  const engagementReplies: number = legacy?.reply_count ?? 0;

  // ── Thread detection (self-reply) ────────────────────────────────────
  const inReplyToStatusId: string | null =
    legacy?.in_reply_to_status_id_str ?? null;
  const inReplyToUserId: string | null =
    legacy?.in_reply_to_user_id_str ?? null;
  const isThread: boolean =
    !!inReplyToStatusId && inReplyToUserId === authorId;
  const threadId: string | null = inReplyToStatusId;

  // ── Media URLs ───────────────────────────────────────────────────────
  const mediaEntities: any[] = legacy?.entities?.media ?? [];
  const mediaUrls: string[] = mediaEntities
    .map((m: any) => m?.media_url_https)
    .filter((url: unknown): url is string => typeof url === 'string');

  // ── Quoted tweet ─────────────────────────────────────────────────────
  const quotedTweetId: string | null =
    result?.quoted_status_result?.result?.legacy?.id_str ?? null;

  // ── Timestamps ───────────────────────────────────────────────────────
  const createdAt: string = legacy?.created_at ?? new Date().toISOString();
  const scrapedAt: string = new Date().toISOString();

  const tweet: Tweet = {
    id: tweetId,
    list_id: listId,
    author_id: authorId,
    author_handle: authorHandle,
    author_name: authorName,
    text,
    created_at: createdAt,
    scraped_at: scrapedAt,
    engagement_likes: engagementLikes,
    engagement_retweets: engagementRetweets,
    engagement_replies: engagementReplies,
    is_thread: isThread,
    thread_id: threadId,
    media_urls: mediaUrls,
    quoted_tweet_id: quotedTweetId,
  };

  const account: Account = {
    author_id: authorId,
    author_handle: authorHandle,
    author_name: authorName,
    follower_count: followerCount,
    first_seen_at: scrapedAt,
    last_seen_at: scrapedAt,
  };

  return { tweet, account };
}
