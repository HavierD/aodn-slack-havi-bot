/**
 * Shared Slack utility functions.
 *
 * Required bot token scopes:  chat:write
 * Required user token scopes: users.profile:write  (per-user, stored in DynamoDB)
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddbSend } from './dynamo-utils.mjs';

const SLACK_BOT_TOKEN  = process.env.SLACK_BOT_TOKEN;
const USER_TOKEN_TABLE = process.env.USER_TOKEN_TABLE;

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Call a Slack Web API method via POST JSON.
 * @param {string} method   e.g. "users.profile.set"
 * @param {object} body     JSON payload
 * @param {string} token    Bearer token to use
 * @returns {object}        Parsed Slack response
 * @throws {Error}          If Slack returns ok: false
 */
async function callSlackApi(method, body, token) {
    const response = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Authorization': `Bearer ${token}`
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
// Per-user token lookup
// ---------------------------------------------------------------------------

/**
 * Fetch the stored user token (xoxp-) for a given userId from DynamoDB.
 * Returns null if not found or if USER_TOKEN_TABLE is not configured.
 */
export async function getUserToken(userId) {
    if (!USER_TOKEN_TABLE || !userId) return null;
    try {
        const { Item } = await ddbSend(new GetCommand({
            TableName: USER_TOKEN_TABLE,
            Key: { userId }
        }));
        return Item?.userToken || null;
    } catch (err) {
        console.error('Failed to fetch user token for', userId, err.message);
        return null;
    }
}

// ---------------------------------------------------------------------------
// 1. Set a Slack user's status
// ---------------------------------------------------------------------------

/**
 * Set the Slack status for a given user.
 *
 * Automatically uses the stored user token (xoxp-) from DynamoDB if available,
 * otherwise falls back to the bot token (requires admin-level workspace access).
 *
 * @param {string} userId               Slack user ID (e.g. "U12345678")
 * @param {string} statusText           Status text (max 100 chars)
 * @param {string} [statusEmoji]        Slack emoji string, e.g. ":house:"
 * @param {number} [statusExpiration]   Unix timestamp (seconds); 0 = never
 * @returns {object}  Slack API response
 */
export async function setUserSlackStatus(userId, statusText, statusEmoji = '', statusExpiration = 0) {
    if (!userId)     throw new Error('setUserSlackStatus: userId is required');
    if (!statusText) throw new Error('setUserSlackStatus: statusText is required');

    const userToken = await getUserToken(userId);
    const token = userToken || SLACK_BOT_TOKEN;

    if (!userToken) {
        console.warn(`No user token found for userId=${userId}, falling back to bot token`);
    }

    console.info('Setting Slack status', { userId, statusText, statusEmoji, statusExpiration, usingUserToken: !!userToken });

    const result = await callSlackApi('users.profile.set', {
        user: userId,
        profile: {
            status_text:       statusText.substring(0, 100),
            status_emoji:      statusEmoji,
            status_expiration: statusExpiration
        }
    }, token);

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

    const userToken = await getUserToken(userId);
    const token = userToken || SLACK_BOT_TOKEN;

    console.info('Clearing Slack status', { userId, usingUserToken: !!userToken });

    const result = await callSlackApi('users.profile.set', {
        user: userId,
        profile: {
            status_text:       '',
            status_emoji:      '',
            status_expiration: 0
        }
    }, token);

    console.info('Slack status cleared successfully', { userId });
    return result;
}

// ---------------------------------------------------------------------------
// 3. Get a user's display name
// ---------------------------------------------------------------------------

/**
 * Fetch the display name for a given Slack user ID via users.info.
 * Falls back to the userId string if the call fails or display_name is empty.
 *
 * @param {string} userId  Slack user ID (e.g. "U12345678")
 * @returns {string}       profile.display_name or userId as fallback
 */
export async function getUserDisplayName(userId) {
    if (!userId) return userId;
    try {
        const result = await callSlackApi('users.info', { user: userId }, SLACK_BOT_TOKEN);
        return result.user?.profile?.display_name || userId;
    } catch (err) {
        console.warn(`Failed to fetch display name for userId=${userId}:`, err.message);
        return userId;
    }
}

// ---------------------------------------------------------------------------
// 2. Send a message to a Slack channel
// ---------------------------------------------------------------------------

/**
 * Send a plain-text or Block Kit message to a Slack channel.
 * Always uses the bot token (chat:write scope).
 *
 * @param {string}        channel   Channel ID or name, e.g. "#general"
 * @param {string}        text      Fallback plain text
 * @param {object}        [options] Optional extra fields (blocks, username, iconEmoji, threadTs, unfurlLinks)
 * @returns {object}  Slack API response
 */
export async function sendSlackMessage(channel, text, options = {}) {
    if (!channel) throw new Error('sendSlackMessage: channel is required');
    if (!text)    throw new Error('sendSlackMessage: text is required');

    console.info('Sending Slack message', { channel, textPreview: text.substring(0, 80) });

    const payload = { channel, text };

    if (options.blocks)      payload.blocks     = options.blocks;
    if (options.username)    payload.username   = options.username;
    if (options.iconEmoji)   payload.icon_emoji = options.iconEmoji;
    if (options.threadTs)    payload.thread_ts  = options.threadTs;
    if (options.unfurlLinks !== undefined) payload.unfurl_links = options.unfurlLinks;

    const result = await callSlackApi('chat.postMessage', payload, SLACK_BOT_TOKEN);

    console.info('Slack message sent successfully', { channel, ts: result.ts });
    return result;
}
