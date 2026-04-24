/**
 * Shared DynamoDB utilities.
 *
 * Exports:
 *   ddbDocClient  – pre-configured DynamoDBDocumentClient (SDK built-in retries = 8)
 *   ddbSend(cmd)  – wrapper with application-level exponential back-off on top of
 *                   the SDK's built-in retry, for extra resilience on low-throughput
 *                   tables (1 RCU/WCU).
 *
 * Retried error codes:
 *   ProvisionedThroughputExceededException
 *   RequestLimitExceeded
 *   ThrottlingException
 *   TransactionConflictException
 *   HTTP 429 / 5xx
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// SDK-level retry (handles most throttles automatically)
const baseClient = new DynamoDBClient({ maxAttempts: 8 });
export const ddbDocClient = DynamoDBDocumentClient.from(baseClient);

// Error codes that warrant an application-level retry
const THROTTLE_CODES = new Set([
    'ProvisionedThroughputExceededException',
    'RequestLimitExceeded',
    'ThrottlingException',
    'TransactionConflictException',
]);

const BASE_DELAY_MS  = 100;   // starting back-off delay
const MAX_DELAY_MS   = 15_000; // cap at 15 s
const MAX_APP_RETRIES = 6;     // application-level retry attempts (on top of SDK)

/**
 * Send a DynamoDBDocumentClient command with exponential back-off.
 *
 * @param {object} command  Any @aws-sdk/lib-dynamodb command instance
 * @returns {Promise<any>}  The DynamoDB response
 */
export async function ddbSend(command) {
    let lastError;

    for (let attempt = 0; attempt <= MAX_APP_RETRIES; attempt++) {
        try {
            return await ddbDocClient.send(command);
        } catch (err) {
            const code = err.name || err.code || err.__type || '';
            const status = err.$metadata?.httpStatusCode ?? 0;
            const isRetryable = THROTTLE_CODES.has(code)
                || status === 429
                || status >= 500;

            if (!isRetryable || attempt === MAX_APP_RETRIES) {
                throw err;
            }

            // Full jitter exponential back-off
            const ceiling = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
            const delay = Math.random() * ceiling;
            console.warn(
                `[ddbSend] throttle/transient error "${code}" (HTTP ${status}),`
                + ` attempt ${attempt + 1}/${MAX_APP_RETRIES},`
                + ` retrying in ${Math.round(delay)} ms`
            );
            await new Promise(r => setTimeout(r, delay));
            lastError = err;
        }
    }

    throw lastError; // unreachable but satisfies lint
}

