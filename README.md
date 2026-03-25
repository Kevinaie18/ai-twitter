# Twitter/X Intelligence Digest

Turn your curated Twitter/X lists into an unfair information advantage. Automated signal extraction, consensus tracking, and contrarian alerts — delivered to Telegram and a real-time dashboard.

## What It Does

You curate the list. The tool does the rest.

```
Your curated X list (~100 accounts)
        |
        v
  Scrape every 30 min (GraphQL + session cookies)
        |
        v
  Enrich: entities, sentiment, themes, embeddings (Claude Haiku + OpenAI)
        |
        v
  Intelligence: consensus detection, narrative tracking, contrarian signals
        |
        v
  Deliver: Telegram digest (2x daily) + Web dashboard + On-demand queries
```

**Twice-daily digests** summarize overnight/daytime activity, ranked by theme and importance. **Consensus alerts** fire when your list aligns too strongly on a position — a crowded-trade warning. **Semantic search** lets you query weeks of history: "what did my list say about Iran sanctions?"

## Who This Is For

Investment professionals, fund managers, and serious market participants who follow curated fintwit accounts covering:
- Semiconductors / photonics
- Geopolitics (Middle East, China)
- Macro / rates / oil
- AI infrastructure
- Crypto
- Options flow

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

Edit `config.yaml` to add your Twitter/X list(s):

```yaml
lists:
  - id: "2001952451281531011"    # Your X list ID (from the list URL)
    name: "Fintwit Macro"
    scrape_interval_min: 30       # How often to scrape (minutes)
    active: true

  # Add more lists:
  # - id: "1234567890"
  #   name: "Africa Tech"
  #   scrape_interval_min: 60
  #   active: true

digest:
  timezone: "UTC"
  morning_hour: 7     # Morning digest at 7:00 UTC
  evening_hour: 18    # Evening digest at 18:00 UTC

consensus:
  threshold_pct: 80   # Alert when >80% of accounts agree on direction
```

### 3. Build and run

```bash
npm run build
npm start
```

The system starts:
- Scraping your lists every 30 minutes
- Enriching tweets with AI (entities, sentiment, themes)
- Delivering digests to Telegram at scheduled times
- Dashboard available at `http://localhost:3000`

### 4. Deploy to VPS (production)

```bash
# Copy the systemd service file
sudo cp deploy/twitter-intel.service /etc/systemd/system/
sudo systemctl enable twitter-intel
sudo systemctl start twitter-intel

# Or use the deploy script (from your local machine)
REMOTE_HOST=your-vps-ip ./scripts/deploy.sh
```

## How to Get Your Twitter/X Cookies

1. Open https://x.com in Chrome/Firefox
2. Log in to your account
3. Open DevTools (F12) > Application > Cookies > `https://x.com`
4. Copy the values for:
   - `auth_token` → paste into `TWITTER_AUTH_TOKEN`
   - `ct0` → paste into `TWITTER_CT0`

Cookies expire periodically. When they do, the bot sends a Telegram alert: "Scraper auth failed — refresh cookies in .env". Just repeat the steps above and paste new values — no restart needed (hot-reloaded on next scrape cycle).

## How to Find Your X List ID

1. Go to your list on x.com (e.g., `https://x.com/i/lists/2001952451281531011`)
2. The number at the end of the URL is your list ID
3. Add it to `config.yaml`

## Telegram Commands

| Command | What It Does |
|---------|-------------|
| `/ask <question>` | Semantic search across your tweet archive. "What did my list say about Iran?" |
| `/consensus` | Current consensus map across all themes with trend arrows |
| `/theme <name>` | Deep dive on a theme: sentiment trend, top tweets, key accounts |
| `/who <handle>` | Account profile: what they've been saying, their themes, sentiment lean |
| `/compare` | Cross-list divergence (when 2+ lists are active) |
| `/status` | System health: scraper status, enrichment queue, API costs |

## Web Dashboard

Access at `http://your-vps:3000` (protected by basic auth).

**5 pages:**

- **Dashboard** — consensus alerts, theme heatmap, sentiment trends, latest digest
- **Themes** — deep dive per theme with 30-day charts and top tweets
- **Accounts** — sortable table of all tracked accounts with activity stats
- **Search** — natural language search across your entire tweet archive
- **Settings** — system health, scraper status, API cost monitoring

