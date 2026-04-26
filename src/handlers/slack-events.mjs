// Slack Events API handler for app_home_opened event and interactivity

import { ScanCommand, QueryCommand, PutCommand, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddbSend } from '../lib/dynamo-utils.mjs';
import { getUserToken } from '../lib/slack-utils.mjs';

const SLACK_BOT_TOKEN   = process.env.SLACK_BOT_TOKEN;
const SLACK_CLIENT_ID   = process.env.SLACK_CLIENT_ID;
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI;
const tableName = process.env.SAMPLE_TABLE;

// Validate token on module load
if (!SLACK_BOT_TOKEN) {
    console.error("WARNING: SLACK_BOT_TOKEN environment variable is not set!");
} else if (!SLACK_BOT_TOKEN.startsWith('xoxb-')) {
    console.error("WARNING: SLACK_BOT_TOKEN should start with 'xoxb-' for bot tokens");
} else {
    console.info(`SLACK_BOT_TOKEN is set (length: ${SLACK_BOT_TOKEN.length}, prefix: ${SLACK_BOT_TOKEN.substring(0, 10)}...)`);
}
if (!SLACK_CLIENT_ID)    console.error("WARNING: SLACK_CLIENT_ID is not set — OAuth Connect button will not work!");
if (!OAUTH_REDIRECT_URI) console.error("WARNING: OAUTH_REDIRECT_URI is not set — OAuth Connect button will not work!");

// Status type options
const STATUS_TYPES = [
    { text: "Working remotely", value: "working_remotely" },
    { text: "Vacationing", value: "vacationing" },
    { text: "Out sick", value: "out_sick" }
];

// Recurrence options
const RECURRENCE_OPTIONS = [
    { text: "Every week", value: "every_week", weeks: 1 },
    { text: "Every 2 weeks", value: "every_2_weeks", weeks: 2 },
    { text: "Every 3 weeks", value: "every_3_weeks", weeks: 3 },
    { text: "Every 4 weeks", value: "every_4_weeks", weeks: 4 },
];

// Notification channel — prefer env var (channel ID is most reliable)
const NOTIFICATION_CHANNEL_NAME = "havier-test-channel";

// Timezone for display/comparison (same as process-schedule)
const TZ = 'Australia/Sydney';

/**
 * Compute the dynamic notification checkbox label for a one-time event.
 * - If all four date/time values are provided and the current Sydney time is
 *   within [startDate startTime, endDate endTime] → "…now"
 * - Otherwise → "…at <startDate> <startTime>"
 * - If any value is missing → plain "Send notification to <channel>"
 */
function getNotificationCheckboxText(startDate, startTime, endDate, endTime) {
    const base = `Send notification to ${NOTIFICATION_CHANNEL_NAME}`;
    if (!startDate || !startTime || !endDate || !endTime) return base;

    const now      = new Date();
    const nowDate  = now.toLocaleDateString('en-CA', { timeZone: TZ });
    const nowTime  = now.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
    const nowStr   = `${nowDate} ${nowTime}`;
    const startStr = `${startDate} ${startTime}`;
    const endStr   = `${endDate} ${endTime}`;

    if (nowStr >= startStr && nowStr <= endStr) {
        return `${base} now`;
    }
    return `${base} at ${startDate} ${startTime}`;
}

/**
 * Compute the dynamic notification checkbox label for a recurring event.
 * Shows the start time once it has been selected.
 */
function getRecurringNotificationCheckboxText(startTime) {
    const base = `Send notification to ${NOTIFICATION_CHANNEL_NAME}`;
    if (!startTime) return base;
    return `${base} on every recurring day at ${startTime}`;
}

/**
 * Calculate next N occurrence dates from a base date given interval in weeks
 */
function getNextDates(weeksInterval, count = 4, fromDateStr = null) {
    // Return formatted dates with day-of-week: YYYY-MM-DD (Mon)
    const base = fromDateStr ? new Date(`${fromDateStr}T00:00:00`) : new Date();
    base.setHours(0, 0, 0, 0);
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dates = [];
    for (let i = 1; i <= count; i++) {
        const d = new Date(base);
        d.setDate(d.getDate() + i * weeksInterval * 7);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const day = dayNames[d.getDay()];
        dates.push(`${y}-${m}-${dd} (${day})`);
    }
    return dates;
}

/**
 * Fetch all scheduled events from DynamoDB for a user
 */
