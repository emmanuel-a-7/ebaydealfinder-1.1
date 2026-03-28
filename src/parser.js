// ============================================================
// src/parser.js — eBay Listing Filter
// Filters raw listings extracted by the scraper from the live DOM
// ============================================================

// Keywords in condition/subtitle that mean "for parts / not working"
const EXCLUDED_CONDITIONS = [
    'for parts or not working',
    'for parts',
    'not working',
    'for parts/not working',
    'salvage',
];

/**
 * Build the eBay search URL with all filters pre-applied
 */
function buildSearchUrl(config = {}) {
    const {
        query = 'nvidia rtx 3060 12gb',
        maxPrice = 250,
    } = config;

    const baseUrl = 'https://www.ebay.com/sch/i.html';
    const params = new URLSearchParams({
        _nkw: query,
        _udhi: maxPrice.toString(),
        LH_BIN: '1',                      // Buy It Now only
        LH_ItemCondition: '1000|1500|2000|2500|3000', // New, Open Box, Refurbished, Seller Refurbished, Used
        _sop: '15',                        // Sort by: Newly Listed
        LH_PrefLoc: '1',                   // US only
        _ipg: '120',                       // Max results per page
        rt: 'nc',
    });

    return `${baseUrl}?${params.toString()}`;
}

/**
 * Filter raw listings extracted from the DOM
 * @param {Array} rawListings - Raw listing objects from scraper's page.evaluate()
 * @param {Object} config - Configuration object with maxPrice, requiredKeywords, exclusionKeywords
 * @returns {Array} - Filtered listings that match all criteria
 */
function filterListings(rawListings, config = {}) {
    const { maxPrice = 250, requiredKeywords = '', exclusionKeywords = '' } = config;
    const required = requiredKeywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
    const excluded = exclusionKeywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k);

    const filtered = [];
    const rejectCounts = { noPrice: 0, priceHigh: 0, noKeyword: 0, excluded: 0, condition: 0 };

    // Debug: show first 5 raw titles
    console.log('[Parser] First 5 raw titles:');
    rawListings.slice(0, 5).forEach((l, i) => {
        console.log(`  ${i + 1}. price=$${l.price} total=$${l.totalPrice} title=${JSON.stringify((l.title || '').substring(0, 80))}`);
    });

    for (const listing of rawListings) {
        const titleLower = (listing.title || '').toLowerCase();
        const subtitleLower = (listing.subtitle || '').toLowerCase();

        // Must have valid price
        if (!listing.price || listing.price <= 0) { rejectCounts.noPrice++; continue; }

        // Must be within price threshold
        if (listing.totalPrice > maxPrice) { rejectCounts.priceHigh++; continue; }

        // Must contain ANY of the required keywords (if specified)
        if (required.length > 0 && !required.some((kw) => titleLower.includes(kw))) { rejectCounts.noKeyword++; continue; }

        // Must NOT contain exclusion keywords
        const matchedExclusion = excluded.find((kw) => titleLower.includes(kw));
        if (matchedExclusion) { rejectCounts.excluded++; continue; }

        // Must NOT be "for parts / not working"
        if (EXCLUDED_CONDITIONS.some((exc) => subtitleLower.includes(exc))) { rejectCounts.condition++; continue; }
        if (EXCLUDED_CONDITIONS.some((exc) => titleLower.includes(exc))) { rejectCounts.condition++; continue; }

        // Extract condition from subtitle
        const conditionParts = (listing.subtitle || '').split('·').map((s) => s.trim());
        const condition = conditionParts[0] || 'Unknown';

        // Clean the URL
        const cleanedUrl = cleanUrl(listing.url);

        filtered.push({
            itemId: listing.itemId,
            title: listing.title,
            price: listing.price,
            shippingCost: listing.shippingCost,
            totalPrice: listing.totalPrice,
            condition,
            subtitle: listing.subtitle,
            url: cleanedUrl,
            image: listing.image,
            shippingText: listing.shippingText,
            foundAt: new Date().toISOString(),
        });
    }

    console.log(`[Parser] ${filtered.length} listings passed all filters (from ${rawListings.length} raw)`);
    return filtered;
}

/**
 * Clean eBay URL — keep only the essential item path
 */
function cleanUrl(url) {
    try {
        const u = new URL(url);
        const itemMatch = u.pathname.match(/\/itm\/\d+/);
        if (itemMatch) {
            return `https://www.ebay.com${itemMatch[0]}`;
        }
        return `https://www.ebay.com${u.pathname}`;
    } catch {
        return url;
    }
}

module.exports = { buildSearchUrl, filterListings };
