// Listing parser

// Excluded conditions
const EXCLUDED_CONDITIONS = [
    'for parts or not working',
    'for parts',
    'not working',
    'for parts/not working',
    'salvage',
];

// Build search URL
function buildSearchUrl(config = {}) {
    const {
        query = 'apple mac mini m4',
        maxPrice = 600,
    } = config;

    const baseUrl = 'https://www.ebay.com/sch/i.html';
    const params = new URLSearchParams({
        _nkw: query,
        _udhi: maxPrice.toString(),
        LH_BIN: '1',                      // Buy It Now
        LH_ItemCondition: '1000|1500|2000|2500|3000', // Valid conditions
        _sop: '15',                        // Newly listed
        LH_PrefLoc: '1',                   // US only
        _ipg: '120',                       // Max results
        rt: 'nc',
    });

    return `${baseUrl}?${params.toString()}`;
}

// Filter listings
function filterListings(rawListings, config = {}) {
    const {
        maxPrice = 250,
        requiredKeywords = '',
        exclusionKeywords = '',
        id: targetId = null,
        name: targetName = null,
        category: targetCategory = null,
    } = config;
    const required = requiredKeywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
    const excluded = exclusionKeywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k);

    const filtered = [];
    const rejectCounts = { noPrice: 0, priceHigh: 0, noKeyword: 0, excluded: 0, condition: 0 };

    // Debug preview
    console.log('[Parser] First 5 raw titles:');
    rawListings.slice(0, 5).forEach((l, i) => {
        console.log(`  ${i + 1}. price=$${l.price} total=$${l.totalPrice} title=${JSON.stringify((l.title || '').substring(0, 80))}`);
    });

    for (const listing of rawListings) {
        const titleLower = (listing.title || '').toLowerCase();
        const subtitleLower = (listing.subtitle || '').toLowerCase();

        // Validate price
        if (!listing.price || listing.price <= 0) { rejectCounts.noPrice++; continue; }

        // Price threshold
        if (listing.totalPrice > maxPrice) { rejectCounts.priceHigh++; continue; }

        // Required keywords
        if (required.length > 0 && !required.some((kw) => titleLower.includes(kw))) { rejectCounts.noKeyword++; continue; }

        // Exclusion check
        const matchedExclusion = excluded.find((kw) => titleLower.includes(kw));
        if (matchedExclusion) { rejectCounts.excluded++; continue; }

        // Condition check
        if (EXCLUDED_CONDITIONS.some((exc) => subtitleLower.includes(exc))) { rejectCounts.condition++; continue; }
        if (EXCLUDED_CONDITIONS.some((exc) => titleLower.includes(exc))) { rejectCounts.condition++; continue; }

        // Extract condition
        const conditionParts = (listing.subtitle || '').split('·').map((s) => s.trim());
        const condition = conditionParts[0] || 'Unknown';

        // Clean URL
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
            targetId: targetId || config.id || null,
            targetName: targetName || config.name || config.projectName || 'General Target',
            targetCategory: targetCategory || config.category || 'General',
            targetMaxPrice: maxPrice,
            targetUrgentPrice: config.urgentPrice || null,
            foundAt: new Date().toISOString(),
        });
    }

    console.log(`[Parser] ${filtered.length} listings passed all filters (from ${rawListings.length} raw)`);
    return filtered;
}

// Clean URL
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
