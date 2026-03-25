# Twitter/X Intelligence Digest

Turn your curated Twitter/X lists into an unfair information advantage. Automated signal extraction, consensus tracking, and contrarian alerts — delivered to Telegram and a real-time dashboard.

## What It Does

You curate the list. The tool does the rest.

```
Your curated X list (~100 accounts)
        |
        v
  Scrape every 2h (GraphQL + session cookies)
        |
        v
  Enrich: entities, sentiment, themes, embeddings (Claude Haiku + OpenAI)
  Auto-discover themes via embedding similarity + Sonnet taxonomy architect
        |
        v
  Intelligence: analyst consensus, narrative tracking, delta detection, track records
        |
        v
  Deliver: Telegram digest (TL;DR + deep dive) + Web dashboard + AI-powered commands
```

**Twice-daily digests** lead with what changed since last time — consensus shifts, new themes, account flips. **Analyst consensus alerts** fire when your curated list aligns strongly on a position. **Source credibility** tags distinguish journalists from aggregators. **Track records** log directional calls and compute hit rates over time. **Semantic search** lets you query weeks of history.

## Who This Is For

Investment professionals, fund managers, and serious market participants who follow curated analyst/research accounts covering any combination of themes — the system auto-discovers new themes as they emerge.

## Features

### Intelligence Layer
- **Delta-first digests** — "What changed since last time" is the first section. Consensus shifts, new themes, dropped themes.
- **Analyst consensus** — One vote per account per window. Alerts when ≥80% align. Historical context and price backtesting.
- **Source credibility tags** — Tag accounts as `journalist`, `institutional`, `analyst`, `aggregator`, `unverified` in config. Digest prioritizes high-credibility sources.
- **Track record engine** — Logs directional calls (bullish/bearish + ticker), resolves against price data, computes per-account hit rates. Opt-in.
- **Signal noise floor** — Themes below configurable thresholds (min accounts, min engagement) are filtered from the digest.

### Auto-Discovering Theme Taxonomy
Themes are not hardcoded. The system uses a 3-tier architecture:
1. **Haiku** extracts a `topic_description` (free text) + assigns known themes when obvious
2. **Embedding similarity** (cosine ≥0.82) matches tweets against a theme registry
3. **Sonnet** (called ~1x/week) names genuinely new themes when 3+ unmatched descriptions cluster together

Core themes (semis, macro, crypto, etc.) are seeded at startup. New themes auto-appear in consensus tracking, digests, and all bot commands. No code changes needed.

### Telegram Bot
| Command | What It Does |
|---------|-------------|
| `/ask <question>` | Semantic search + Sonnet synthesis with @handle citations |
| `/consensus` | Current analyst consensus map across all themes |
| `/theme <name>` | AI-synthesized deep dive: stance, key voices, debate, what to watch |
| `/who <handle>` | AI-synthesized account profile: specialization, track record, conviction |
| `/compare` | Cross-list divergence (when 2+ lists active) |
| `/status` | System health: scraper status, enrichment queue, API costs |

Commands `/theme` and `/who` include AI synthesis (Haiku) above the raw data — 3-4 sentences of actionable intelligence.

### Telegram Digest Format
Configurable as `single` (one message) or `split` (recommended):
- **TL;DR** (~150 words) — sent as the primary message, scannable on mobile
- **Deep dive** — full digest sent as a threaded reply

### Centralized Prompts
All 7 AI prompts live in `src/prompts.ts` — edit to iterate on output quality without touching logic:

| Prompt | Model | Purpose |
|--------|-------|---------|
| `ENRICHMENT_SYSTEM` | Haiku | Entity/sentiment/topic extraction with RT/QT handling |
| `DIGEST_SYSTEM` | Opus | Delta-first digest with credibility and track records |
| `TLDR_SYSTEM` | Haiku | Priority-ranked compression for Telegram |
| `ASK_SYSTEM` | Sonnet | Answer synthesis with analyst credibility weighting |
| `THEME_SYNTHESIS_SYSTEM` | Haiku | 4-sentence theme briefing (stance/voices/debate/watch) |
| `WHO_SYNTHESIS_SYSTEM` | Haiku | 3-sentence account profile (specialization/stance/track record) |
| `THEME_ARCHITECT_SYSTEM` | Sonnet | Names new themes from clustered unmatched descriptions |

