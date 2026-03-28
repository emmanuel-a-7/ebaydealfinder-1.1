// ============================================================
// src/discord.js — Discord Webhook Integration
// Sends rich embed notifications for deal alerts
// ============================================================

const axios = require('axios');

/**
 * Get embed color based on total price
 * Green = incredible deal, Yellow = good deal, Orange = fair deal
 */
function getPriceColor(totalPrice) {
    if (totalPrice <= 150) return 0x00ff88;   // Bright green - steal
    if (totalPrice <= 180) return 0x2ecc71;   // Green - great deal
    if (totalPrice <= 220) return 0xf1c40f;   // Yellow - good deal
    return 0xe67e22;                           // Orange - fair deal
}

/**
 * Send a rich embed notification for a found listing
 */
async function sendListingAlert(webhookUrl, listing, config = {}) {
    const projName = config.projectName || 'Deal Hunter';
    const embed = {
        title: `🚨 Deal Found: ${listing.title.substring(0, 30)}...`,
        description: `**${listing.title}**`,
        url: listing.url,
        color: getPriceColor(listing.totalPrice),
        fields: [
            {
                name: '💰 Price',
                value: `**$${listing.price.toFixed(2)}**`,
                inline: true,
            },
            {
                name: '📦 Shipping',
                value: listing.shippingCost === 0 ? '✅ FREE' : `$${listing.shippingCost.toFixed(2)}`,
                inline: true,
            },
            {
                name: '💵 Total',
                value: `**$${listing.totalPrice.toFixed(2)}**`,
                inline: true,
            },
            {
                name: '📋 Condition',
                value: listing.condition,
                inline: true,
            },
            {
                name: '🔗 Link',
                value: `[View on eBay](${listing.url})`,
                inline: true,
            },
        ],
        thumbnail: listing.image ? { url: listing.image } : undefined,
        footer: {
            text: `${projName} • Item #${listing.itemId}`,
        },
        timestamp: listing.foundAt,
    };

    try {
        await axios.post(webhookUrl, {
            username: `${projName} 🤖`,
            avatar_url: 'https://cdn-icons-png.flaticon.com/512/2103/2103832.png',
            embeds: [embed],
        });
        console.log(`[Discord] ✅ Alert sent for: ${listing.title.substring(0, 50)}...`);
    } catch (error) {
        console.error(`[Discord] ❌ Failed to send alert: ${error.message}`);
        if (error.response) {
            console.error(`[Discord] Status: ${error.response.status}, Data:`, error.response.data);
        }
    }
}

/**
 * Send multiple listing alerts with rate-limit awareness
 */
async function sendListingAlerts(webhookUrl, listings, config = {}) {
    for (let i = 0; i < listings.length; i++) {
        await sendListingAlert(webhookUrl, listings[i], config);

        // Discord webhook rate limit: ~30 requests per minute
        // Add 2s delay between messages to be safe
        if (i < listings.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
}

/**
 * Send a startup notification confirming the scraper is running
 */
async function sendStartupNotification(webhookUrl, config = {}) {
    const projName = config.projectName || 'Deal Hunter';
    const embed = {
        title: `🚀 ${projName} Started`,
        description: `The scraper is now running and monitoring for deals.`,
        color: 0x3498db,
        fields: [
            {
                name: '🔍 Search Query',
                value: `\`${config.query}\``,
                inline: true,
            },
            {
                name: '💰 Max Price',
                value: `$${config.maxPrice}`,
                inline: true,
            },
            {
                name: '⏱️ Scan Interval',
                value: `Every ${config.intervalMinutes} minutes`,
                inline: true,
            },
        ],
        footer: {
            text: projName,
        },
        timestamp: new Date().toISOString(),
    };

    try {
        await axios.post(webhookUrl, {
            username: `${projName} 🤖`,
            avatar_url: 'https://cdn-icons-png.flaticon.com/512/2103/2103832.png',
            embeds: [embed],
        });
        console.log('[Discord] ✅ Startup notification sent.');
    } catch (error) {
        console.error(`[Discord] ❌ Failed to send startup notification: ${error.message}`);
    }
}

/**
 * Send a scan summary notification 
 */
async function sendScanSummary(webhookUrl, totalFound, newFound, nextScanTime) {
    const embed = {
        title: newFound > 0 ? '📊 Scan Complete — New Deals Found!' : '📊 Scan Complete — No New Deals',
        color: newFound > 0 ? 0x2ecc71 : 0x95a5a6,
        fields: [
            {
                name: 'Total Matches',
                value: `${totalFound}`,
                inline: true,
            },
            {
                name: 'New Listings',
                value: `${newFound}`,
                inline: true,
            },
            {
                name: 'Next Scan',
                value: nextScanTime,
                inline: true,
            },
        ],
        footer: {
            text: 'eBay Monitor',
        },
        timestamp: new Date().toISOString(),
    };

    try {
        await axios.post(webhookUrl, {
            username: 'Deal Bot 🤖',
            avatar_url: 'https://cdn-icons-png.flaticon.com/512/2103/2103832.png',
            embeds: [embed],
        });
    } catch (error) {
        console.error(`[Discord] ❌ Failed to send scan summary: ${error.message}`);
    }
}

/**
 * Send an error notification
 */
async function sendErrorNotification(webhookUrl, errorMessage, config = {}) {
    const projName = config.projectName || 'Deal Hunter';
    try {
        await axios.post(webhookUrl, {
            username: `${projName} 🤖`,
            avatar_url: 'https://cdn-icons-png.flaticon.com/512/2103/2103832.png',
            embeds: [{
                title: '⚠️ Scraper Error',
                description: `\`\`\`${errorMessage}\`\`\``,
                color: 0xe74c3c,
                timestamp: new Date().toISOString(),
                footer: { text: projName },
            }],
        });
    } catch (err) {
        console.error('[Discord] ❌ Failed to send error notification:', err.message);
    }
}

module.exports = {
    sendListingAlert,
    sendListingAlerts,
    sendStartupNotification,
    sendScanSummary,
    sendErrorNotification,
};
