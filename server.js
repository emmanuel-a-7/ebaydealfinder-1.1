// ============================================================
// server.js — Express + WebSocket Dashboard Server
// Serves the real-time eBay deal dashboard UI
// ============================================================

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { StealthScraper } = require('./src/scraper');
const { buildSearchUrl, filterListings } = require('./src/parser');
const { filterNewListings, getTrackerStats } = require('./src/tracker');
const {
    sendListingAlerts,
    sendStartupNotification,
    sendErrorNotification,
} = require('./src/discord');

// ── Config ────────────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    intervalMinutes: parseInt(process.env.SCAN_INTERVAL_MINUTES, 10) || 10,
    maxPrice: parseInt(process.env.MAX_PRICE, 10) || 250,
    query: process.env.SEARCH_QUERY || 'nvidia rtx 3060 12gb',
    projectName: process.env.PROJECT_NAME || 'RTX 3060 Deal Hunter',
    requiredKeywords: '3060',
    exclusionKeywords: '3060 ti, 3060ti, 3060m, mobile pcie, box only, no gpu, no graphics card, empty box, empty retail box, baffle plate, bracket for, fan only, heatsink only, backplate only, cooler only, shroud only, parts for, card box, laptop, notebook, desktop pc, full build, whole computer, gaming pc, prebuilt, pre-built,  8gb , mining rig, bundle with',
    port: parseInt(process.env.PORT, 10) || 3060,
};

let CONFIG = { ...DEFAULT_CONFIG };

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf8');
            CONFIG = { ...CONFIG, ...JSON.parse(data) };
        }
    } catch (e) {
        console.error('[Config] Failed to load config.json:', e.message);
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2));
    } catch (e) {
        console.error('[Config] Failed to save config.json:', e.message);
    }
}

loadConfig();

// ── State ─────────────────────────────────────────────────────
const state = {
    isScanning: false,
    scanCount: 0,
    lastScan: null,
    nextScan: null,
    allFoundListings: [],    // all listings found across all scans
    alertHistory: [],         // Discord alerts sent
    scanLog: [],              // log of scan events
    scraper: null,
    cronJob: null,
};

