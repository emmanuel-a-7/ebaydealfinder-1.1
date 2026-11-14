# eBay Deal Scraper

A multi-target eBay deal scraper built with Node.js, Puppeteer Stealth, Discord webhook notifications, and a real-time web dashboard.

---

## Features

- **Stealth Browser Automation**: Uses `puppeteer-extra` with the stealth plugin, dynamic user agents, randomized viewports, and human-like scroll jitter to avoid bot blocks.
- **Multi-Target Monitoring**: Rotate through multiple targets (GPUs, laptops, consoles, etc.) with configurable price ceilings and delays between queries.
- **Smart Filtering**:
  - Excludes unwanted conditions (e.g. *for parts*, *not working*, *salvage*).
  - Keyword matching & negative keyword exclusion (e.g. ignores *box only*, *cooling fan*, *broken*).
  - Validates Buy It Now prices and shipping costs.
- **Deduplication**: Tracks seen item IDs in `data/seen_listings.json` for 7 days so you never get alerted twice for the same listing.
- **Discord Alerts**: Rich embeds with direct eBay item links, photos, price breakdown, and high-priority pings (`@everyone`) for deep discounts.
- **Live Web Dashboard**: Responsive dark-mode dashboard with real-time WebSocket feeds, manual scan triggers, target manager, and event logs.

---

## Project Structure

```text
├── config.json           # Runtime configuration (interval, port, webhook)
├── targets.json          # Multi-target search configurations
├── server.js             # Express & WebSocket server + live dashboard
├── index.js              # Standalone CLI runner for automated scans
├── public/
│   └── index.html        # Single-page web dashboard
├── src/
│   ├── scraper.js        # Puppeteer stealth scraper and DOM extractor
│   ├── parser.js         # URL builder and listing filter logic
│   ├── tracker.js        # Listing deduplication and persistence
│   └── discord.js        # Discord webhook embed formatting and alerts
├── data/
│   └── seen_listings.json# Tracked listings storage (auto-generated)
├── .env.example          # Environment variable template
└── package.json
```

---

## Prerequisites

- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher
- **Discord Webhook URL** (optional for `--dry-run`, required for notifications)

---

## Installation & Setup

### 1. Clone the repository and install dependencies

```bash
git clone <repo-url>
cd ebayscraper-1.1
npm install
```

### 2. Configure Environment Variables

Create a `.env` file based on [.env.example](file:///.env.example):

```bash
cp .env.example .env
```

Open `.env` and configure your settings:

```env
# Discord webhook URL
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN

# Scan interval in minutes
SCAN_INTERVAL_MINUTES=10

# Maximum price in USD
MAX_PRICE=250

# Search query (fallback if no targets in targets.json)
SEARCH_QUERY=nvidia rtx 3060 12gb

# Dry run flag (set to true to test scraping without sending Discord alerts)
DRY_RUN=false
```

---

## Running the Application

### Option A: Web Dashboard & Scraper (Recommended)

Starts the Express & WebSocket server, opens the background scheduler, and runs an initial scan.

```bash
npm start
```

Open your browser to:
```text
http://localhost:3060
```

From the dashboard you can:
- Monitor active scans, live progress bars, and recent scan logs.
- Add, edit, toggle, or delete targets on the fly via the **Target Manager**.
- Trigger manual scans on demand.
- Review sent Discord alerts.

### Option B: Standalone CLI Runner

Runs the headless scraper directly in your terminal:

```bash
npm run scraper
```

### Option C: Dry Run (Testing Mode)

Executes a single scan cycle without sending any messages to Discord:

```bash
npm run dry-run
```

---

## Target Configuration

Targets are defined in [targets.json](file:///targets.json). You can modify them directly in the file or through the web dashboard modal:

```json
[
  {
    "id": "mac-mini-m4",
    "name": "Apple Mac Mini M4",
    "category": "Desktop",
    "query": "apple mac mini m4",
    "maxPrice": 600,
    "urgentPrice": 500,
    "requiredKeywords": "mac mini, m4",
    "exclusionKeywords": "m1, m2, intel, box only, broken, parts",
    "enabled": true
  }
]
```

- **`query`**: Search string passed into eBay search.
- **`maxPrice`**: Maximum total price (item price + shipping in USD).
- **`urgentPrice`**: Optional threshold to trigger high-priority alerts.
- **`requiredKeywords`**: Comma-separated list; title must include these.
- **`exclusionKeywords`**: Comma-separated list; titles with any of these are discarded.
- **`enabled`**: Set `false` to skip target during scans without deleting it.

---

## Troubleshooting

- **Puppeteer sandbox errors (Linux/Docker)**:
  Ensure standard Chromium dependencies are installed:
  ```bash
  sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2
  ```
- **Rate limiting / Captchas**:
  Increase `interQueryDelaySec` in `config.json` (e.g. 6–10 seconds) or increase `intervalMinutes` to avoid frequent polling.
- **Resetting seen listings**:
  To clear the alert cache and allow previously alerted deals to trigger again, click **Reset History** in the dashboard or delete `data/seen_listings.json`.
