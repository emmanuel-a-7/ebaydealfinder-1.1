// Dashboard server

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

// Config
const CONFIG_FILE = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    intervalMinutes: parseInt(process.env.SCAN_INTERVAL_MINUTES, 10) || 10,
    maxPrice: parseInt(process.env.MAX_PRICE, 10) || 600,
    query: process.env.SEARCH_QUERY || '',
    projectName: process.env.PROJECT_NAME || 'High-Value Multi-Deal Finder',
    requiredKeywords: '',
    exclusionKeywords: 'box only, empty box, broken, parts, for parts',
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

// State
const state = {
    isScanning: false,
    scanCount: 0,
    lastScan: null,
    nextScan: null,
    allFoundListings: [],    // Found listings
    alertHistory: [],         // Alert history
    scanLog: [],              // Scan log
    scraper: null,
    cronJob: null,
};

const TARGETS_FILE = path.join(__dirname, 'targets.json');

function loadTargets() {
    try {
        if (fs.existsSync(TARGETS_FILE)) {
            const data = fs.readFileSync(TARGETS_FILE, 'utf8');
            const targets = JSON.parse(data);
            if (Array.isArray(targets)) return targets;
        }
    } catch (e) {
        console.error('[Config] Failed to load targets.json:', e.message);
    }
    return [];
}

function saveTargets(targets) {
    try {
        fs.writeFileSync(TARGETS_FILE, JSON.stringify(targets, null, 2));
    } catch (e) {
        console.error('[Config] Failed to save targets.json:', e.message);
    }
}

// Express app
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// WebSocket broadcast
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

// REST API
// State endpoint
app.get('/api/state', (req, res) => {
    const stats = getTrackerStats();
    const targets = loadTargets();
    res.json({
        config: {
            query: CONFIG.query,
            projectName: CONFIG.projectName,
            requiredKeywords: CONFIG.requiredKeywords,
            exclusionKeywords: CONFIG.exclusionKeywords,
            maxPrice: CONFIG.maxPrice,
            intervalMinutes: CONFIG.intervalMinutes,
            interQueryDelaySec: CONFIG.interQueryDelaySec || 4,
            webhookUrl: CONFIG.webhookUrl,
            webhookConfigured: !!CONFIG.webhookUrl,
        },
        targets,
        status: {
            isScanning: state.isScanning,
            scanCount: state.scanCount,
            lastScan: state.lastScan,
            nextScan: state.nextScan,
            totalTracked: stats.totalTracked,
            activeTargetsCount: targets.filter(t => t.enabled !== false).length,
            totalTargetsCount: targets.length,
        },
        listings: state.allFoundListings,
        alertHistory: state.alertHistory,
        scanLog: state.scanLog,
    });
});

// Get targets
app.get('/api/targets', (req, res) => {
    res.json({ ok: true, targets: loadTargets() });
});

// Save target
app.post('/api/targets', (req, res) => {
    const { id, name, category, query, maxPrice, urgentPrice, requiredKeywords, exclusionKeywords, enabled } = req.body;
    if (!name || !query || !maxPrice) {
        return res.status(400).json({ ok: false, message: 'Name, query, and maxPrice are required.' });
    }

    const targets = loadTargets();
    const targetId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const existingIndex = targets.findIndex(t => t.id === targetId);

    const targetObj = {
        id: targetId,
        name,
        category: category || 'General',
        query,
        maxPrice: parseFloat(maxPrice),
        urgentPrice: urgentPrice ? parseFloat(urgentPrice) : undefined,
        requiredKeywords: requiredKeywords || '',
        exclusionKeywords: exclusionKeywords || '',
        enabled: enabled !== undefined ? !!enabled : true,
    };

    if (existingIndex >= 0) {
        targets[existingIndex] = targetObj;
    } else {
        targets.push(targetObj);
    }

    saveTargets(targets);
    broadcast('targets_updated', { targets });
    addLog('info', `[Target] Target "${name}" saved (${targets.length} total)`);
    res.json({ ok: true, target: targetObj, targets });
});