// ── Express App ───────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── WebSocket broadcast ───────────────────────────────────────
function broadcast(type, data) {
    const msg = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

function addLog(level, message) {
    const entry = { level, message, time: new Date().toLocaleTimeString() };
    state.scanLog.unshift(entry);
    if (state.scanLog.length > 100) state.scanLog.pop();
    broadcast('log', entry);
}

// ── REST API ──────────────────────────────────────────────────
// Get current state (all listings, stats, logs)
app.get('/api/state', (req, res) => {
    const stats = getTrackerStats();
    res.json({
        config: {
            query: CONFIG.query,
            projectName: CONFIG.projectName,
            requiredKeywords: CONFIG.requiredKeywords,
            exclusionKeywords: CONFIG.exclusionKeywords,
            maxPrice: CONFIG.maxPrice,
            intervalMinutes: CONFIG.intervalMinutes,
            webhookUrl: CONFIG.webhookUrl,
            webhookConfigured: !!CONFIG.webhookUrl,
        },
        status: {
            isScanning: state.isScanning,
            scanCount: state.scanCount,
            lastScan: state.lastScan,
            nextScan: state.nextScan,
            totalTracked: stats.totalTracked,
        },
        listings: state.allFoundListings,
        alertHistory: state.alertHistory,
        scanLog: state.scanLog,
    });
});

// Manual trigger scan
app.post('/api/scan', async (req, res) => {
    if (state.isScanning) {
        return res.json({ ok: false, message: 'Scan already in progress' });
    }
    res.json({ ok: true, message: 'Scan triggered' });
    runScan();
});

// Update config
app.post('/api/config', (req, res) => {
    const { query, projectName, requiredKeywords, exclusionKeywords, maxPrice, intervalMinutes, webhookUrl } = req.body;
    
    if (query !== undefined) CONFIG.query = query;
    if (projectName !== undefined) CONFIG.projectName = projectName;
    if (requiredKeywords !== undefined) CONFIG.requiredKeywords = requiredKeywords;
    if (exclusionKeywords !== undefined) CONFIG.exclusionKeywords = exclusionKeywords;
    if (webhookUrl !== undefined) CONFIG.webhookUrl = webhookUrl;
    
    if (maxPrice && maxPrice > 0 && maxPrice <= 50000) CONFIG.maxPrice = maxPrice;
    if (intervalMinutes && intervalMinutes >= 2 && intervalMinutes <= 1440) {
        CONFIG.intervalMinutes = intervalMinutes;
        restartScheduler();
    }
    
    saveConfig();
    broadcast('config', CONFIG);
    res.json({ ok: true, config: CONFIG });
});

// Clear seen history
app.post('/api/reset', (req, res) => {
    const { clearTrackedListings } = require('./src/tracker');
    clearTrackedListings();
    state.allFoundListings = [];
    state.alertHistory = [];
    broadcast('reset', {});
    res.json({ ok: true });
});

// Serve dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Core Scan Function ────────────────────────────────────────
async function runScan() {
    if (state.isScanning) return;

    state.isScanning = true;
    state.scanCount++;
    const scanNum = state.scanCount;
    state.lastScan = new Date().toISOString();

    broadcast('scan_start', { scanCount: scanNum });
    addLog('info', `🔍 Scan #${scanNum} started`);

    try {
        const searchUrl = buildSearchUrl(CONFIG);
        addLog('info', `Fetching eBay results...`);

        const rawListings = await state.scraper.scrapeListings(searchUrl);
        addLog('info', `Extracted ${rawListings.length} raw listings from DOM`);

        const allListings = filterListings(rawListings, CONFIG);
        addLog('info', `${allListings.length} listings passed filters`);

        // Merge new listings into state (avoid duplicates by itemId)
        for (const listing of allListings) {
            if (!state.allFoundListings.find(l => l.itemId === listing.itemId)) {
                state.allFoundListings.unshift(listing);
            }
        }
        // Keep max 500 listings in memory
        if (state.allFoundListings.length > 500) {
            state.allFoundListings = state.allFoundListings.slice(0, 500);
        }

        broadcast('listings', { listings: state.allFoundListings, totalFound: allListings.length });

        // Filter new (unseen) listings for Discord alerts
        const newListings = filterNewListings(allListings);
        addLog(newListings.length > 0 ? 'success' : 'info',
            newListings.length > 0
                ? `🚨 ${newListings.length} NEW deal(s) found! Sending Discord alerts...`
                : `No new listings since last scan`
        );

        if (newListings.length > 0 && CONFIG.webhookUrl) {
            await sendListingAlerts(CONFIG.webhookUrl, newListings, CONFIG);
            // Track alerts sent
            for (const listing of newListings) {
                const alertEntry = { ...listing, alertedAt: new Date().toISOString() };
                state.alertHistory.unshift(alertEntry);
                if (state.alertHistory.length > 50) state.alertHistory.pop();
            }
            broadcast('alerts', { alerts: state.alertHistory });
            addLog('success', `✅ Sent ${newListings.length} Discord alert(s)`);
        }

        // Calculate next scan time
        const nextMs = CONFIG.intervalMinutes * 60 * 1000;
        state.nextScan = new Date(Date.now() + nextMs).toISOString();

        broadcast('scan_complete', {
            scanCount: scanNum,
            totalFound: allListings.length,
            newFound: newListings.length,
            nextScan: state.nextScan,
        });

        addLog('info', `✅ Scan #${scanNum} complete | Next scan at ${new Date(state.nextScan).toLocaleTimeString()}`);

    } catch (error) {
        addLog('error', `❌ Scan #${scanNum} failed: ${error.message}`);
        broadcast('scan_error', { error: error.message });

        if (CONFIG.webhookUrl) {
            await sendErrorNotification(CONFIG.webhookUrl, error.message, CONFIG).catch(() => { });
        }
    } finally {
        state.isScanning = false;
    }
}

// ── Scheduler ─────────────────────────────────────────────────
function startScheduler() {
    const cron = require('node-cron');
    const expr = `*/${CONFIG.intervalMinutes} * * * *`;
    state.cronJob = cron.schedule(expr, async () => {
        // Recycle browser every 6 scans
        if (state.scanCount > 0 && state.scanCount % 6 === 0) {
            addLog('info', '🔄 Recycling browser...');
            await state.scraper.close();
            await state.scraper.launch();
        }
        runScan();
    });
}

function restartScheduler() {
    if (state.cronJob) state.cronJob.stop();
    startScheduler();
    addLog('info', `⏱️ Scheduler restarted: every ${CONFIG.intervalMinutes} minutes`);
}

// ── WebSocket connection handler ──────────────────────────────
wss.on('connection', (ws) => {
    // Send current state immediately on connect
    const stats = getTrackerStats();
    ws.send(JSON.stringify({
        type: 'init',
        data: {
            config: {
                query: CONFIG.query,
                projectName: CONFIG.projectName,
                requiredKeywords: CONFIG.requiredKeywords,
                exclusionKeywords: CONFIG.exclusionKeywords,
                maxPrice: CONFIG.maxPrice,
                intervalMinutes: CONFIG.intervalMinutes,
                webhookUrl: CONFIG.webhookUrl,
                webhookConfigured: !!CONFIG.webhookUrl,
            },
            status: {
                isScanning: state.isScanning,
                scanCount: state.scanCount,
                lastScan: state.lastScan,
                nextScan: state.nextScan,
                totalTracked: stats.totalTracked,
            },
            listings: state.allFoundListings,
            alertHistory: state.alertHistory,
            scanLog: state.scanLog,
        }
    }));
});

// ── Main Entry Point ──────────────────────────────────────────
async function main() {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log(`║   ${CONFIG.projectName.padEnd(46)} ║`);
    console.log('╚══════════════════════════════════════════════════════╝\n');

    // Launch stealth scraper
    state.scraper = new StealthScraper();
    await state.scraper.launch();

    // Send startup Discord notification
    if (CONFIG.webhookUrl) {
        await sendStartupNotification(CONFIG.webhookUrl, CONFIG);
    }

    // Start HTTP server
    server.listen(CONFIG.port, () => {
        console.log(`  ✅ Dashboard: http://localhost:${CONFIG.port}`);
        console.log(`  🔍 Search:   ${CONFIG.query}`);
        console.log(`  💰 Max:      $${CONFIG.maxPrice}`);
        console.log(`  ⏱️  Interval: Every ${CONFIG.intervalMinutes} minutes\n`);
    });

    // Run first scan, then start scheduler
    await runScan();
    startScheduler();
}

// ── Graceful Shutdown ─────────────────────────────────────────
async function shutdown(signal) {
    console.log(`\n[Server] Received ${signal}. Shutting down...`);
    if (state.cronJob) state.cronJob.stop();
    if (state.scraper) await state.scraper.close();
    server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[Server] Unhandled:', err));

main().catch((err) => {
    console.error('[Server] Fatal:', err);
    process.exit(1);
});