async function getScheduledEvents(userId) {
    try {
        // Try to use the UserIdStartDateIndex GSI for efficient query by userId
        const queryParams = {
            TableName: tableName,
            IndexName: 'UserIdStartDateIndex',
            KeyConditionExpression: 'userId = :userId',
            ExpressionAttributeValues: { ':userId': userId },
            // Return results ordered by startDate ascending
            ScanIndexForward: true
        };

        const qres = await ddbSend(new QueryCommand(queryParams));
        if (qres.Items && qres.Items.length > 0) {
            return qres.Items;
        }

        // Fallback to Scan if index returns no items (covers legacy items without startDate)
        const scanParams = {
            TableName: tableName,
            FilterExpression: 'userId = :userId',
            ExpressionAttributeValues: { ':userId': userId }
        };
        const sres = await ddbSend(new ScanCommand(scanParams));
        return sres.Items || [];
    } catch (err) {
        console.error('Error fetching scheduled events:', err);
        return [];
    }
}

/**
 * Get a single event by ID
 */
async function getEventById(eventId) {
    try {
        const data = await ddbSend(new GetCommand({
            TableName: tableName,
            Key: { id: eventId }
        }));
        return data.Item;
    } catch (err) {
        console.error("Error fetching event by ID:", err);
        return null;
    }
}

/**
 * Save a scheduled event to DynamoDB
 */
async function saveScheduledEvent(event) {
    try {
        await ddbSend(new PutCommand({ TableName: tableName, Item: event }));
        console.info("Event saved successfully:", event);
        return true;
    } catch (err) {
        console.error("Error saving scheduled event:", err);
        return false;
    }
}

/**
 * Delete a scheduled event from DynamoDB
 */
async function deleteScheduledEvent(eventId) {
    try {
        await ddbSend(new DeleteCommand({
            TableName: tableName,
            Key: { id: eventId }
        }));
        console.info("Event deleted successfully:", eventId);
        return true;
    } catch (err) {
        console.error("Error deleting scheduled event:", err);
        return false;
    }
}

/**
 * Format date/time for display
 */
function formatDateTime(dateStr, timeStr) {
    if (!dateStr) return "N/A";
    return `${dateStr} ${timeStr || "00:00"}`;
}

/**
 * Get status type display text
 */
function getStatusTypeText(value) {
    const status = STATUS_TYPES.find(s => s.value === value);
    return status ? status.text : value || "Unknown";
}

/**
 * Get recurrence option display text
 */
function getRecurrenceText(value) {
    const opt = RECURRENCE_OPTIONS.find(o => o.value === value);
    return opt ? opt.text : value || "Unknown";
}

/**
 * Build the App Home view blocks
 * @param {Array}   events        Scheduled events for the user
 * @param {boolean} isAuthorized  Whether the user has connected their account via OAuth
 */
function buildHomeViewBlocks(events, isAuthorized = false) {
    const blocks = [
        {
            type: "section",
            text: { type: "mrkdwn", text: "*Welcome to the AODN Havi Bot!* :wave:" }
        },
        { type: "divider" }
    ];

    // ── OAuth connect banner ──────────────────────────────────────────────
    if (!isAuthorized) {
        const oauthUrl = `https://slack.com/oauth/v2/authorize?client_id=${SLACK_CLIENT_ID}&user_scope=users.profile%3Awrite&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}`;
        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: "⚠️ *Connect your account first!*\nHavi Bot needs one-time permission to update your Slack status automatically."
            },
            accessory: {
                type: "button",
                text: { type: "plain_text", text: "🔗 Connect Account", emoji: true },
                style: "primary",
                url: oauthUrl,
                action_id: "connect_account"
            }
        });
        blocks.push({ type: "divider" });
    } else {
        blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: "✅ *Account connected.* Your status will be updated automatically." }
        });
        blocks.push({ type: "divider" });
    }

    blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "*Your Scheduled Status Events*" }
    });

    if (events.length === 0) {
        blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: "_No scheduled events yet. Click a button below to add one!_" }
        });
    } else {
        events.sort((a, b) => {
            const dateA = new Date(`${a.startDate || a.date} ${a.startTime || "00:00"}`);
            const dateB = new Date(`${b.startDate || b.date} ${b.startTime || "00:00"}`);
            return dateA - dateB;
        });

        for (const event of events.slice(0, 28)) {
            const isRecurring = event.eventType === "recurring";
            const statusEmoji = event.statusType === "working_remotely" ? ":house:"
                : event.statusType === "vacationing" ? ":palm_tree:" : ":face_with_thermometer:";
                            const typeText = isRecurring
                                ? `🔁 Recurring (${getRecurrenceText(event.recurrenceInterval)})\n*From:* ${formatDateTime(event.startDate || event.date, event.startTime)} — ${event.endTime || "17:00"}`
                : `📅 One-time\n*Start:* ${formatDateTime(event.startDate, event.startTime)}\n*End:* ${formatDateTime(event.endDate, event.endTime)}`;
            const notifyText = event.sendMessage ? `\n💬 Will notify ${NOTIFICATION_CHANNEL_NAME}` : "";

            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `${statusEmoji} *${getStatusTypeText(event.statusType)}*\n${typeText}${notifyText}`
                },
                accessory: {
                    type: "overflow",
                    action_id: `event_overflow_${event.id}`,
                    options: [
                        { text: { type: "plain_text", text: "✏️ Edit" }, value: `edit_${event.id}` },
                        { text: { type: "plain_text", text: "🗑️ Remove" }, value: `remove_${event.id}` }
                    ]
                }
            });
            blocks.push({ type: "divider" });
        }
    }

    // Two buttons
    blocks.push({
        type: "actions",
        elements: [
            {
                type: "button",
                text: { type: "plain_text", text: "📅 Add one-time event", emoji: true },
                style: "primary",
                action_id: "add_one_time_event"
            },
            {
                type: "button",
                text: { type: "plain_text", text: "🔁 Add recurring event", emoji: true },
                action_id: "add_recurring_event"
            }
        ]
    });

    return blocks;
}

