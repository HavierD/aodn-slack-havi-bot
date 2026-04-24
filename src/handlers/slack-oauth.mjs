/**
 * Handles Slack OAuth 2.0 callback.
 * GET /slack/oauth/callback?code=...
 *
 * Exchanges the authorization code for a user token (xoxp-) and stores it
 * in DynamoDB keyed by userId. The token is then used by process-schedule
 * to set each user's Slack status without needing admin privileges.
 */
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddbSend } from '../lib/dynamo-utils.mjs';

const SLACK_CLIENT_ID     = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const USER_TOKEN_TABLE    = process.env.USER_TOKEN_TABLE;
const OAUTH_REDIRECT_URI  = process.env.OAUTH_REDIRECT_URI;

export const slackOAuthHandler = async (event) => {
    const qs    = event.queryStringParameters || {};
    const code  = qs.code;
    const error = qs.error;

    if (error) {
        console.warn('OAuth denied by user:', error);
        return htmlResponse('❌ Authorization cancelled. You can close this tab and try again from the Havi Bot app in Slack.');
    }

    if (!code) {
        return { statusCode: 400, body: 'Missing code parameter' };
    }

    // Exchange the short-lived code for a user access token
    const params = new URLSearchParams({
        client_id:     SLACK_CLIENT_ID,
        client_secret: SLACK_CLIENT_SECRET,
        code,
        redirect_uri:  OAUTH_REDIRECT_URI
    });

    let data;
    try {
        const res = await fetch('https://slack.com/api/oauth.v2.access', {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body:    params.toString()
        });
        data = await res.json();
    } catch (err) {
        console.error('Network error during OAuth exchange:', err);
        return htmlResponse('❌ Authorization failed due to a network error. Please try again.');
    }

    if (!data.ok) {
        console.error('OAuth exchange failed:', data.error);
        return htmlResponse('❌ Authorization failed. Please try again from the Havi Bot app in Slack.');
    }

    // data.authed_user contains the user token (xoxp-)
    const userId    = data.authed_user?.id;
    const userToken = data.authed_user?.access_token;

    if (!userId || !userToken) {
        console.error('Missing userId or userToken in OAuth response', JSON.stringify(data));
        return htmlResponse('❌ Authorization failed: missing user token. Please try again.');
    }

    // Persist the user token in DynamoDB
    try {
        await ddbSend(new PutCommand({
            TableName: USER_TOKEN_TABLE,
            Item: {
                userId,
                userToken,
                authorizedAt: new Date().toISOString()
            }
        }));
        console.info(`Stored user token for userId=${userId}`);
    } catch (err) {
        console.error('Failed to store user token:', err);
        return htmlResponse('❌ Authorization failed: could not save your token. Please try again.');
    }

    return htmlResponse('✅ Authorization successful! You can close this tab and return to Slack.<br><br>The Havi Bot will now manage your Slack status automatically.');
};

function htmlResponse(message) {
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Havi Bot</title></head>
<body style="font-family:sans-serif;text-align:center;padding:60px;font-size:1.2em;color:#333">
  <p>${message}</p>
</body>
</html>`
    };
}

