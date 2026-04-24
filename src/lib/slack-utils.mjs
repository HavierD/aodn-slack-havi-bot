/**
 * Shared Slack utility functions.
 * Can be imported by any Lambda handler in this project.
 *
 * Required bot token scopes:
 *   - users.profile:write  (to set another user's status)
 *   - chat:write           (to post messages to channels)
 */

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Call a Slack Web API method via POST JSON.
 * @param {string} method   e.g. "users.profile.set"
 * @param {object} body     JSON payload
 * @returns {object}        Parsed Slack response
 * @throws {Error}          If Slack returns ok: false
 */
async function callSlackApi(method, body) {
    const response = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
        },
        body: JSON.stringify(body)
    });

    const result = await response.json();

    if (!result.ok) {
        const messages = result.response_metadata?.messages
            ? ` | details: ${JSON.stringify(result.response_metadata.messages)}`
            : '';
        throw new Error(`Slack API error [${method}]: ${result.error}${messages}`);
    }

    return result;
}

// ---------------------------------------------------------------------------
// 1. Set a Slack user's status
// ---------------------------------------------------------------------------

/**
 * Set the Slack status for a given user.
 *
 * @param {string} userId               Slack user ID (e.g. "U12345678")
 * @param {string} statusText           Status text (max 100 chars), e.g. "Working remotely"
 * @param {string} [statusEmoji]        Slack emoji string, e.g. ":house:"  (optional)
 * @param {number} [statusExpiration]   Unix timestamp (seconds) when status clears; 0 = never (optional)
 *
 * @returns {object}  Slack API response
 *
 * Required scope: users.profile:write
 *
 * Note: Setting another user's status via a bot token requires the bot token to have
 * admin-level access OR the user must have explicitly granted access.
 * For workspace-internal bots with users.profile:write this works directly.
 */
export async function setUserSlackStatus(userId, statusText, statusEmoji = '', statusExpiration = 0) {
    if (!userId)   throw new Error('setUserSlackStatus: userId is required');
    if (!statusText) throw new Error('setUserSlackStatus: statusText is required');

    console.info('Setting Slack status', { userId, statusText, statusEmoji, statusExpiration });

    const result = await callSlackApi('users.profile.set', {
        user: userId,
        profile: {
            status_text:       statusText.substring(0, 100),
            status_emoji:      statusEmoji,
            status_expiration: statusExpiration
        }
    });

    console.info('Slack status set successfully', { userId });
    return result;
}

/**
 * Clear the Slack status for a given user.
 *
 * @param {string} userId  Slack user ID
 * @returns {object}  Slack API response
 */
export async function clearUserSlackStatus(userId) {
    if (!userId) throw new Error('clearUserSlackStatus: userId is required');

    console.info('Clearing Slack status', { userId });

    const result = await callSlackApi('users.profile.set', {
        user: userId,
        profile: {
            status_text:       '',
            status_emoji:      '',
            status_expiration: 0
        }
    });

    console.info('Slack status cleared successfully', { userId });
    return result;
}

// ---------------------------------------------------------------------------
// 2. Send a message to a Slack channel
// ---------------------------------------------------------------------------

/**
 * Send a plain-text or Block Kit message to a Slack channel.
 *
 * @param {string}        channel   Channel ID or name, e.g. "C0123456789" or "#general"
 * @param {string}        text      Fallback plain text (always required even when using blocks)
 * @param {object}        [options] Optional extra fields:
 *   @param {Array}       [options.blocks]    Block Kit blocks (overrides plain-text rendering)
 *   @param {string}      [options.username]  Override bot display name
 *   @param {string}      [options.iconEmoji] Override bot icon emoji
 *   @param {string}      [options.threadTs]  Reply in a thread (parent message timestamp)
 *   @param {boolean}     [options.unfurlLinks]  Whether to unfurl links (default Slack behaviour)
 *
 * @returns {object}  Slack API response (includes ts, channel)
 *
 * Required scope: chat:write  (and chat:write.public to post to channels the bot hasn't joined)
 */
export async function sendSlackMessage(channel, text, options = {}) {
    if (!channel) throw new Error('sendSlackMessage: channel is required');
    if (!text)    throw new Error('sendSlackMessage: text is required');

    console.info('Sending Slack message', { channel, textPreview: text.substring(0, 80) });

    const payload = {
        channel,
        text
    };

    if (options.blocks)      payload.blocks     = options.blocks;
    if (options.username)    payload.username   = options.username;
    if (options.iconEmoji)   payload.icon_emoji = options.iconEmoji;
    if (options.threadTs)    payload.thread_ts  = options.threadTs;
    if (options.unfurlLinks !== undefined) payload.unfurl_links = options.unfurlLinks;

    const result = await callSlackApi('chat.postMessage', payload);

    console.info('Slack message sent successfully', { channel, ts: result.ts });
    return result;
}