/**
 * Generate 30-minute time slot options for the whole day (00:00 – 23:30).
 * Display text uses 12-hour AM/PM format; value is 24-hour HH:MM.
 */
function buildTimeOptions() {
    const options = [];
    for (let h = 7; h <= 20; h++) {
        for (const m of [0, 30]) {
            if (h === 20 && m === 30) continue; // last slot is 8:00 PM (20:00)
            const hh = String(h).padStart(2, '0');
            const mm = String(m).padStart(2, '0');
            const value = `${hh}:${mm}`;
            const period = h < 12 ? 'AM' : 'PM';
            const displayH = h > 12 ? h - 12 : h;
            const text = `${displayH}:${mm} ${period}`;
            options.push({ text: { type: 'plain_text', text }, value });
        }
    }
    return options;
}

// Pre-built once at module load (48 options, reused across all modal builds)
const TIME_OPTIONS = buildTimeOptions();

/**
 * Build a static_select time picker with 30-minute increments.
 * @param {string} actionId      action_id for the element
 * @param {string|null} initialTime  24-hour "HH:MM" to pre-select (optional)
 */
function buildTimeSelect(actionId, initialTime = null) {
    const el = {
        type: 'static_select',
        action_id: actionId,
        placeholder: { type: 'plain_text', text: 'Select time' },
        options: TIME_OPTIONS
    };
    if (initialTime) {
        // Normalise to HH:MM (trim seconds if present)
        const norm = initialTime.substring(0, 5);
        const match = TIME_OPTIONS.find(o => o.value === norm);
        if (match) el.initial_option = match;
    }
    return el;
}

/**
 * Build status type select element
 */
function buildStatusTypeSelect(existingValue = null) {
    const el = {
        type: "static_select",
        action_id: "status_type",
        placeholder: { type: "plain_text", text: "Select status type" },
        options: STATUS_TYPES.map(s => ({
            text: { type: "plain_text", text: s.text },
            value: s.value
        }))
    };
    if (existingValue) {
        el.initial_option = {
            text: { type: "plain_text", text: getStatusTypeText(existingValue) },
            value: existingValue
        };
    }
    return el;
}

/**
 * Build notification checkbox element.
 * @param {boolean} checked
 * @param {string|null} labelText  Override label; defaults to plain "Send notification to <channel>"
 */
function buildNotificationCheckbox(checked = false, labelText = null) {
    const text = labelText || `Send notification to ${NOTIFICATION_CHANNEL_NAME}`;
    const el = {
        type: "checkboxes",
        action_id: "send_message",
        options: [{
            text: { type: "plain_text", text },
            value: "send_message"
        }]
    };
    if (checked) {
        el.initial_options = [{
            text: { type: "plain_text", text },
            value: "send_message"
        }];
    }
    return el;
}

/**
 * Build the Add/Edit One-Time Event modal.
 * @param {object|null} existingEvent  Existing event for edit mode
 * @param {object|null} currentValues  Live form state {startDate,startTime,endDate,endTime,sendMessage}
 *                                     passed when rebuilding the modal via dispatch_action
 */
