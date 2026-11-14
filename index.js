// Scanner runner

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

// Configuration
const fs = require('fs');
const path = require('path');
const CONFIG_FILE = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    intervalMinutes: parseInt(process.env.SCAN_INTERVAL_MINUTES, 10) || 10,
    maxPrice: parseInt(process.env.MAX_PRICE, 10) || 600,
    query: process.env.SEARCH_QUERY || '',
    projectName: process.env.PROJECT_NAME || 'High-Value Multi-Deal Finder',
    requiredKeywords: '',
    exclusionKeywords: 'box only, empty box, broken, parts, for parts',
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
    console.error('[ERROR] DISCORD_WEBHOOK_URL is required. Set it in .env or pass --dry-run for testing.');
    process.exit(1);
}

// Globals
let scraper = null;
let isScanning = false;
let scanCount = 0;

const TARGETS_FILE = path.join(__dirname, 'targets.json');

function loadTargets() {
    try {
        if (fs.existsSync(TARGETS_FILE)) {
            const data = fs.readFileSync(TARGETS_FILE, 'utf8');
            const targets = JSON.parse(data);
            if (Array.isArray(targets) && targets.length > 0) {
                return targets;
            }
        }
    } catch (e) {
        console.error('[Config] Failed to load targets.json:', e.message);
    }
    return null;
}

// Core scan
async function runScan() {
    if (isScanning) {
        console.log('[Main] Scan already in progress, skipping...');
        return;
    }

    isScanning = true;
    scanCount++;
    const startTime = Date.now();

    console.log('\n' + '═'.repeat(60));
    console.log(`[Main] Starting scan #${scanCount} at ${new Date().toLocaleString()}`);
    console.log('═'.repeat(60));

    try {
        const targets = loadTargets();
        let allListings = [];

        if (targets && targets.some(t => t.enabled !== false)) {
            const activeTargets = targets.filter(t => t.enabled !== false);
            console.log(`[Main] Executing multi-target scan across ${activeTargets.length} active target(s)`);

            const delayMs = (CONFIG.interQueryDelaySec || 4) * 1000;
            const res = await scraper.scrapeMultiTargets(
                targets,
                buildSearchUrl,
                filterListings,
                { interQueryDelayMs: delayMs }
            );
            allListings = res.listings;
        } else {
            // Fallback search
            console.log(`[Main] Single query mode: ${CONFIG.query}`);
            const searchUrl = buildSearchUrl(CONFIG);
            const rawListings = await scraper.scrapeListings(searchUrl);
            allListings = filterListings(rawListings, CONFIG);
        }

        console.log(`[Main] Total matching listings found: ${allListings.length}`);

        // Log matches
        if (allListings.length > 0) {
            console.log('\n[Main] Matching listings preview:');
            allListings.slice(0, 10).forEach((listing, i) => {
                const targetLabel = listing.targetName ? `[${listing.targetName}] ` : '';
                console.log(`  ${i + 1}. ${targetLabel}$${listing.totalPrice.toFixed(2)} | ${listing.condition} | ${listing.title.substring(0, 60)}`);
            });
        }

        // Filter new listings
        const newListings = filterNewListings(allListings);

        // Send alerts
        if (newListings.length > 0 && !CONFIG.dryRun) {
            console.log(`\n[Main] ${newListings.length} NEW listing(s) — sending Discord alerts!`);
            await sendListingAlerts(CONFIG.webhookUrl, newListings, CONFIG);
        } else if (newListings.length > 0 && CONFIG.dryRun) {
            console.log(`\n[Main] [DRY RUN] — would send ${newListings.length} Discord alerts:`);
            newListings.forEach((l, i) => {
                const targetLabel = l.targetName ? `[${l.targetName}] ` : '';
                console.log(`  NEW ${i + 1}: ${targetLabel}$${l.totalPrice.toFixed(2)} — ${l.title}`);
                console.log(`         ${l.url}`);
            });
        } else {
            console.log('\n[Main] No new listings since last scan.');
        }

        // Send summary
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
        console.log(`[Main] [OK] Scan #${scanCount} complete in ${elapsed}s`);

    } catch (error) {
        console.error(`[Main] [ERROR] Scan failed: ${error.message}`);
        if (!CONFIG.dryRun && CONFIG.webhookUrl) {
            await sendErrorNotification(CONFIG.webhookUrl, error.message, CONFIG);
        }
    } finally {
        isScanning = false;
    }
}

// Main entry
async function main() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log(`║   ${CONFIG.projectName.padEnd(46)} ║`);
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  Search:    ${CONFIG.query || 'Multi-Target'}`);
    console.log(`  Max Price: $${CONFIG.maxPrice}`);
    console.log(`  Interval:  Every ${CONFIG.intervalMinutes} minutes`);
    console.log(`  Dry Run:   ${CONFIG.dryRun}`);
    console.log(`  Webhook:   ${CONFIG.dryRun ? 'N/A (dry run)' : '[OK] Connected'}`);
    console.log('');

    // Init scraper
    scraper = new StealthScraper();
    await scraper.launch();

    // Startup notification
    if (!CONFIG.dryRun) {
        await sendStartupNotification(CONFIG.webhookUrl, CONFIG);
    }

    // Initial scan
    await runScan();

    // Dry run exit
    if (CONFIG.dryRun) {
        console.log('\n[Main] Dry run complete. Exiting.');
        await scraper.close();
        process.exit(0);
    }

    // Schedule scans
    const cronExpression = `*/${CONFIG.intervalMinutes} * * * *`;
    console.log(`\n[Main] Scheduling scans with cron: "${cronExpression}"`);

    cron.schedule(cronExpression, async () => {
        // Recycle browser
        if (scanCount % 6 === 0) {
            console.log('[Main] Recycling browser instance...');
            await scraper.close();
            await scraper.launch();
        }
        await runScan();
    });

    console.log('[Main] Scraper is running. Press Ctrl+C to stop.\n');
}

// Shutdown
async function shutdown(signal) {
    console.log(`\n[Main] Received ${signal}. Shutting down gracefully...`);
    if (scraper) {
        await scraper.close();
    }
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Error handling
process.on('unhandledRejection', (error) => {
    console.error('[Main] Unhandled rejection:', error);
});

// Start scraper
main().catch((error) => {
    console.error('[Main] Fatal error:', error);
    process.exit(1);
});
