# TODOS

## Deferred from MVP PR

### Email weekly rollup
- **What:** Weekly email summarizing key themes, consensus movements, emerging narratives, and notable threads.
- **Why:** Different cadence (weekly vs twice-daily) serves a different purpose — stepping back to see the forest. Shareable with colleagues.
- **Pros:** Weekend review, higher-level pattern recognition, shareable.
- **Cons:** Requires email service (Resend/SendGrid/nodemailer), new template system.
- **Context:** Uses the same data as the web dashboard and Telegram digest. Fast follow-up once dashboard is live.
- **Depends on:** 1+ week of accumulated data. Web dashboard charts can be reused for email content.

### Author authority weighting (V2 consensus)
- **What:** Weight consensus votes by follower count or historical track record instead of equal weight.
- **Why:** Not all list accounts are equally influential. A 500K-follower macro analyst's call carries more signal.
- **Pros:** More accurate consensus, better contrarian detection.
- **Cons:** Track-record mode needs price data + months of history. Follower-count mode needs a weighting curve design (linear? log? tiers?).
- **Context:** `accounts.follower_count` is captured from day one. Price data integration is in this PR. Weighting logic is purely an intelligence-layer change.
- **Depends on:** Price data integration (for track-record mode), 2+ months of consensus data.