function buildOneTimeEventModal(existingEvent = null, currentValues = null) {
    const isEdit = existingEvent !== null;
    const callbackId = isEdit ? `edit_one_time_event_${existingEvent.id}` : "add_one_time_event";

    // Resolve the best-known values for pre-population and notification label
    const cvStartDate = currentValues?.startDate ?? (isEdit ? existingEvent.startDate : null);
    const cvStartTime = currentValues?.startTime ?? (isEdit ? existingEvent.startTime : null);
    const cvEndDate   = currentValues?.endDate   ?? (isEdit ? existingEvent.endDate   : null);
    const cvEndTime   = currentValues?.endTime   ?? (isEdit ? existingEvent.endTime   : null);
    // Preserve checkbox state during live updates; fall back to saved value
    const cvChecked   = currentValues?.sendMessage !== undefined
        ? currentValues.sendMessage
        : (isEdit && existingEvent.sendMessage);

    const startDatePicker = {
        type: "datepicker",
        action_id: "start_date",
        placeholder: { type: "plain_text", text: "Select start date" }
    };
    if (cvStartDate) startDatePicker.initial_date = cvStartDate;

    const startTimePicker = buildTimeSelect('start_time', cvStartTime || '08:00');

    const endDatePicker = {
        type: "datepicker",
        action_id: "end_date",
        placeholder: { type: "plain_text", text: "Select end date" }
    };
    if (cvEndDate) endDatePicker.initial_date = cvEndDate;

    const endTimePicker = buildTimeSelect('end_time', cvEndTime || '17:00');

    // Dynamic notification label based on current date/time values
    const notifLabel = getNotificationCheckboxText(cvStartDate, cvStartTime, cvEndDate, cvEndTime);

    return {
        type: "modal",
        callback_id: callbackId,
        title: { type: "plain_text", text: isEdit ? "Edit One-Time Event" : "Add One-Time Event" },
        submit: { type: "plain_text", text: "Save" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
            {
                type: "input", block_id: "start_date_block", dispatch_action: true,
                element: startDatePicker,
                label: { type: "plain_text", text: "Start Date" }
            },
            {
                type: "input", block_id: "start_time_block", dispatch_action: true,
                element: startTimePicker,
                label: { type: "plain_text", text: "Start Time" }
            },
            {
                type: "input", block_id: "end_date_block", dispatch_action: true,
                element: endDatePicker,
                label: { type: "plain_text", text: "End Date" }
            },
            {
                type: "input", block_id: "end_time_block", dispatch_action: true,
                element: endTimePicker,
                label: { type: "plain_text", text: "End Time" }
            },
            {
                type: "input", block_id: "status_type_block",
                element: buildStatusTypeSelect(isEdit ? existingEvent.statusType : null),
                label: { type: "plain_text", text: "Status Type" }
            },
            {
                type: "input", block_id: "send_message_block", optional: true,
                element: buildNotificationCheckbox(cvChecked, notifLabel),
                label: { type: "plain_text", text: "Notifications" }
            }
        ]
    };
}

/**
 * Build the Add/Edit Recurring Event modal
 * @param {object|null} existingEvent        Existing event for edit mode
 * @param {string|null} selectedIntervalValue  Current recurrence interval value
 * @param {string|null} startDateValue         Current date value
 * @param {object|null} currentValues          Live form state {startTime,endTime,sendMessage}
 *                                             passed when rebuilding via dispatch_action
 */
