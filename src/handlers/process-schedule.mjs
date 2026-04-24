import { QueryCommand, ScanCommand, GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddbSend } from '../lib/dynamo-utils.mjs';
import { setUserSlackStatus, sendSlackMessage, getUserDisplayName } from '../lib/slack-utils.mjs';

const tableName = process.env.SAMPLE_TABLE;
const NOTIFICATION_CHANNEL = process.env.NOTIFICATION_CHANNEL || '#havier-test-channel';

// Map statusType values → Slack display text + emoji
const STATUS_CONFIG = {
    working_remotely: { text: 'Working remotely', emoji: ':house:' },
    vacationing:      { text: 'Vacationing',       emoji: ':palm_tree:' },
    out_sick:         { text: 'Out sick',           emoji: ':face_with_thermometer:' }
};

// Map recurrenceInterval values → number of days to advance
const INTERVAL_DAYS = {
    every_week:    7,
    every_2_weeks: 14,
    every_3_weeks: 21,
    every_4_weeks: 28
};

// removed artificial sleeps to speed up processing

/**
 * Round the current time to the nearest 30-minute slot.
 *   10:21 → 10:30   (diff to :30 = 9, diff to :00 = 21 → closer to :30)
 *   10:09 → 10:00   (diff to :00 = 9, diff to :30 = 21 → closer to :00)
 *   10:47 → 11:00
 * Returns { date: 'YYYY-MM-DD', time: 'HH:MM' }
 */
function getRoundedDateTime() {
    const slotMs = 30 * 60 * 1000; // 30 minutes in milliseconds
    const rounded = new Date(Math.round(Date.now() / slotMs) * slotMs);
    const date = rounded.toLocaleDateString('en-CA'); // → YYYY-MM-DD
    const hh = String(rounded.getHours()).padStart(2, '0');
    const mm = String(rounded.getMinutes()).padStart(2, '0');
    return { date, time: `${hh}:${mm}` };
}

/**
 * Add `days` to a 'YYYY-MM-DD' string and return the new 'YYYY-MM-DD' string.
 */
function addDaysToDateStr(dateStr, days) {
    const d = new Date(`${dateStr}T00:00:00`);
    d.setDate(d.getDate() + days);
    return d.toLocaleDateString('en-CA');
}

/**
 * Convert a date string ('YYYY-MM-DD') + time string ('HH:MM') to a Unix
 * timestamp in seconds (for Slack status_expiration). Returns 0 if missing.
 */
function toUnixTimestamp(dateStr, timeStr) {
    if (!dateStr || !timeStr) return 0;
    return Math.floor(new Date(`${dateStr}T${timeStr}:00`).getTime() / 1000);
}

/**
 * Query a GSI with an exact match on both partition key and sort key.
 * Handles pagination automatically.
 */