// Toggle target
app.post('/api/targets/toggle', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ ok: false, message: 'Target ID is required' });

    const targets = loadTargets();
    const target = targets.find(t => t.id === id);
    if (!target) return res.status(404).json({ ok: false, message: 'Target not found' });

    target.enabled = !target.enabled;
    saveTargets(targets);
    broadcast('targets_updated', { targets });
    addLog('info', `[Target] Target "${target.name}" ${target.enabled ? 'ENABLED' : 'DISABLED'}`);
    res.json({ ok: true, target, targets });
});

// Delete target
app.delete('/api/targets/:id', (req, res) => {
    const { id } = req.params;
    let targets = loadTargets();
    const initialLen = targets.length;
    targets = targets.filter(t => t.id !== id);

    if (targets.length === initialLen) {
        return res.status(404).json({ ok: false, message: 'Target not found' });
    }

    saveTargets(targets);
    broadcast('targets_updated', { targets });
    addLog('info', `[Target] Target removed (${targets.length} remaining)`);
    res.json({ ok: true, targets });
});

// Trigger scan
app.post('/api/scan', async (req, res) => {
    if (state.isScanning) {
        return res.json({ ok: false, message: 'Scan already in progress' });
    }
    res.json({ ok: true, message: 'Scan triggered' });
    runScan();
});

// Update config
app.post('/api/config', (req, res) => {
    const { query, projectName, requiredKeywords, exclusionKeywords, maxPrice, intervalMinutes, interQueryDelaySec, webhookUrl } = req.body;

    if (query !== undefined) CONFIG.query = query;
    if (projectName !== undefined) CONFIG.projectName = projectName;
    if (requiredKeywords !== undefined) CONFIG.requiredKeywords = requiredKeywords;
    if (exclusionKeywords !== undefined) CONFIG.exclusionKeywords = exclusionKeywords;
    if (webhookUrl !== undefined) CONFIG.webhookUrl = webhookUrl;
    if (interQueryDelaySec && interQueryDelaySec >= 1 && interQueryDelaySec <= 60) CONFIG.interQueryDelaySec = interQueryDelaySec;

    if (maxPrice && maxPrice > 0 && maxPrice <= 50000) CONFIG.maxPrice = maxPrice;
    if (intervalMinutes && intervalMinutes >= 2 && intervalMinutes <= 1440) {
        CONFIG.intervalMinutes = intervalMinutes;
        restartScheduler();
    }

    saveConfig();
    broadcast('config', CONFIG);
    res.json({ ok: true, config: CONFIG });
});

// Reset history
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