## Quick Start

### Prerequisites

- **Node.js 22+** on a VPS (Ubuntu recommended)
- **Twitter/X session cookies** (auth_token + ct0 from browser DevTools)
- **OpenRouter API key** (https://openrouter.ai/keys) — one key for all LLM models
- **Telegram bot token** (create via @BotFather)

### 1. Clone and install

```bash
git clone https://github.com/Kevinaie18/ai-twitter.git
cd ai-twitter
npm install
```

### 2. Configure

```bash
cp config.example.yaml config.yaml
cp .env.example .env
```

Edit `.env` with your credentials:

```bash
# Twitter/X — get these from browser DevTools (Application > Cookies > x.com)
TWITTER_AUTH_TOKEN=your_auth_token_here
TWITTER_CT0=your_ct0_token_here

# OpenRouter — one key for Claude Haiku, Opus, Sonnet + OpenAI embeddings
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxx

# Telegram — create bot via @BotFather, get chat ID via @userinfobot
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=your_chat_id

# Dashboard — set a password to protect the web interface
DASHBOARD_USER=admin
DASHBOARD_PASS=your_secure_password

# Safety — daily spending limit for LLM API calls
MAX_ENRICHMENT_COST_PER_DAY=5.00
```

Edit `config.yaml`:

```yaml
lists:
  - id: "2001952451281531011"    # Your X list ID (from the list URL)
    name: "Fintwit Macro"
    scrape_interval_min: 120       # How often to scrape (minutes)
    active: true

digest:
  timezone: "UTC"
  morning_hour: 7
  evening_hour: 18
  max_themes: 4                 # Max themes in digest
  delta_enabled: true           # Show "what changed" section
  format: split                 # 'single' or 'split' (TL;DR + deep dive)
  tldr_max_words: 150           # Max words for TL;DR

consensus:
  threshold_pct: 80

signal_floor:
  min_accounts: 3               # Drop themes with fewer unique authors
  min_engagement: 50            # Drop themes with less total engagement

# Tag your accounts for credibility-weighted digests
accounts:
  default_tag: unverified
  credibility_tags:
    BarakRavid: journalist
    citrini: analyst
    StockNews690137: aggregator

# Map custom themes to tickers for price backtesting
theme_tickers:
  biotech: ["XBI", "IBB"]
  defense: ["ITA", "LMT"]

# Track record engine (opt-in)
track_record:
  enabled: false
  resolution_days: 5
  min_confidence: 0.6
  hit_threshold_pct: 0.5
  min_calls_to_display: 5
```

### 3. Build and run

```bash
npm run build
npm start
```

The system starts:
- Scraping your lists every 2 hours
- Enriching tweets with AI (entities, sentiment, auto-discovered themes)
- Delivering digests to Telegram at scheduled times
- Discovering new themes every 6 hours
- Resolving track record calls daily (if enabled)
- Dashboard available at `http://localhost:3000`

### 4. Deploy to VPS (production)

```bash
sudo cp deploy/twitter-intel.service /etc/systemd/system/
sudo systemctl enable twitter-intel
sudo systemctl start twitter-intel
```

## How to Get Your Twitter/X Cookies

1. Open https://x.com in Chrome/Firefox
2. Log in to your account
3. Open DevTools (F12) > Application > Cookies > `https://x.com`
4. Copy the values for:
   - `auth_token` → paste into `TWITTER_AUTH_TOKEN`
   - `ct0` → paste into `TWITTER_CT0`

Cookies expire periodically. The bot sends a Telegram alert when they do. Just paste new values in `.env` — no restart needed (hot-reloaded).

## Architecture

```
┌──────────────────────────────────────────────────┐
│                 SINGLE PROCESS                     │
│                                                    │
│  node-cron        grammy          better-sqlite3   │
│  (scheduler)      (Telegram bot)  + sqlite-vec     │
│                                   + FTS5           │
│                   Hono                             │
│                   (dashboard)                      │
│                                                    │
│  Cron jobs:                                        │
│    Scrape (per-list interval)                      │
│    Enrich (every 5 min)                            │
│    Theme discovery (every 6h, Sonnet)              │
│    Digest (morning + evening)                      │
│    Track record resolution (daily)                 │
│                                                    │
│  External APIs:                                    │
│    Twitter/X GraphQL (session cookies)             │
│    OpenRouter (Haiku/Opus/Sonnet + OpenAI)         │
└──────────────────────────────────────────────────┘
```

Everything runs in one Node.js process. One SQLite database file. No external databases, no message queues, no Docker.

### LLM Model Usage

All models accessed through a single OpenRouter API key:

| Task | Model | Frequency |
|------|-------|-----------|
| Tweet enrichment | Claude Haiku 4.5 | Every 5 min (25 tweets/batch) |
| Digest generation | Claude Opus 4.6 | 2x daily |
| TL;DR compression | Claude Haiku 4.5 | 2x daily (if split format) |
| /ask queries | Claude Sonnet 4.6 | On-demand |
| /theme synthesis | Claude Haiku 4.5 | On-demand |
| /who synthesis | Claude Haiku 4.5 | On-demand |
| Theme discovery | Claude Sonnet 4.6 | Every 6h (~$0.003/call) |
| Embeddings | OpenAI text-embedding-3-small | Every 5 min (with enrichment) |

### Estimated Costs

~$0.80-1.00/day ($25-30/month) for a list producing ~2,400 tweets/day. Theme discovery adds ~$1-2/month. The cost circuit breaker in `.env` pauses enrichment if the daily limit is exceeded.

### Database Tables

| Table | Purpose |
|-------|---------|
| `tweets` | Raw scraped tweets with engagement metrics |
| `accounts` | Author profiles with credibility tags |
| `enrichments` | Sentiment, confidence, summary per tweet |
| `tweet_entities` | Tickers, countries, people, topics |
| `tweet_themes` | Theme assignments (core + auto-discovered) |
| `theme_registry` | Living taxonomy — core themes + Sonnet-discovered |
| `unmatched_topics` | Pending topic descriptions awaiting theme creation |
| `consensus_snapshots` | Per-theme consensus over time |
| `digest_snapshots` | Persisted digest state for delta tracking |
| `directional_calls` | Track record: logged calls awaiting resolution |
| `prices` | Price data for backtesting and call resolution |
| `tweets_fts` | FTS5 full-text search index |
| `tweet_embeddings` | sqlite-vec embeddings (1536-dim) |

## Project Structure

```
src/
  index.ts          Entry point — orchestrates all cron jobs
  config.ts         Config loader (YAML + .env, hot-reload)
  scraper.ts        Twitter/X GraphQL scraper with pagination
  db.ts             SQLite schema, migrations, all query functions
  enrichment.ts     Haiku enrichment + embeddings + theme matching + theme discovery
  intelligence.ts   Consensus detection + delta computation + call resolution
  digest.ts         Opus digest generation + TL;DR + snapshot persistence
  bot.ts            Telegram bot — 6 commands with AI synthesis
  prompts.ts        All 7 AI prompts (edit here to improve output quality)
  types.ts          TypeScript interfaces
  dashboard/
    index.ts        Hono REST API + basic auth
    public/
      index.html    SPA dashboard (Lightweight Charts)
config.yaml         List configuration + all feature settings
.env                API keys + credentials (gitignored)
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Scraper auth failed" alert | Refresh Twitter cookies in `.env` |
| No tweets appearing | Check `/status`. Verify list ID is correct and list is public |
| Commands not showing in Telegram | Restart the bot — `setMyCommands` runs on startup |
| Dashboard returns empty | Verify `config.yaml` has the correct list ID |
| High API costs | Lower `max_tweets_per_scrape` or reduce scrape frequency |
| Missing consensus alerts | Need 2+ weeks of data. Check `/consensus` |
| New theme not appearing | Themes auto-discover every 6h. Check `theme_registry` table |

## License

Private — not open source.
