import { describe, it, expect } from 'vitest';
import { parseTweetEntry } from '../src/scraper.js';

describe('parseTweetEntry', () => {
  const LIST_ID = 'test-list-123';

  function makeTweetEntry(overrides: Record<string, any> = {}) {
    return {
      entryId: 'tweet-123',
      content: {
        itemContent: {
          tweet_results: {
            result: {
              __typename: 'Tweet',
              legacy: {
                id_str: '1234567890',
                full_text: 'Test tweet about $NVDA',
                created_at: 'Wed Mar 26 12:00:00 +0000 2026',
                favorite_count: 42,
                retweet_count: 10,
                reply_count: 3,
                in_reply_to_status_id_str: null,
                in_reply_to_user_id_str: null,
                entities: { media: [] },
                ...overrides.legacy,
              },
              core: {
                user_results: {
                  result: {
                    rest_id: 'author-456',
                    legacy: {
                      screen_name: 'testuser',
                      name: 'Test User',
                      followers_count: 5000,
                      ...overrides.userLegacy,
                    },
                    ...overrides.userResult,
                  },
                },
              },
              quoted_status_result: overrides.quotedStatus ?? null,
              ...overrides.result,
            },
          },
        },
      },
    };
  }

  it('parses a standard tweet entry', () => {
    const entry = makeTweetEntry();
    const result = parseTweetEntry(entry, LIST_ID);

    expect(result).not.toBeNull();
    expect(result!.tweet.id).toBe('1234567890');
    expect(result!.tweet.text).toBe('Test tweet about $NVDA');
    expect(result!.tweet.author_handle).toBe('testuser');
    expect(result!.tweet.engagement_likes).toBe(42);
    expect(result!.tweet.list_id).toBe(LIST_ID);
    expect(result!.account.author_id).toBe('author-456');
    expect(result!.account.follower_count).toBe(5000);
  });

  it('returns null for missing required fields (no id)', () => {
    const entry = makeTweetEntry({ legacy: { id_str: null } });
    expect(parseTweetEntry(entry, LIST_ID)).toBeNull();
  });

  it('returns null for missing required fields (no text)', () => {
    const entry = makeTweetEntry({ legacy: { full_text: null } });
    expect(parseTweetEntry(entry, LIST_ID)).toBeNull();
  });

  it('returns null for tombstone tweets', () => {
    const entry = makeTweetEntry({ result: { __typename: 'TweetTombstone' } });
    // Need to override the whole result to be a tombstone
    const tombstone = {
      entryId: 'tweet-tombstone',
      content: {
        itemContent: {
          tweet_results: {
            result: { __typename: 'TweetTombstone' },
          },
        },
      },
    };
    expect(parseTweetEntry(tombstone, LIST_ID)).toBeNull();
  });

  it('returns null for null/undefined entry', () => {
    expect(parseTweetEntry(null, LIST_ID)).toBeNull();
    expect(parseTweetEntry(undefined, LIST_ID)).toBeNull();
  });

  it('handles TweetWithVisibilityResults wrapper', () => {
    const entry = {
      entryId: 'tweet-vis',
      content: {
        itemContent: {
          tweet_results: {
            result: {
              __typename: 'TweetWithVisibilityResults',
              tweet: {
                __typename: 'Tweet',
                legacy: {
                  id_str: '999',
                  full_text: 'Visibility wrapped tweet',
                  created_at: 'Wed Mar 26 12:00:00 +0000 2026',
                  favorite_count: 1,
                  retweet_count: 0,
                  reply_count: 0,
                  entities: {},
                },
                core: {
                  user_results: {
                    result: {
                      rest_id: 'author-vis',
                      legacy: {
                        screen_name: 'visuser',
                        name: 'Vis User',
                        followers_count: 100,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const result = parseTweetEntry(entry, LIST_ID);
    expect(result).not.toBeNull();
    expect(result!.tweet.id).toBe('999');
    expect(result!.tweet.text).toBe('Visibility wrapped tweet');
  });

  it('detects self-reply as thread', () => {
    const entry = makeTweetEntry({
      legacy: {
        in_reply_to_status_id_str: '111',
        in_reply_to_user_id_str: 'author-456', // same as rest_id
      },
    });
    const result = parseTweetEntry(entry, LIST_ID);
    expect(result).not.toBeNull();
    expect(result!.tweet.is_thread).toBe(true);
    expect(result!.tweet.thread_id).toBe('111');
  });

  it('does not flag reply to other user as thread', () => {
    const entry = makeTweetEntry({
      legacy: {
        in_reply_to_status_id_str: '222',
        in_reply_to_user_id_str: 'other-user-789',
      },
    });
    const result = parseTweetEntry(entry, LIST_ID);
    expect(result).not.toBeNull();
    expect(result!.tweet.is_thread).toBe(false);
  });

  it('extracts media URLs', () => {
    const entry = makeTweetEntry({
      legacy: {
        entities: {
          media: [
            { media_url_https: 'https://pbs.twimg.com/media/abc.jpg' },
            { media_url_https: 'https://pbs.twimg.com/media/def.png' },
          ],
        },
      },
    });
    const result = parseTweetEntry(entry, LIST_ID);
    expect(result!.tweet.media_urls).toEqual([
      'https://pbs.twimg.com/media/abc.jpg',
      'https://pbs.twimg.com/media/def.png',
    ]);
  });

  it('defaults engagement to 0 when missing', () => {
    const entry = makeTweetEntry({
      legacy: {
        favorite_count: undefined,
        retweet_count: undefined,
        reply_count: undefined,
      },
    });
    const result = parseTweetEntry(entry, LIST_ID);
    expect(result!.tweet.engagement_likes).toBe(0);
    expect(result!.tweet.engagement_retweets).toBe(0);
    expect(result!.tweet.engagement_replies).toBe(0);
  });
});
