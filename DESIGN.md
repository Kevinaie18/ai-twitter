# Design System — Twitter Intel Digest

## Aesthetic

Financial terminal meets intelligence briefing. Dense, dark, professional. Every pixel earns its space. No decoration, no generic SaaS patterns.

## Classification

**APP UI** — data-dense, task-focused dashboard for a single power user (investment manager).

## Typography

| Use | Font | Weight | Size |
|-----|------|--------|------|
| Headings | Geist Sans (Inter fallback) | 600 (semibold) | 20/24px |
| Body text | Geist Sans (Inter fallback) | 400 (regular) | 14/16px |
| Numbers/data | Geist Mono (JetBrains Mono fallback) | 400 | 12/14px |
| Labels | Geist Sans | 500 (medium) | 12px |
| Small/caption | Geist Sans | 400 | 11px |

Scale: 11 / 12 / 14 / 16 / 20 / 24px

## Color Tokens

### Dark Mode (default)

| Token | Value | Use |
|-------|-------|-----|
| --bg | #0a0a0a | Page background |
| --surface | #141414 | Cards, panels |
| --surface-hover | #1a1a1a | Interactive hover |
| --border | #262626 | Dividers, card borders |
| --text-primary | #fafafa | Headings, primary content |
| --text-secondary | #a1a1a1 | Labels, secondary info |
| --text-muted | #525252 | Placeholders, disabled |

### Light Mode

| Token | Value | Use |
|-------|-------|-----|
| --bg | #fafafa | Page background |
| --surface | #ffffff | Cards, panels |
| --surface-hover | #f5f5f5 | Interactive hover |
| --border | #e5e5e5 | Dividers, card borders |
| --text-primary | #0a0a0a | Headings, primary content |
| --text-secondary | #737373 | Labels, secondary info |
| --text-muted | #a1a1a1 | Placeholders, disabled |

### Semantic Colors (both modes)

| Token | Value | Use |
|-------|-------|-----|
| --bullish | #22c55e | Bullish sentiment, positive |
| --bearish | #ef4444 | Bearish sentiment, negative |
| --neutral | #737373 | Neutral sentiment |
| --accent | #3b82f6 | Links, active states, focus |
| --alert | #f59e0b | Warnings, consensus alerts |

## Spacing

4px base unit. Scale: 4 / 8 / 12 / 16 / 24 / 32 / 48px

## Borders

- Width: 1px solid
- Radius: 6px (subtle, not bubbly)
- Color: var(--border)

## Charts (Lightweight Charts / TradingView)

- Background: var(--bg)
- Grid lines: var(--border)
- Bullish line: var(--bullish)
- Bearish line: var(--bearish)
- Neutral/volume: var(--accent) at 30% opacity
- Crosshair: var(--text-secondary)
- Font: Geist Mono

## Sentiment Indicators

Never rely on color alone. Always pair with directional symbols:
- Bullish: ▲ + green
- Bearish: ▼ + red
- Neutral: — + gray

## Responsive Breakpoints

| Breakpoint | Layout | Navigation |
|------------|--------|------------|
| Mobile (<640px) | Single column, full-width charts | Bottom tab bar (5 icons) |
| Tablet (640-1024px) | 2-column grid | Sidebar collapsed (icons) |
| Desktop (>1024px) | Full layout, sidebar + content | Sidebar expanded (icons + labels) |

## Accessibility

- Touch targets: 44px minimum on mobile
- Color contrast: 4.5:1 minimum (WCAG AA)
- ARIA landmarks: nav, main, complementary
- Keyboard: Tab navigation, Enter to activate, 1-5 for page shortcuts
- Reduced motion: respect prefers-reduced-motion
- Screen readers: proper th scope on tables, aria-label on charts

## Anti-Patterns (do NOT use)

- Purple/violet gradients
- 3-column icon-in-circle feature grids
- Centered-everything layouts
- Uniform bubbly border-radius
- Decorative blobs or wavy dividers
- Emoji as design elements
- Generic hero copy
- Cookie-cutter section rhythm
