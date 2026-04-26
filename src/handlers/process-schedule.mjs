import { QueryCommand, ScanCommand, GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddbSend } from '../lib/dynamo-utils.mjs';
import { setUserSlackStatus, sendSlackMessage, getUserDisplayName } from '../lib/slack-utils.mjs';

const tableName = process.env.SAMPLE_TABLE;
const NOTIFICATION_CHANNEL = process.env.NOTIFICATION_CHANNEL || 'C0AUN44711B';

// Timezone for all date/time operations (Australia/Sydney and Australia/Hobart
// share the same UTC offset / DST rules — AEST UTC+10 / AEDT UTC+11)
const TZ = 'Australia/Sydney';

// Map statusType values → Slack display text + emoji
const STATUS_CONFIG = {
    working_remotely: { text: 'Working remotely', emoji: ':house_with_garden:' },
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
 * Build the human-friendly notification text for a status event.
 *
 * Working remotely / Out sick:
 *   - Default:              "<name> is WFH today"  /  "<name> is off sick today"
 *   - Start after 10:00:   "…from <startTime>"
 *   - End before 16:00:    "…until <endTime>"
 *   - Both conditions:     "…from <startTime> until <endTime>"
 *
 * Vacationing:
 *   - Different dates:     "<name> is on leave from <startDate> to <endDate>"
 *   - Same day / recurring: "<name> is on leave today"
 */
function buildNotificationText(displayName, statusType, startDate, startTime, endDate, endTime) {
    const name = `*${displayName}*`;

    if (statusType === 'working_remotely' || statusType === 'out_sick') {
        const label     = statusType === 'working_remotely' ? 'WFH' : 'off sick';
        const startLate = startTime && startTime > '10:00';
        const endEarly  = endTime   && endTime   < '16:00';

        if (startLate && endEarly) return `${name} is ${label} from ${startTime} until ${endTime}`;
        if (startLate)             return `${name} is ${label} from ${startTime}`;
        if (endEarly)              return `${name} is ${label} until ${endTime}`;
        return `${name} is ${label} today`;
    }

    if (statusType === 'vacationing') {
        if (startDate && endDate && startDate !== endDate) {
            return `${name} is on leave from ${startDate} to ${endDate}`;
        }
        return `${name} is on leave today`;
    }

    // Fallback for any future / unknown status types
    const cfg     = STATUS_CONFIG[statusType] ?? { text: statusType ?? 'Away', emoji: '' };
    const endPart = (endDate || endTime) ? ` — until ${[endDate, endTime].filter(Boolean).join(' ')}` : '';
    return `${name} ${cfg.text} ${cfg.emoji}${endPart}`.trim();
}

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
    // Format date and time in the configured timezone (Sydney/Hobart), not UTC
    const date = rounded.toLocaleDateString('en-CA', { timeZone: TZ }); // → YYYY-MM-DD
    const time = rounded.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }); // → HH:MM
    return { date, time };
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
    // dateStr/timeStr are stored as Sydney/Hobart local time — convert to UTC correctly.
    // Treat the string as UTC first (probeUtc) so we can ask Intl what Sydney's
    // wall-clock looks like at that instant, then compute the real UTC offset.
    const probeUtc = new Date(`${dateStr}T${timeStr}:00Z`);
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).formatToParts(probeUtc);
    const get = type => parseInt(parts.find(p => p.type === type).value, 10);
    // "Sydney local time" expressed as a UTC epoch value (for offset arithmetic)
    const sydneyAsUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    // offsetMs: positive means Sydney is ahead of UTC (e.g. AEST = +10 h → offsetMs = -10 h in ms)
    const offsetMs = probeUtc.getTime() - sydneyAsUtcMs;
    return Math.floor((probeUtc.getTime() + offsetMs) / 1000);
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
    // Use a locale-string trick to read weekday/hour/minute in the configured timezone
    const tzDate = new Date(roundedNow.toLocaleString('en-US', { timeZone: TZ }));
    console.info('Rounded date/time', { date, time, weekday: tzDate.getDay() });

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
                if (item.sendMessage) {
                    try {
                        /** @type {string} */
                        const displayName = await getUserDisplayName(item.userId);
                        const text = buildNotificationText(
                            displayName, item.statusType,
                            item.startDate, item.startTime,
                            item.endDate,   item.endTime
                        );
                        await sendSlackMessage(NOTIFICATION_CHANNEL, text);
                        console.info(`Notification sent to ${NOTIFICATION_CHANNEL} for user ${item.userId}: ${text}`);
                    } catch (err) {
                        console.error(`Failed to send notification to channel ${NOTIFICATION_CHANNEL} for user ${item.userId}:`, err.message);
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
        const isMonday0800 = tzDate.getDay() === 1 && tzDate.getHours() === 8 && tzDate.getMinutes() === 0;
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
