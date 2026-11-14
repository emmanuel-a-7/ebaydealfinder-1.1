// Listing tracker

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SEEN_FILE = path.join(DATA_DIR, 'seen_listings.json');

// Expiry duration
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

// Load seen listings
function loadSeenListings() {
    try {
        if (fs.existsSync(SEEN_FILE)) {
            const data = fs.readFileSync(SEEN_FILE, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.warn('[Tracker] Failed to load seen listings, starting fresh:', error.message);
    }
    return {};
}

// Save seen listings
function saveSeenListings(seen) {
    try {
        // Ensure directory
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
    } catch (error) {
        console.error('[Tracker] Failed to save seen listings:', error.message);
    }
}

// Filter new listings
function filterNewListings(listings) {
    const seen = loadSeenListings();
    const now = Date.now();

    // Clean expired
    let cleaned = 0;
    for (const [id, data] of Object.entries(seen)) {
        if (now - new Date(data.firstSeen).getTime() > EXPIRY_MS) {
            delete seen[id];
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`[Tracker] Cleaned ${cleaned} expired entries`);
    }

    // Find new listings
    const newListings = [];
    for (const listing of listings) {
        if (!seen[listing.itemId]) {
            newListings.push(listing);
            seen[listing.itemId] = {
                firstSeen: listing.foundAt,
                lastSeen: listing.foundAt,
                title: listing.title,
                price: listing.totalPrice,
            };
        } else {
            // Update timestamp
            seen[listing.itemId].lastSeen = listing.foundAt;
        }
    }

    // Save state
    saveSeenListings(seen);

    console.log(
        `[Tracker] ${newListings.length} new listings | ${Object.keys(seen).length} total tracked`
    );

    return newListings;
}

// Tracker stats
function getTrackerStats() {
    const seen = loadSeenListings();
    return {
        totalTracked: Object.keys(seen).length,
        listings: seen,
    };
}

// Clear listings
function clearTrackedListings() {
    saveSeenListings({});
    console.log('[Tracker] All tracked listings cleared.');
}

module.exports = {
    filterNewListings,
    getTrackerStats,
    clearTrackedListings,
};