async function queryByIndex(indexName, pkName, skName, pkValue, skValue) {
    const items = [];
    let ExclusiveStartKey;
    do {
        const res = await ddbSend(new QueryCommand({
            TableName: tableName,
            IndexName: indexName,
            KeyConditionExpression: `${pkName} = :pk AND ${skName} = :sk`,
            ExpressionAttributeValues: { ':pk': pkValue, ':sk': skValue },
            ExclusiveStartKey
        }));
        if (res.Items) items.push(...res.Items);
        ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
}

/**
 * Scan the table for items whose endDate/endTime are earlier than or equal
 * to the supplied date/time. Handles pagination via ExclusiveStartKey.
 */
async function scanEndingEarlier(dateStr, timeStr) {
    const items = [];
    let ExclusiveStartKey;
    const filter = 'endDate < :date OR (endDate = :date AND endTime <= :time)';
    const exprAttrValues = { ':date': dateStr, ':time': timeStr };
    do {
        const res = await ddbSend(new ScanCommand({
            TableName: tableName,
            FilterExpression: filter,
            ExpressionAttributeValues: exprAttrValues,
            ExclusiveStartKey
        }));
        if (res.Items) items.push(...res.Items);
        ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
}

export const processScheduleHandler = async (event) => {
    console.info('processScheduleHandler invoked');

    const { date, time } = getRoundedDateTime();
    // Also compute the rounded Date object to inspect weekday/hour for special Monday 08:00 behaviour
    const slotMs = 30 * 60 * 1000;
    const roundedNow = new Date(Math.round(Date.now() / slotMs) * slotMs);
    console.info('Rounded date/time', { date, time, weekday: roundedNow.getDay() });

    try {
        // ── 1. START events ───────────────────────────────────────────────
        // Query items whose startDate + startTime match the rounded slot.
        // For each matching item, set the user's Slack status with an
        // expiration derived from endDate + endTime.
        console.info('Querying StartDateStartTimeIndex', { date, time });
        const startIndexItems = await queryByIndex(
            'StartDateStartTimeIndex', 'startDate', 'startTime', date, time
        );
        console.info(`Found ${startIndexItems.length} start-time item(s)`);

        for (const indexItem of startIndexItems) {
            const id = indexItem.id;
            if (!id) {
                console.warn('Start index item missing id, skipping', indexItem);
                continue;
            }

            const { Item: item } = await ddbSend(
                new GetCommand({ TableName: tableName, Key: { id } })
            );
            if (!item) {
                console.warn('Item not found in table for id:', id);
                continue;
            }
            console.info('Processing start event:', JSON.stringify(item, null, 2));

            // Resolve status text + emoji
            const cfg = STATUS_CONFIG[item.statusType]
                ?? { text: item.statusType ?? 'Away', emoji: '' };
            const expiration = toUnixTimestamp(item.endDate, item.endTime);

            try {
                await setUserSlackStatus(item.userId, cfg.text, cfg.emoji, expiration);
                console.info(`Slack status set for user ${item.userId}: "${cfg.text}", expires ${expiration}`);
                // Optionally send a notification to the configured channel when the event starts
                if (item.sendMessage) {
                    try {
                        const displayName = await getUserDisplayName(item.userId);
                        const endPart = (item.endDate || item.endTime) ? ` — until ${item.endDate || ''} ${item.endTime || ''}`.trim() : '';
                        const text = `*${displayName}* ${cfg.text} ${cfg.emoji}${endPart}`.trim();
                        await sendSlackMessage(NOTIFICATION_CHANNEL, text);
                        console.info(`Notification sent to ${NOTIFICATION_CHANNEL} for user ${item.userId}`);
                    } catch (err) {
                        console.error(`Failed to send notification for user ${item.userId}:`, err.message);
                    }
                }
            } catch (err) {
                console.error(`Failed to set Slack status for user ${item.userId}:`, err.message);
            }
        }

        // ── 2. END events ─────────────────────────────────────────────────
        // If this is Monday 08:00 (rounded), scan for any events that ended
        // earlier than or equal to the current slot and process them. This
        // catches missed events over the weekend/earlier windows.
        // Otherwise, query the EndDateEndTimeIndex for exact matches.
        console.info('Processing end events', { date, time });
        const isMonday0800 = roundedNow.getDay() === 1 && roundedNow.getHours() === 8 && roundedNow.getMinutes() === 0;
        let endIndexItems;
        if (isMonday0800) {
            console.info('Monday 08:00 detected — scanning for events ended earlier than or equal to now');
            endIndexItems = await scanEndingEarlier(date, time);
            console.info(`Found ${endIndexItems.length} end-time item(s) (ended <= current slot)`);
        } else {
            console.info('Querying EndDateEndTimeIndex for exact matches', { date, time });
            endIndexItems = await queryByIndex(
                'EndDateEndTimeIndex', 'endDate', 'endTime', date, time
            );
            console.info(`Found ${endIndexItems.length} end-time item(s)`);
        }

        for (const indexItem of endIndexItems) {
            const id = indexItem.id;
            if (!id) {
                console.warn('End index item missing id, skipping', indexItem);
                continue;
            }

            const { Item: item } = await ddbSend(
                new GetCommand({ TableName: tableName, Key: { id } })
            );
            if (!item) {
                console.warn('Item not found in table for id:', id);
                continue;
            }
            console.info('Processing end event:', JSON.stringify(item, null, 2));

            if (!item.isRecurring) {
                // One-time event: remove it entirely
                await ddbSend(
                    new DeleteCommand({ TableName: tableName, Key: { id } })
                );
                console.info(`Deleted one-time event id=${id}`);
            } else {
                // Recurring event: roll startDate / endDate forward by interval
                const days = INTERVAL_DAYS[item.recurrenceInterval];
                if (!days) {
                    console.warn(
                        `Unknown recurrenceInterval "${item.recurrenceInterval}" for id=${id}, skipping`
                    );
                } else {
                    const newStartDate = addDaysToDateStr(item.startDate, days);
                    const newEndDate   = addDaysToDateStr(item.endDate,   days);

                    await ddbSend(new UpdateCommand({
                        TableName: tableName,
                        Key: { id },
                        UpdateExpression: 'SET startDate = :sd, endDate = :ed, updatedAt = :ua',
                        ExpressionAttributeValues: {
                            ':sd': newStartDate,
                            ':ed': newEndDate,
                            ':ua': new Date().toISOString()
                        }
                    }));
                    console.info(
                        `Advanced recurring event id=${id}:`,
                        `startDate ${item.startDate} → ${newStartDate},`,
                        `endDate ${item.endDate} → ${newEndDate}`
                    );
                }
            }
        }

        console.info('processScheduleHandler completed');
        return { statusCode: 200, body: 'Done' };

    } catch (err) {
        console.error('Error in processScheduleHandler:', err);
        return { statusCode: 500, body: String(err) };
    }
};
