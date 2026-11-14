// Stealth scraper

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

function getRandomViewport() {
    const sizes = [[1366, 768], [1440, 900], [1600, 1024], [1920, 1080], [2560, 1440]];
    const [w, h] = sizes[Math.floor(Math.random() * sizes.length)];
    return { width: w, height: h };
}

function randomDelay(minMs = 1000, maxMs = 4000) {
    return new Promise(r => setTimeout(r, Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs));
}

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

class StealthScraper {
    constructor() { this.browser = null; }

    async launch() {
        const viewport = getRandomViewport();
        const ua = getRandomUserAgent();
        this.browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                '--disable-dev-shm-usage',
                `--user-agent=${ua}`,
                `--window-size=${viewport.width},${viewport.height}`,
                '--lang=en-US,en',
            ],
            defaultViewport: viewport,
        });
        console.log(`[Scraper] Browser launched (${viewport.width}x${viewport.height})`);
        return this;
    }

    // Scrape listings
    async scrapeListings(url, maxRetries = 3) {
        if (!this.browser) await this.launch();

        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const page = await this.browser.newPage();

            try {
                await randomDelay(800, 1800);
                console.log(`[Scraper] Attempt ${attempt}/${maxRetries} — ${url.substring(0, 80)}...`);

                const res = await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
                if (!res || res.status() >= 400) throw new Error(`HTTP ${res?.status() || '?'}`);

                // Lazy load scroll
                await randomDelay(1500, 3000);
                await page.evaluate(async () => {
                    await new Promise(resolve => {
                        let scrolled = 0;
                        const t = setInterval(() => {
                            window.scrollBy(0, 400);
                            scrolled += 400;
                            if (scrolled >= 5000) { clearInterval(t); window.scrollTo(0, 0); resolve(); }
                        }, 120);
                    });
                });
                await randomDelay(800, 1500);

                // DOM extraction
                const data = await page.evaluate(() => {

                    // Clean text helper
                    function cleanText(el) {
                        if (!el) return '';
                        // Remove hidden spans
                        const clone = el.cloneNode(true);
                        clone.querySelectorAll('.clipped, [class*="clipped"], sr-only').forEach(e => e.remove());
                        return clone.textContent.replace(/\s+/g, ' ').trim();
                    }

                    // Parse price helper
                    function parsePrice(text) {
                        if (!text) return null;
                        // Lower range price
                        const parts = text.split(/ to /i);
                        const m = parts[0].match(/([\d,]+\.?\d*)/);
                        return m ? parseFloat(m[1].replace(/,/g, '')) : null;
                    }

                    const results = [];

                    // Find item links
                    const srpRoot = document.querySelector(
                        '.srp-river-results, ul.srp-results__list, .srp-results'
                    ) || document.body;

                    // Collect links
                    const allLinks = Array.from(srpRoot.querySelectorAll('a[href*="/itm/"]'));

                    // Map card containers
                    const cardMap = new Map();
                    for (const link of allLinks) {
                        const href = link.href || '';
                        const m = href.match(/\/itm\/(\d+)/);
                        if (!m) continue;
                        const itemId = m[1];
                        if (cardMap.has(itemId)) continue; // Skip existing

                        // Find card container
                        let el = link;
                        for (let i = 0; i < 8; i++) {
                            if (!el.parentElement) break;
                            el = el.parentElement;
                            // Check container
                            const hasPriceEl = el.querySelector(
                                '.s-card__price, .s-item__price, [class*="s-card__price"]'
                            );
                            if (hasPriceEl) {
                                cardMap.set(itemId, { card: el, link, itemId });
                                break;
                            }
                        }
                    }

                    // Extract card data
                    for (const [itemId, { card, link }] of cardMap.entries()) {

                        try {
                            // Title
                            let title = '';
                            const titleEl = card.querySelector(
                                '.s-card__title, .s-item__title, [role="heading"]'
                            );
                            if (titleEl) {
                                title = cleanText(titleEl)
                                    .replace(/^New Listing\s*/i, '')
                                    .replace(/Opens in a new window or tab\.?/gi, '')
                                    .trim();
                            }
                            if (!title) {
                                const img = card.querySelector('img');
                                title = img?.alt || link.title || '';
                            }
                            if (!title || title.length < 8) continue;

                            // Price
                            let price = null;
                            const priceEl = card.querySelector(
                                '.s-card__price, .s-item__price, [class*="s-card__price"]'
                            );
                            if (priceEl) {
                                price = parsePrice(priceEl.textContent);
                            }
                            if (!price || price <= 0) continue;

                            // Condition
                            let subtitle = '';
                            const subEl = card.querySelector(
                                '.s-card__subtitle, .s-item__subtitle, .SECONDARY_INFO'
                            );
                            if (subEl) subtitle = cleanText(subEl);

                            // Image
                            const imgEl = card.querySelector('img.s-card__image, img');
                            const image = imgEl?.src || imgEl?.getAttribute('data-src') || '';

                            // Shipping cost
                            let shippingCost = 0;
                            let shippingText = 'Free shipping'; // Default free
                            const cardText = card.textContent.toLowerCase();

                            if (cardText.includes('free shipping') || cardText.includes('free delivery')) {
                                shippingCost = 0;
                                shippingText = 'Free shipping';
                            } else {
                                // Parse shipping
                                const attrRows = card.querySelectorAll(
                                    '.s-card__attribute-row, .s-item__shipping'
                                );
                                for (const row of attrRows) {
                                    const txt = row.textContent.toLowerCase();
                                    if (txt.includes('shipping') || txt.includes('delivery')) {
                                        const m = txt.match(/([\d,]+\.?\d*)/);
                                        if (m) {
                                            const cost = parseFloat(m[1].replace(/,/g, ''));
                                            if (cost > 0 && cost < 150) {
                                                shippingCost = cost;
                                                shippingText = `+$${cost.toFixed(2)} shipping`;
                                                break;
                                            }
                                        }
                                    }
                                }
                            }

                            results.push({
                                itemId,
                                title,
                                price,
                                shippingCost,
                                totalPrice: price + shippingCost,
                                subtitle,
                                url: `https://www.ebay.com/itm/${itemId}`,
                                image,
                                shippingText,
                            });

                        } catch (_) { /* skip */ }
                    }

                    return {
                        results,
                        debug: {
                            totalLinks: document.querySelectorAll('a[href*="/itm/"]').length,
                            totalCards: cardMap ? results.length : 0,
                            srpFound: !!document.querySelector('.srp-river-results, ul.srp-results__list'),
                            pageTitle: document.title,
                        }
                    };
                });

                await page.close();

                console.log(`[Scraper] Extracted ${data.results.length} listings | SRP found: ${data.debug.srpFound} | /itm/ links: ${data.debug.totalLinks}`);
                console.log(`[Scraper] Page: "${data.debug.pageTitle.substring(0, 60)}"`);

                return data.results;

            } catch (error) {
                lastError = error;
                console.error(`[Scraper] Attempt ${attempt} failed: ${error.message}`);
                await page.close().catch(() => { });
                if (attempt < maxRetries) {
                    const backoff = Math.pow(3, attempt) * 1000;
                    console.log(`[Scraper] Retry in ${backoff / 1000}s...`);
                    await new Promise(r => setTimeout(r, backoff));
                }
            }
        }

        throw new Error(`Failed after ${maxRetries} attempts: ${lastError?.message}`);
    }

    // Scrape multiple targets
    async scrapeMultiTargets(targets, buildSearchUrlFn, filterListingsFn, options = {}) {
        const {
            interQueryDelayMs = 4000,
            onTargetProgress = null,
        } = options;

        if (!this.browser) await this.launch();

        const activeTargets = targets.filter(t => t.enabled !== false);
        console.log(`[Scraper] Starting multi-target batch scan across ${activeTargets.length} active target(s)...`);

        const allMatchingListings = [];
        const targetSummaries = [];

        for (let i = 0; i < activeTargets.length; i++) {
            const target = activeTargets[i];
            console.log(`\n[Scraper] Target ${i + 1}/${activeTargets.length}: "${target.name}" ($${target.maxPrice} max)`);

            if (onTargetProgress) {
                onTargetProgress({
                    index: i + 1,
                    total: activeTargets.length,
                    target,
                    status: 'starting'
                });
            }

            try {
                const searchUrl = buildSearchUrlFn(target);
                const rawListings = await this.scrapeListings(searchUrl, 2);
                const filtered = filterListingsFn(rawListings, target);

                allMatchingListings.push(...filtered);
                targetSummaries.push({
                    targetId: target.id,
                    targetName: target.name,
                    category: target.category,
                    rawCount: rawListings.length,
                    matchCount: filtered.length,
                    status: 'success'
                });

                if (onTargetProgress) {
                    onTargetProgress({
                        index: i + 1,
                        total: activeTargets.length,
                        target,
                        status: 'completed',
                        rawCount: rawListings.length,
                        matchCount: filtered.length,
                    });
                }
            } catch (err) {
                console.error(`[Scraper] [ERROR] Target "${target.name}" failed: ${err.message}`);
                targetSummaries.push({
                    targetId: target.id,
                    targetName: target.name,
                    category: target.category,
                    rawCount: 0,
                    matchCount: 0,
                    status: 'error',
                    error: err.message
                });

                if (onTargetProgress) {
                    onTargetProgress({
                        index: i + 1,
                        total: activeTargets.length,
                        target,
                        status: 'failed',
                        error: err.message
                    });
                }
            }

            // Jitter delay
            if (i < activeTargets.length - 1) {
                const jitter = Math.floor(Math.random() * 2000) - 1000;
                const waitTime = Math.max(1500, interQueryDelayMs + jitter);
                console.log(`[Scraper] Jitter delay (${(waitTime / 1000).toFixed(1)}s) before next target...`);
                await randomDelay(waitTime - 500, waitTime + 500);
            }
        }

        console.log(`[Scraper] [OK] Multi-target scan complete: ${allMatchingListings.length} total matches across ${activeTargets.length} targets.`);
        return {
            listings: allMatchingListings,
            summaries: targetSummaries,
        };
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            console.log('[Scraper] Browser closed.');
        }
    }
}

module.exports = { StealthScraper, randomDelay };
