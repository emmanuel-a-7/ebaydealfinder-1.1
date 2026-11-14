// Discord webhook integration

const axios = require('axios');

// Price color
function getPriceColor(totalPrice, savingsPct = 0) {
    if (savingsPct >= 25 || totalPrice <= 150) return 0x00ff88;   // Steal
    if (savingsPct >= 15 || totalPrice <= 250) return 0x2ecc71;   // Great deal
    if (savingsPct >= 5 || totalPrice <= 400) return 0xf1c40f;    // Good deal
    return 0xe67e22;                                              // Fair deal
}

// Send listing alert
async function sendListingAlert(webhookUrl, listing, config = {}) {
    const projName = config.projectName || 'Deal Hunter';
    const targetBadge = listing.targetName ? `[${listing.targetCategory || 'Target'}: ${listing.targetName}]` : '';
    const savings = (listing.targetMaxPrice && listing.targetMaxPrice > listing.totalPrice)
        ? (listing.targetMaxPrice - listing.totalPrice)
        : 0;
    const discountPct = listing.targetMaxPrice ? Math.round((savings / listing.targetMaxPrice) * 100) : 0;
    const priceSavings = savings > 0
        ? ` (Save $${savings.toFixed(2)} / ${discountPct}% off)`
        : '';

    // High priority check
    const isHighPriority = (listing.targetUrgentPrice && listing.totalPrice <= listing.targetUrgentPrice)
        || discountPct >= 15
        || savings >= 75;
    const pingTag = config.pingTag || '@everyone';
    
    // Message content
    const messageContent = isHighPriority
        ? `${pingTag} **HIGH PRIORITY DEAL DETECTED!** \`${listing.targetName || 'Item'}\` is **$${savings.toFixed(2)} below target** (${discountPct}% OFF)!`
        : `**New Listing Found:** \`${listing.targetName || 'Item'}\` available for **$${listing.totalPrice.toFixed(2)}**`;

    const fields = [
        {
            name: 'Target',
            value: listing.targetName ? `**${listing.targetName}** (${listing.targetCategory || 'General'})` : 'General Deal',
            inline: true,
        },
        {
            name: 'Total Price',
            value: `**$${listing.totalPrice.toFixed(2)}**${priceSavings}`,
            inline: true,
        },
        {
            name: 'Condition',
            value: listing.condition || 'Used',
            inline: true,
        },
        {
            name: 'Item Price',
            value: `$${listing.price.toFixed(2)}`,
            inline: true,
        },
        {
            name: 'Shipping',
            value: listing.shippingCost === 0 ? 'FREE' : `$${listing.shippingCost.toFixed(2)}`,
            inline: true,
        },
        {
            name: 'Link',
            value: `[View on eBay](${listing.url})`,
            inline: true,
        },
    ];

    const embedTitle = isHighPriority
        ? `[HIGH PRIORITY] ${targetBadge} Deal: ${listing.title.substring(0, 35)}...`
        : `${targetBadge} Deal: ${listing.title.substring(0, 35)}...`;

    const embedDesc = isHighPriority
        ? `**${listing.title}**\n**High Priority Steal: Save $${savings.toFixed(2)} (${discountPct}% OFF)**`
        : `**${listing.title}**`;

    const embed = {
        title: embedTitle,
        description: embedDesc,
        url: listing.url,
        color: getPriceColor(listing.totalPrice, discountPct),
        fields,
        thumbnail: listing.image ? { url: listing.image } : undefined,
        footer: {
            text: `${projName} • Item #${listing.itemId}`,
        },
        timestamp: listing.foundAt,
    };

    const payload = {
        username: `${projName}`,
        avatar_url: 'https://cdn-icons-png.flaticon.com/512/2103/2103832.png',
        content: messageContent,
        embeds: [embed],
    };

    try {
        await axios.post(webhookUrl, payload);
        console.log(`[Discord] [OK] Alert sent for: ${listing.title.substring(0, 50)}... ${isHighPriority ? '(HIGH PRIORITY PING)' : '(NORMAL MESSAGE)'}`);
    } catch (error) {
        console.error(`[Discord] [ERROR] Failed to send alert: ${error.message}`);
        if (error.response) {
            console.error(`[Discord] Status: ${error.response.status}, Data:`, error.response.data);
        }
    }
}

// Send batch alerts
async function sendListingAlerts(webhookUrl, listings, config = {}) {
    for (let i = 0; i < listings.length; i++) {
        await sendListingAlert(webhookUrl, listings[i], config);

        // Rate limit delay
        if (i < listings.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
}

// Startup notification
async function sendStartupNotification(webhookUrl, config = {}) {
    const projName = config.projectName || 'Deal Hunter';
    const fields = [
        {
            name: 'Scan Mode',
            value: config.query ? `\`${config.query}\`` : 'Multi-Target Active Targets',
            inline: true,
        },
        {
            name: 'Scan Interval',
            value: `Every ${config.intervalMinutes || 10} minutes`,
            inline: true,
        },
    ];

    if (config.maxPrice && config.query) {
        fields.push({
            name: 'Max Price',
            value: `$${config.maxPrice}`,
            inline: true,
        });
    }

    const embed = {
        title: `${projName} Started`,
        description: `The scraper is now live and monitoring for high-value deals.`,
        color: 0x3498db,
        fields,
        footer: {
            text: projName,
        },
        timestamp: new Date().toISOString(),
    };

    try {
        await axios.post(webhookUrl, {
            username: `${projName}`,
            avatar_url: 'https://cdn-icons-png.flaticon.com/512/2103/2103832.png',
            embeds: [embed],
        });
        console.log('[Discord] [OK] Startup notification sent.');
    } catch (error) {
        console.error(`[Discord] [ERROR] Failed to send startup notification: ${error.message}`);
    }
}

// Scan summary
async function sendScanSummary(webhookUrl, totalFound, newFound, nextScanTime) {
    const embed = {
        title: newFound > 0 ? 'Scan Complete — New Deals Found!' : 'Scan Complete — No New Deals',
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
            username: 'Deal Bot',
            avatar_url: 'https://cdn-icons-png.flaticon.com/512/2103/2103832.png',
            embeds: [embed],
        });
    } catch (error) {
        console.error(`[Discord] [ERROR] Failed to send scan summary: ${error.message}`);
    }
}

// Error notification
async function sendErrorNotification(webhookUrl, errorMessage, config = {}) {
    const projName = config.projectName || 'Deal Hunter';
    try {
        await axios.post(webhookUrl, {
            username: `${projName}`,
            avatar_url: 'https://cdn-icons-png.flaticon.com/512/2103/2103832.png',
            embeds: [{
                title: 'Scraper Error',
                description: `\`\`\`${errorMessage}\`\`\``,
                color: 0xe74c3c,
                timestamp: new Date().toISOString(),
                footer: { text: projName },
            }],
        });
    } catch (err) {
        console.error('[Discord] [ERROR] Failed to send error notification:', err.message);
    }
}

module.exports = {
    sendListingAlert,
    sendListingAlerts,
    sendStartupNotification,
    sendScanSummary,
    sendErrorNotification,
};