Dark mode by default (toggle available). Financial terminal aesthetic — dense, professional, built for information consumption.

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
│  External APIs:                                    │
│    Twitter/X GraphQL (session cookies)             │
│    OpenRouter (Claude Haiku/Opus/Sonnet + OpenAI)  │
└──────────────────────────────────────────────────┘
```

Everything runs in one Node.js process. One SQLite database file. No external databases, no message queues, no Docker. Deployable on any VPS with Node.js 22+.

### LLM Model Usage

All models accessed through a single OpenRouter API key:

| Task | Model | Purpose |
|------|-------|---------|
| Tweet enrichment | Claude Haiku 4.5 | Entity extraction, sentiment, theme tagging (25 tweets/batch) |
| Digest generation | Claude Opus 4.6 | Structured intelligence digest with narrative synthesis |
| /ask queries | Claude Sonnet 4.6 | Answer questions with tweet citations |
| Embeddings | OpenAI text-embedding-3-small | Semantic search vectors (1536-dim) |

### Estimated Costs

~$0.80/day ($24/month) for a list producing ~2,400 tweets/day. The cost circuit breaker in `.env` pauses enrichment if the daily limit is exceeded.

## Data & Privacy

- All data stored locally in SQLite (`data/intel.db`)
- No data sent anywhere except OpenRouter (for LLM processing) and Telegram (for delivery)
- Twitter scraping uses your personal session cookies — same as browsing X in your browser
- Dashboard is password-protected and served from your VPS only

## Adding a New List

1. Find the list ID from the X URL
2. Add it to `config.yaml`:
   ```yaml
   lists:
     - id: "existing_list_id"
       name: "Existing List"
       scrape_interval_min: 30
       active: true
     - id: "new_list_id"
       name: "New List Name"
       scrape_interval_min: 60
       active: true
   ```
3. Restart the service: `sudo systemctl restart twitter-intel`

Cross-list intelligence activates automatically when 2+ lists are active. Use `/compare` in Telegram to see divergences.

## Consensus & Contrarian Signals

The core differentiator. The system tracks what your curated list thinks about each theme:

- **One vote per account per digest window** — prevents prolific tweeters from skewing consensus
- **Consensus alert at 80%+** (configurable) — "84% of your list is bearish on crude"
- **Historical context** — "Last time consensus was this strong was Feb 12"
- **Rolling averages** — computed at query time, always accurate
- **Price backtesting** — shows what happened to related assets after past consensus events

Consensus signals become meaningful after ~2 weeks of data accumulation. The system suppresses alerts for the first 7 days to avoid cold-start false positives.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Scraper auth failed" Telegram alert | Refresh Twitter cookies in `.env` (see instructions above) |
| No tweets appearing | Check `/status` in Telegram. Verify list ID is correct and list is public. |
| Dashboard won't load | Check `DASHBOARD_PASS` is set in `.env`. Try `http://localhost:3000`. |
| High API costs | Lower `max_tweets_per_scrape` in `config.yaml` or reduce scrape frequency |
| Missing consensus alerts | Need 2+ weeks of data. Check `/consensus` for current state. |
| Process keeps crashing | Check `journalctl -u twitter-intel -f` for errors. The systemd service auto-restarts. |

## Project Structure

```
src/
  index.ts          Entry point — orchestrates cron, bot, dashboard
  config.ts         Config loader (YAML + .env, hot-reload)
  scraper.ts        Twitter/X GraphQL scraper with pagination
  db.ts             SQLite + sqlite-vec + FTS5 database layer
  enrichment.ts     Claude Haiku enrichment + OpenAI embeddings
  intelligence.ts   Consensus detection + narrative tracking
  digest.ts         Claude Opus digest generation
  bot.ts            Telegram bot with all commands
  types.ts          TypeScript interfaces
  dashboard/
    index.ts        Hono REST API + basic auth
    public/
      index.html    SPA dashboard (Lightweight Charts)
config.yaml         List configuration + scheduling
.env                API keys + credentials (gitignored)
deploy/
  twitter-intel.service   Systemd unit file
scripts/
  deploy.sh         One-command VPS deployment
```

## License

Private — not open source.