function buildRecurringEventModal(existingEvent = null, selectedIntervalValue = null, startDateValue = null, currentValues = null) {
    const isEdit = existingEvent !== null;
    const callbackId = isEdit ? `edit_recurring_event_${existingEvent.id}` : "add_recurring_event";

    const currentInterval = selectedIntervalValue || (isEdit ? existingEvent.recurrenceInterval : null);
    const currentDate     = startDateValue || (isEdit ? (existingEvent.startDate || existingEvent.date) : null);

    // Resolve time values — live state takes priority, then saved, then defaults
    const cvStartTime = currentValues?.startTime ?? (isEdit ? existingEvent.startTime : null);
    const cvEndTime   = currentValues?.endTime   ?? (isEdit ? existingEvent.endTime   : null);
    const cvChecked   = currentValues?.sendMessage !== undefined
        ? currentValues.sendMessage
        : (isEdit && existingEvent.sendMessage);

    const recurrenceSelect = {
        type: "static_select",
        action_id: "recurrence_interval",
        placeholder: { type: "plain_text", text: "Select recurrence" },
        options: RECURRENCE_OPTIONS.map(o => ({
            text: { type: "plain_text", text: o.text },
            value: o.value
        }))
    };
    if (currentInterval) {
        recurrenceSelect.initial_option = {
            text: { type: "plain_text", text: getRecurrenceText(currentInterval) },
            value: currentInterval
        };
    }

    const datePicker = {
        type: "datepicker",
        action_id: "recurring_date",
        placeholder: { type: "plain_text", text: "Select date" }
    };
    if (currentDate) datePicker.initial_date = currentDate;

    const startTimePicker = buildTimeSelect('start_time', cvStartTime || '08:00');
    const endTimePicker   = buildTimeSelect('end_time',   cvEndTime   || '17:00');

    // Dynamic notification label
    const notifLabel = getRecurringNotificationCheckboxText(cvStartTime);

    const blocks = [];

    blocks.push({
        type: "input", block_id: "recurrence_interval_block", dispatch_action: true,
        element: recurrenceSelect,
        label: { type: "plain_text", text: "Recurrence Interval" }
    });

    blocks.push({
        type: "input", block_id: "recurring_date_block", dispatch_action: true,
        element: datePicker,
        label: { type: "plain_text", text: "Date" }
    });

    if (currentInterval && currentDate) {
        const opt = RECURRENCE_OPTIONS.find(o => o.value === currentInterval);
        if (opt) {
            const dates = getNextDates(opt.weeks, 4, currentDate);
            blocks.push({
                type: "context",
                elements: [{ type: "mrkdwn", text: `📆 *Estimated next 4 dates:* ${dates.join("  •  ")}` }]
            });
        }
    }

    blocks.push({ type: "input", block_id: "start_time_block", dispatch_action: true, element: startTimePicker, label: { type: "plain_text", text: "Start Time" } });
    blocks.push({ type: "input", block_id: "end_time_block",   dispatch_action: true, element: endTimePicker,   label: { type: "plain_text", text: "End Time" } });
    blocks.push({ type: "input", block_id: "status_type_block", element: buildStatusTypeSelect(isEdit ? existingEvent.statusType : null), label: { type: "plain_text", text: "Status Type" } });
    blocks.push({ type: "input", block_id: "send_message_block", optional: true, element: buildNotificationCheckbox(cvChecked, notifLabel), label: { type: "plain_text", text: "Notifications" } });

    return {
        type: "modal",
        callback_id: callbackId,
        title: { type: "plain_text", text: isEdit ? "Edit Recurring Event" : "Add Recurring Event" },
        submit: { type: "plain_text", text: "Save" },
        close: { type: "plain_text", text: "Cancel" },
        blocks
    };
}

/**
 * Publishes an App Home view to Slack
 */
async function publishHomeView(userId) {
    const [events, userToken] = await Promise.all([
        getScheduledEvents(userId),
        getUserToken(userId)
    ]);
    const isAuthorized = !!userToken;
    const homeView = { type: "home", blocks: buildHomeViewBlocks(events, isAuthorized) };

    const response = await fetch("https://slack.com/api/views.publish", {
        method: "POST",
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Authorization": `Bearer ${SLACK_BOT_TOKEN}`
        },
        body: JSON.stringify({ user_id: userId, view: homeView })
    });

    const result = await response.json();
    if (!result.ok) {
        console.error("Failed to publish home view:", result.error);
        if (result.response_metadata?.messages) {
            console.error("Validation Errors:", JSON.stringify(result.response_metadata.messages));
        }
        throw new Error(`Slack API error: ${result.error}`);
    }
    return result;
}

/**
 * Open a modal in Slack
 */
async function openModal(triggerId, modal) {
    const response = await fetch("https://slack.com/api/views.open", {
        method: "POST",
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Authorization": `Bearer ${SLACK_BOT_TOKEN}`
        },
        body: JSON.stringify({ trigger_id: triggerId, view: modal })
    });

    const result = await response.json();
    if (!result.ok) {
        console.error("Failed to open modal:", result.error);
        if (result.response_metadata?.messages) {
            console.error("Modal Validation Errors:", JSON.stringify(result.response_metadata.messages));
        }
        throw new Error(`Slack API error: ${result.error}`);
    }
    return result;
}

/**
 * Update an existing modal in Slack (for dispatch_action updates)
 */