// Core scan
async function runScan() {
    if (state.isScanning) return;

    state.isScanning = true;
    state.scanCount++;
    const scanNum = state.scanCount;
    state.lastScan = new Date().toISOString();

    broadcast('scan_start', { scanCount: scanNum });
    addLog('info', `Scan #${scanNum} started`);

    try {
        const targets = loadTargets();
        const activeTargets = targets.filter(t => t.enabled !== false);
        let allListings = [];

        if (activeTargets.length > 0) {
            addLog('info', `Starting multi-target scan across ${activeTargets.length} target(s)...`);
            const delayMs = (CONFIG.interQueryDelaySec || 4) * 1000;

            const res = await state.scraper.scrapeMultiTargets(
                targets,
                buildSearchUrl,
                filterListings,
                {
                    interQueryDelayMs: delayMs,
                    onTargetProgress: (prog) => {
                        broadcast('target_progress', prog);
                        if (prog.status === 'starting') {
                            addLog('info', `[${prog.index}/${prog.total}] Scanning target: "${prog.target.name}" ($${prog.target.maxPrice} max)`);
                        } else if (prog.status === 'completed') {
                            addLog('info', `   ↳ Found ${prog.matchCount} matching deal(s) (from ${prog.rawCount} raw)`);
                        } else if (prog.status === 'failed') {
                            addLog('error', `   ↳ Target "${prog.target.name}" error: ${prog.error}`);
                        }
                    }
                }
            );
            allListings = res.listings;
        } else {
            addLog('info', `Single target fallback mode: "${CONFIG.query}"`);
            const searchUrl = buildSearchUrl(CONFIG);
            const rawListings = await state.scraper.scrapeListings(searchUrl);
            allListings = filterListings(rawListings, CONFIG);
        }

        addLog('info', `Extracted ${allListings.length} total filtered deals across scan`);

        // Merge listings
        for (const listing of allListings) {
            if (!state.allFoundListings.find(l => l.itemId === listing.itemId)) {
                state.allFoundListings.unshift(listing);
            }
        }
        // Limit cache
        if (state.allFoundListings.length > 500) {
            state.allFoundListings = state.allFoundListings.slice(0, 500);
        }

        broadcast('listings', { listings: state.allFoundListings, totalFound: allListings.length });

        // Filter new listings
        const newListings = filterNewListings(allListings);
        addLog(newListings.length > 0 ? 'success' : 'info',
            newListings.length > 0
                ? `${newListings.length} NEW deal(s) found! Sending Discord alerts...`
                : `No new listings since last scan`
        );

        if (newListings.length > 0 && CONFIG.webhookUrl) {
            await sendListingAlerts(CONFIG.webhookUrl, newListings, CONFIG);
            // Track alerts
            for (const listing of newListings) {
                const alertEntry = { ...listing, alertedAt: new Date().toISOString() };
                state.alertHistory.unshift(alertEntry);
                if (state.alertHistory.length > 50) state.alertHistory.pop();
            }
            broadcast('alerts', { alerts: state.alertHistory });
            addLog('success', `Sent ${newListings.length} Discord alert(s)`);
        }

        // Next scan time
        const nextMs = CONFIG.intervalMinutes * 60 * 1000;
        state.nextScan = new Date(Date.now() + nextMs).toISOString();

        broadcast('scan_complete', {
            scanCount: scanNum,
            totalFound: allListings.length,
            newFound: newListings.length,
            nextScan: state.nextScan,
        });

        addLog('info', `Scan #${scanNum} complete | Next scan at ${new Date(state.nextScan).toLocaleTimeString()}`);

    } catch (error) {
        addLog('error', `Scan #${scanNum} failed: ${error.message}`);
        broadcast('scan_error', { error: error.message });

        if (CONFIG.webhookUrl) {
            await sendErrorNotification(CONFIG.webhookUrl, error.message, CONFIG).catch(() => { });
        }
    } finally {
        state.isScanning = false;
    }
}

// Scheduler
function startScheduler() {
    const cron = require('node-cron');
    const expr = `*/${CONFIG.intervalMinutes} * * * *`;
    state.cronJob = cron.schedule(expr, async () => {
        // Recycle browser
        if (state.scanCount > 0 && state.scanCount % 6 === 0) {
            addLog('info', 'Recycling browser...');
            await state.scraper.close();
            await state.scraper.launch();
        }
        runScan();
    });
}

function restartScheduler() {
    if (state.cronJob) state.cronJob.stop();
    startScheduler();
    addLog('info', `Scheduler restarted: every ${CONFIG.intervalMinutes} minutes`);
}

// WebSocket handler
wss.on('connection', (ws) => {
    // Send initial state
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

// Main entry
async function main() {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log(`║   ${CONFIG.projectName.padEnd(46)} ║`);
    console.log('╚══════════════════════════════════════════════════════╝\n');

    // Launch scraper
    state.scraper = new StealthScraper();
    await state.scraper.launch();

    // Startup notification
    if (CONFIG.webhookUrl) {
        await sendStartupNotification(CONFIG.webhookUrl, CONFIG);
    }

    // Start server
    server.listen(CONFIG.port, () => {
        console.log(`  Dashboard: http://localhost:${CONFIG.port}`);
        console.log(`  Search:   ${CONFIG.query || 'Multi-Target'}`);
        console.log(`  Max:      $${CONFIG.maxPrice}`);
        console.log(`  Interval: Every ${CONFIG.intervalMinutes} minutes\n`);
    });

    // Start scanner
    await runScan();
    startScheduler();
}

// Shutdown
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
