// ============================================================
// index.js — eBay RTX 3060 12GB Deal Scraper
// Main entry point: orchestrates scanning, parsing, and alerts
// ============================================================

require('dotenv').config();
const cron = require('node-cron');
const { StealthScraper } = require('./src/scraper');
const { buildSearchUrl, filterListings } = require('./src/parser');
const { filterNewListings } = require('./src/tracker');
const {
    sendListingAlerts,
    sendStartupNotification,
    sendScanSummary,
    sendErrorNotification,
} = require('./src/discord');

// ── Configuration ─────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const CONFIG_FILE = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    intervalMinutes: parseInt(process.env.SCAN_INTERVAL_MINUTES, 10) || 10,
    maxPrice: parseInt(process.env.MAX_PRICE, 10) || 250,
    query: process.env.SEARCH_QUERY || 'nvidia rtx 3060 12gb',
    projectName: process.env.PROJECT_NAME || 'Deal Hunter',
    requiredKeywords: '3060',
    exclusionKeywords: '3060 ti, 3060ti, 3060m, mobile pcie, box only, no gpu, no graphics card, empty box, empty retail box, baffle plate, bracket for, fan only, heatsink only, backplate only, cooler only, shroud only, parts for, card box, laptop, notebook, desktop pc, full build, whole computer, gaming pc, prebuilt, pre-built,  8gb , mining rig, bundle with',
};

let CONFIG = { ...DEFAULT_CONFIG };

try {
    if (fs.existsSync(CONFIG_FILE)) {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        CONFIG = { ...CONFIG, ...JSON.parse(data) };
    }
} catch (e) {
    console.error('[Config] Failed to load config.json:', e.message);
}

CONFIG.dryRun = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');

// Validate config
if (!CONFIG.webhookUrl && !CONFIG.dryRun) {
    console.error('❌ DISCORD_WEBHOOK_URL is required. Set it in .env or pass --dry-run for testing.');
    process.exit(1);
}

// ── Globals ───────────────────────────────────────────────────
let scraper = null;
let isScanning = false;
let scanCount = 0;

// ── Core Scan Function ───────────────────────────────────────
async function runScan() {
    if (isScanning) {
        console.log('[Main] Scan already in progress, skipping...');
        return;
    }

    isScanning = true;
    scanCount++;
    const startTime = Date.now();

    console.log('\n' + '═'.repeat(60));
    console.log(`[Main] 🔍 Starting scan #${scanCount} at ${new Date().toLocaleString()}`);
    console.log('═'.repeat(60));

    try {
        // Build search URL
        const searchUrl = buildSearchUrl(CONFIG);
        console.log(`[Main] Search URL: ${searchUrl.substring(0, 100)}...`);

        // Scrape listings directly from live DOM (bypasses static HTML parsing issues)
        const rawListings = await scraper.scrapeListings(searchUrl);
        console.log(`[Main] Raw listings extracted from DOM: ${rawListings.length}`);

        // Apply our filters (price, condition, title keywords)
        const allListings = filterListings(rawListings, CONFIG);
        console.log(`[Main] After filtering: ${allListings.length} matching listings`);

        // Log all matches to console
        if (allListings.length > 0) {
            console.log('\n[Main] All matching listings:');
            allListings.forEach((listing, i) => {
                console.log(`  ${i + 1}. $${listing.totalPrice.toFixed(2)} | ${listing.condition} | ${listing.title.substring(0, 60)}`);
            });
        }

        // Filter for new (unseen) listings only
        const newListings = filterNewListings(allListings);

        // Send Discord alerts for new listings
        if (newListings.length > 0 && !CONFIG.dryRun) {
            console.log(`\n[Main] 🚨 ${newListings.length} NEW listing(s) — sending Discord alerts!`);
            await sendListingAlerts(CONFIG.webhookUrl, newListings, CONFIG);
        } else if (newListings.length > 0 && CONFIG.dryRun) {
            console.log(`\n[Main] 🧪 DRY RUN — would send ${newListings.length} Discord alerts`);
            newListings.forEach((l, i) => {
                console.log(`  NEW ${i + 1}: $${l.totalPrice.toFixed(2)} — ${l.title}`);
                console.log(`         ${l.url}`);
            });
        } else {
            console.log('\n[Main] No new listings since last scan.');
        }

        // Send scan summary (skip in dry run)
        if (!CONFIG.dryRun) {
            const nextScan = new Date(Date.now() + CONFIG.intervalMinutes * 60 * 1000);
            await sendScanSummary(
                CONFIG.webhookUrl,
                allListings.length,
                newListings.length,
                nextScan.toLocaleTimeString()
            );
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[Main] ✅ Scan #${scanCount} complete in ${elapsed}s`);

    } catch (error) {
        console.error(`[Main] ❌ Scan failed: ${error.message}`);
        if (!CONFIG.dryRun && CONFIG.webhookUrl) {
            await sendErrorNotification(CONFIG.webhookUrl, error.message, CONFIG);
        }
    } finally {
        isScanning = false;
    }
}

// ── Main Entry Point ─────────────────────────────────────────
async function main() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log(`║   ${CONFIG.projectName.padEnd(46)} ║`);
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  Search:    ${CONFIG.query}`);
    console.log(`  Max Price: $${CONFIG.maxPrice}`);
    console.log(`  Interval:  Every ${CONFIG.intervalMinutes} minutes`);
    console.log(`  Dry Run:   ${CONFIG.dryRun}`);
    console.log(`  Webhook:   ${CONFIG.dryRun ? 'N/A (dry run)' : '✅ Connected'}`);
    console.log('');

    // Initialize stealth scraper
    scraper = new StealthScraper();
    await scraper.launch();

    // Send startup notification
    if (!CONFIG.dryRun) {
        await sendStartupNotification(CONFIG.webhookUrl, CONFIG);
    }

    // Run first scan immediately
    await runScan();

    // If dry run, close and exit
    if (CONFIG.dryRun) {
        console.log('\n[Main] Dry run complete. Exiting.');
        await scraper.close();
        process.exit(0);
    }

    // Schedule recurring scans
    const cronExpression = `*/${CONFIG.intervalMinutes} * * * *`;
    console.log(`\n[Main] ⏰ Scheduling scans with cron: "${cronExpression}"`);

    cron.schedule(cronExpression, async () => {
        // Restart browser periodically to avoid memory leaks and refresh fingerprint
        if (scanCount % 6 === 0) {
            console.log('[Main] 🔄 Recycling browser instance...');
            await scraper.close();
            await scraper.launch();
        }
        await runScan();
    });

    console.log('[Main] 🟢 Scraper is running. Press Ctrl+C to stop.\n');
}

// ── Graceful Shutdown ────────────────────────────────────────
async function shutdown(signal) {
    console.log(`\n[Main] Received ${signal}. Shutting down gracefully...`);
    if (scraper) {
        await scraper.close();
    }
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle unhandled rejections
process.on('unhandledRejection', (error) => {
    console.error('[Main] Unhandled rejection:', error);
});

// Start the scraper
main().catch((error) => {
    console.error('[Main] Fatal error:', error);
    process.exit(1);
});