async function updateModal(viewId, viewHash, modal) {
    const response = await fetch("https://slack.com/api/views.update", {
        method: "POST",
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Authorization": `Bearer ${SLACK_BOT_TOKEN}`
        },
        body: JSON.stringify({ view_id: viewId, hash: viewHash, view: modal })
    });

    const result = await response.json();
    if (!result.ok) {
        console.error("Failed to update modal:", result.error);
        if (result.response_metadata?.messages) {
            console.error("Modal Update Validation Errors:", JSON.stringify(result.response_metadata.messages));
        }
        throw new Error(`Slack API error: ${result.error}`);
    }
    return result;
}

/**
 * Generate a unique event ID
 */
function generateEventId() {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Compare two date+time strings.
 * Returns true if end is strictly before start.
 */
function isEndBeforeStart(startDate, startTime, endDate, endTime) {
    if (!startDate || !endDate) return false;
    const start = new Date(`${startDate}T${startTime || "00:00"}:00`);
    const end   = new Date(`${endDate}T${endTime   || "00:00"}:00`);
    return end < start;
}

/**
 * Parse one-time modal submission values
 */
function parseOneTimeModalValues(values) {
    return {
        startDate: values.start_date_block?.start_date?.selected_date,
        startTime: values.start_time_block?.start_time?.selected_option?.value,
        endDate: values.end_date_block?.end_date?.selected_date,
        endTime: values.end_time_block?.end_time?.selected_option?.value,
        statusType: values.status_type_block?.status_type?.selected_option?.value,
        sendMessage: (values.send_message_block?.send_message?.selected_options || [])
            .some(opt => opt.value === "send_message"),
        eventType: "one_time",
        isRecurring: false
    };
}

/**
 * Parse recurring modal submission values
 */
function parseRecurringModalValues(values) {
    const date = values.recurring_date_block?.recurring_date?.selected_date;
    return {
        recurrenceInterval: values.recurrence_interval_block?.recurrence_interval?.selected_option?.value,
        // For recurring events, store the date as both startDate and endDate
        startDate: date,
        endDate: date,
        startTime: values.start_time_block?.start_time?.selected_option?.value,
        endTime: values.end_time_block?.end_time?.selected_option?.value,
        statusType: values.status_type_block?.status_type?.selected_option?.value,
        sendMessage: (values.send_message_block?.send_message?.selected_options || [])
            .some(opt => opt.value === "send_message"),
        eventType: "recurring",
        isRecurring: true
    };
}

/**
 * Handle interactive actions (buttons, overflow menus, dispatch_action inside modals)
 */
async function handleInteractiveAction(payload) {
    const userId = payload.user.id;
    const triggerId = payload.trigger_id;
    const actions = payload.actions || [];

    // Handle dispatch_action from within a modal
    if (payload.view && payload.view.type === "modal") {
        const callbackId = payload.view.callback_id;
        const sv = payload.view.state.values;

        for (const action of actions) {
            // ── Recurring modal: any of its dispatch fields changed ────────
            const isRecurringModal = callbackId === "add_recurring_event" || callbackId.startsWith("edit_recurring_event_");
            if (isRecurringModal && ["recurrence_interval", "recurring_date", "start_time", "end_time"].includes(action.action_id)) {
                const selectedInterval = sv.recurrence_interval_block?.recurrence_interval?.selected_option?.value || null;
                const startDate        = sv.recurring_date_block?.recurring_date?.selected_date || null;
                const currentValues    = {
                    startTime:   sv.start_time_block?.start_time?.selected_option?.value || null,
                    endTime:     sv.end_time_block?.end_time?.selected_option?.value     || null,
                    sendMessage: (sv.send_message_block?.send_message?.selected_options || []).some(o => o.value === "send_message")
                };

                let existingEvent = null;
                if (callbackId.startsWith("edit_recurring_event_")) {
                    const eventId = callbackId.replace("edit_recurring_event_", "");
                    existingEvent = await getEventById(eventId);
                }

                console.info("Recurring modal field changed:", { selectedInterval, startDate, ...currentValues });
                const updatedModal = buildRecurringEventModal(existingEvent, selectedInterval, startDate, currentValues);
                await updateModal(payload.view.id, payload.view.hash, updatedModal);
                return;
            }

            // ── One-time modal: any date/time field changed ────────────────
            const isOneTimeModal = callbackId === "add_one_time_event" || callbackId.startsWith("edit_one_time_event_");
            if (isOneTimeModal && ["start_date", "start_time", "end_date", "end_time"].includes(action.action_id)) {
                const currentValues = {
                    startDate:   sv.start_date_block?.start_date?.selected_date             || null,
                    startTime:   sv.start_time_block?.start_time?.selected_option?.value    || null,
                    endDate:     sv.end_date_block?.end_date?.selected_date                 || null,
                    endTime:     sv.end_time_block?.end_time?.selected_option?.value        || null,
                    sendMessage: (sv.send_message_block?.send_message?.selected_options || []).some(o => o.value === "send_message")
                };

                let existingEvent = null;
                if (callbackId.startsWith("edit_one_time_event_")) {
                    const eventId = callbackId.replace("edit_one_time_event_", "");
                    existingEvent = await getEventById(eventId);
                }

                console.info("One-time modal date/time changed:", currentValues);
                const updatedModal = buildOneTimeEventModal(existingEvent, currentValues);
                await updateModal(payload.view.id, payload.view.hash, updatedModal);
                return;
            }
        }
        return; // other modal block_actions - ignore
    }

    for (const action of actions) {
        const actionId = action.action_id;
        console.info("=== INTERACTIVE ACTION RECEIVED ===");
        console.info("Action ID:", actionId, "User:", userId);

        // Add one-time event (also handle legacy add_scheduled_event)
        if (actionId === "add_one_time_event" || actionId === "add_scheduled_event") {
            await openModal(triggerId, buildOneTimeEventModal());
            return;
        }

        // Add recurring event
        if (actionId === "add_recurring_event") {
            await openModal(triggerId, buildRecurringEventModal());
            return;
        }

        // Overflow menu (Edit / Remove)
        if (actionId.startsWith("event_overflow_")) {
            const selectedValue = action.selected_option?.value;

            if (selectedValue?.startsWith("edit_")) {
                const eventId = selectedValue.replace("edit_", "");
                const existingEvent = await getEventById(eventId);
                if (!existingEvent) {
                    console.error("Event not found:", eventId);
                    return;
                }
                const modal = existingEvent.eventType === "recurring"
                    ? buildRecurringEventModal(existingEvent)
                    : buildOneTimeEventModal(existingEvent);
                await openModal(triggerId, modal);
                return;
            }

            if (selectedValue?.startsWith("remove_")) {
                const eventId = selectedValue.replace("remove_", "");
                await deleteScheduledEvent(eventId);
                await publishHomeView(userId);
                return;
            }
        }
    }
}

/**
 * Handle modal submission (view_submission)
 */
async function handleModalSubmission(payload) {
    const userId = payload.user.id;
    const callbackId = payload.view.callback_id;
    const values = payload.view.state.values;

    console.info("=== MODAL SUBMISSION RECEIVED ===");
    console.info("Callback ID:", callbackId, "User:", userId);
    console.info("Raw Values:", JSON.stringify(values, null, 2));

    let eventId;
    let parsedValues;
    let existingCreatedAt = null;

    if (callbackId === "add_one_time_event") {
        eventId = generateEventId();
        parsedValues = parseOneTimeModalValues(values);
    } else if (callbackId === "add_recurring_event") {
        eventId = generateEventId();
        parsedValues = parseRecurringModalValues(values);
    } else if (callbackId.startsWith("edit_one_time_event_")) {
        eventId = callbackId.replace("edit_one_time_event_", "");
        parsedValues = parseOneTimeModalValues(values);
        const existing = await getEventById(eventId);
        existingCreatedAt = existing?.createdAt || null;
    } else if (callbackId.startsWith("edit_recurring_event_")) {
        eventId = callbackId.replace("edit_recurring_event_", "");
        parsedValues = parseRecurringModalValues(values);
        const existing = await getEventById(eventId);
        existingCreatedAt = existing?.createdAt || null;
    } else {
        console.error("Unknown callback_id:", callbackId);
        return;
    }

    // ── Datetime validation ───────────────────────────────────────────────
    if (parsedValues.eventType === "one_time") {
        if (isEndBeforeStart(parsedValues.startDate, parsedValues.startTime, parsedValues.endDate, parsedValues.endTime)) {
            console.warn("Validation failed: end datetime is before start datetime");
            return {
                response_action: "errors",
                errors: {
                    end_date_block: "End date/time cannot be earlier than start date/time.",
                    end_time_block: "End date/time cannot be earlier than start date/time."
                }
            };
        }
    } else if (parsedValues.eventType === "recurring") {
        // Same date for recurring — just compare times
        if (parsedValues.startTime && parsedValues.endTime && parsedValues.endTime <= parsedValues.startTime) {
            console.warn("Validation failed: end time is not after start time");
            return {
                response_action: "errors",
                errors: {
                    end_time_block: "End time must be later than start time."
                }
            };
        }
    }

    const now = new Date().toISOString();
    const eventData = {
        id: eventId,
        userId,
        ...parsedValues,
        createdAt: existingCreatedAt || now,
        updatedAt: now
    };

    console.info("=== EVENT DATA TO SAVE ===");
    console.info(JSON.stringify(eventData, null, 2));

    const success = await saveScheduledEvent(eventData);
    console.info(success ? "Event saved successfully" : "Failed to save event");

    await publishHomeView(userId);
}

/**
 * Lambda handler for Slack Events API
 */
export const slackEventsHandler = async (event) => {
    // Normalize API Gateway v2 (HTTP API) events to the shape expected by the handler
    function normalizeApiGatewayEvent(evt) {
        // If it's already v1 or not an API Gateway v2 event, return as-is
        if (!evt || evt.version !== '2.0' || !evt.requestContext || !evt.requestContext.http) return evt;

        // Build a v1-like wrapper with the fields our code expects
        const normalized = {
            // body may be base64-encoded already depending on payload
            body: evt.body,
            isBase64Encoded: evt.isBase64Encoded || false,
            headers: evt.headers || {},
            // keep original requestContext (in case other code needs it)
            requestContext: evt.requestContext,
            // copy through any other useful top-level fields
            rawEvent: evt
        };

        // Map common requestContext fields for convenience
        if (evt.requestContext && evt.requestContext.http) {
            normalized.httpMethod = evt.requestContext.http.method;
            normalized.path = evt.requestContext.http.path || evt.rawPath;
        }

        // Map pathParameters and queryStringParameters if present
        if (evt.pathParameters) normalized.pathParameters = evt.pathParameters;
        if (evt.queryStringParameters) normalized.queryStringParameters = evt.queryStringParameters;

        return normalized;
    }

    event = normalizeApiGatewayEvent(event);
    console.info("Received Slack event:", JSON.stringify(event));

    let rawBody = event.body || "";
    if (event.isBase64Encoded) {
        rawBody = Buffer.from(rawBody, 'base64').toString('utf-8');
        console.info("Decoded base64 body");
    }

    const headers = event.headers || {};
    const contentType = headers["Content-Type"] || headers["content-type"] || headers["CONTENT-TYPE"] || "";
    console.info("Content-Type:", contentType);

    // Interactivity payload (URL-encoded form data)
    if (contentType.includes("application/x-www-form-urlencoded") || rawBody.startsWith("payload=")) {
        const params = new URLSearchParams(rawBody);
        const payloadStr = params.get("payload");

        if (payloadStr) {
            let payload;
            try {
                payload = JSON.parse(payloadStr);
            } catch (err) {
                console.error("Failed to parse interactivity payload:", err);
                return { statusCode: 400, body: JSON.stringify({ error: "Invalid payload" }) };
            }

            console.info("=== INTERACTIVITY PAYLOAD ===");
            console.info("Type:", payload.type, "View type:", payload.view?.type);

            if (payload.type === "block_actions") {
                try {
                    await handleInteractiveAction(payload);
                } catch (err) {
                    console.error("Error handling interactive action:", err);
                }
                return { statusCode: 200, body: "" };
            }

            if (payload.type === "view_submission") {
                try {
                    const validationResponse = await handleModalSubmission(payload);
                    if (validationResponse) {
                        // Return Slack validation errors to keep the modal open
                        return {
                            statusCode: 200,
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(validationResponse)
                        };
                    }
                } catch (err) {
                    console.error("Error handling modal submission:", err);
                }
                return {
                    statusCode: 200,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({})
                };
            }

            if (payload.type === "view_closed") {
                console.info("Modal closed by user:", payload.user.id);
                return { statusCode: 200, body: "" };
            }
        }
    }

    // JSON body (Events API)
    let body;
    try {
        body = JSON.parse(rawBody);
    } catch (err) {
        console.error("Failed to parse request body:", err);
        return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
    }

    if (body.type === "url_verification") {
        console.info("Handling url_verification challenge");
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ challenge: body.challenge })
        };
    }

    if (body.type === "event_callback") {
        const slackEvent = body.event;
        console.info("Event Type:", slackEvent.type);

        if (slackEvent.type === "app_home_opened") {
            console.info(`app_home_opened by user: ${slackEvent.user}`);
            try {
                await publishHomeView(slackEvent.user);
                console.info("Successfully published home view");
            } catch (err) {
                console.error("Error publishing home view:", err);
            }
        }
    }

    return { statusCode: 200, body: "" };
};

