// Slack Events API handler for app_home_opened event and interactivity

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(client);

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const tableName = process.env.SAMPLE_TABLE;

// Validate token on module load
if (!SLACK_BOT_TOKEN) {
    console.error("WARNING: SLACK_BOT_TOKEN environment variable is not set!");
} else if (!SLACK_BOT_TOKEN.startsWith('xoxb-')) {
    console.error("WARNING: SLACK_BOT_TOKEN should start with 'xoxb-' for bot tokens");
} else {
    console.info(`SLACK_BOT_TOKEN is set (length: ${SLACK_BOT_TOKEN.length}, prefix: ${SLACK_BOT_TOKEN.substring(0, 10)}...)`);
}

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

// Notification channel
const NOTIFICATION_CHANNEL = "#abc";

/**
 * Calculate next N occurrence dates from a base date given interval in weeks
 */
function getNextDates(weeksInterval, count = 4, fromDateStr = null) {
    const base = fromDateStr ? new Date(`${fromDateStr}T00:00:00`) : new Date();
    base.setHours(0, 0, 0, 0);
    const dates = [];
    for (let i = 1; i <= count; i++) {
        const d = new Date(base);
        d.setDate(d.getDate() + i * weeksInterval * 7);
        dates.push(d.toISOString().substring(0, 10));
    }
    return dates;
}

/**
 * Fetch all scheduled events from DynamoDB for a user
 */
async function getScheduledEvents(userId) {
    try {
        const params = {
            TableName: tableName,
            FilterExpression: "userId = :userId",
            ExpressionAttributeValues: { ":userId": userId }
        };
        const data = await ddbDocClient.send(new ScanCommand(params));
        return data.Items || [];
    } catch (err) {
        console.error("Error fetching scheduled events:", err);
        return [];
    }
}

/**
 * Get a single event by ID
 */
async function getEventById(eventId) {
    try {
        const data = await ddbDocClient.send(new GetCommand({
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
        await ddbDocClient.send(new PutCommand({ TableName: tableName, Item: event }));
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
        await ddbDocClient.send(new DeleteCommand({
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
 */
function buildHomeViewBlocks(events) {
    const blocks = [
        {
            type: "section",
            text: { type: "mrkdwn", text: "*Welcome to the AODN Havi Bot!* :wave:" }
        },
        { type: "divider" },
        {
            type: "section",
            text: { type: "mrkdwn", text: "*Your Scheduled Status Events*" }
        }
    ];

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
                ? `🔁 Recurring (${getRecurrenceText(event.recurrenceInterval)})\n*From:* ${formatDateTime(event.date, event.startTime)} — ${event.endTime || "17:00"}`
                : `📅 One-time\n*Start:* ${formatDateTime(event.startDate, event.startTime)}\n*End:* ${formatDateTime(event.endDate, event.endTime)}`;
            const notifyText = event.sendMessage ? `\n💬 Will notify ${NOTIFICATION_CHANNEL}` : "";

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
 * Build notification checkbox element
 */
function buildNotificationCheckbox(checked = false) {
    const el = {
        type: "checkboxes",
        action_id: "send_message",
        options: [{
            text: { type: "plain_text", text: `Send notification to ${NOTIFICATION_CHANNEL}` },
            value: "send_message"
        }]
    };
    if (checked) {
        el.initial_options = [{
            text: { type: "plain_text", text: `Send notification to ${NOTIFICATION_CHANNEL}` },
            value: "send_message"
        }];
    }
    return el;
}

/**
 * Build the Add/Edit One-Time Event modal
 */
function buildOneTimeEventModal(existingEvent = null) {
    const isEdit = existingEvent !== null;
    const callbackId = isEdit ? `edit_one_time_event_${existingEvent.id}` : "add_one_time_event";

    const startDatePicker = {
        type: "datepicker",
        action_id: "start_date",
        placeholder: { type: "plain_text", text: "Select start date" }
    };
    if (isEdit && existingEvent.startDate) startDatePicker.initial_date = existingEvent.startDate;

    const startTimePicker = {
        type: "timepicker",
        action_id: "start_time",
        placeholder: { type: "plain_text", text: "Select start time" },
        increment_by: 15,
        initial_time: (isEdit && existingEvent.startTime) ? existingEvent.startTime : "08:00"
    };

    const endDatePicker = {
        type: "datepicker",
        action_id: "end_date",
        placeholder: { type: "plain_text", text: "Select end date" }
    };
    if (isEdit && existingEvent.endDate) endDatePicker.initial_date = existingEvent.endDate;

    const endTimePicker = {
        type: "timepicker",
        action_id: "end_time",
        placeholder: { type: "plain_text", text: "Select end time" },
        increment_by: 15,
        initial_time: (isEdit && existingEvent.endTime) ? existingEvent.endTime : "17:00"
    };

    return {
        type: "modal",
        callback_id: callbackId,
        title: { type: "plain_text", text: isEdit ? "Edit One-Time Event" : "Add One-Time Event" },
        submit: { type: "plain_text", text: "Save" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
            {
                type: "input", block_id: "start_date_block",
                element: startDatePicker,
                label: { type: "plain_text", text: "Start Date" }
            },
            {
                type: "input", block_id: "start_time_block",
                element: startTimePicker,
                label: { type: "plain_text", text: "Start Time" }
            },
            {
                type: "input", block_id: "end_date_block",
                element: endDatePicker,
                label: { type: "plain_text", text: "End Date" }
            },
            {
                type: "input", block_id: "end_time_block",
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
                element: buildNotificationCheckbox(isEdit && existingEvent.sendMessage),
                label: { type: "plain_text", text: "Notifications" }
            }
        ]
    };
}

/**
 * Build the Add/Edit Recurring Event modal
 * selectedIntervalValue and startDateValue are used to show estimated next 4 dates
 */
function buildRecurringEventModal(existingEvent = null, selectedIntervalValue = null, startDateValue = null) {
    const isEdit = existingEvent !== null;
    const callbackId = isEdit ? `edit_recurring_event_${existingEvent.id}` : "add_recurring_event";

    // Determine current values (for pre-population or dispatch_action context)
    const currentInterval = selectedIntervalValue || (isEdit ? existingEvent.recurrenceInterval : null);
    const currentDate = startDateValue || (isEdit ? existingEvent.date : null);

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
        placeholder: { type: "plain_text", text: "Select start date" }
    };
    if (currentDate) datePicker.initial_date = currentDate;

    const startTimePicker = {
        type: "timepicker",
        action_id: "start_time",
        placeholder: { type: "plain_text", text: "Select start time" },
        increment_by: 15,
        initial_time: (isEdit && existingEvent.startTime) ? existingEvent.startTime : "08:00"
    };

    const endTimePicker = {
        type: "timepicker",
        action_id: "end_time",
        placeholder: { type: "plain_text", text: "Select end time" },
        increment_by: 15,
        initial_time: (isEdit && existingEvent.endTime) ? existingEvent.endTime : "17:00"
    };

    const blocks = [
        {
            type: "input", block_id: "recurrence_interval_block",
            dispatch_action: true,
            element: recurrenceSelect,
            label: { type: "plain_text", text: "Recurrence Interval" }
        },
        {
            type: "input", block_id: "recurring_date_block",
            element: datePicker,
            label: { type: "plain_text", text: "Starting Date" }
        },
        {
            type: "input", block_id: "start_time_block",
            element: startTimePicker,
            label: { type: "plain_text", text: "Start Time" }
        },
        {
            type: "input", block_id: "end_time_block",
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
            element: buildNotificationCheckbox(isEdit && existingEvent.sendMessage),
            label: { type: "plain_text", text: "Notifications" }
        }
    ];

    // Show estimated next 4 dates if interval is selected
    if (currentInterval) {
        const opt = RECURRENCE_OPTIONS.find(o => o.value === currentInterval);
        if (opt) {
            const dates = getNextDates(opt.weeks, 4, currentDate);
            blocks.push({
                type: "context",
                elements: [{
                    type: "mrkdwn",
                    text: `📆 *Estimated next 4 dates:* ${dates.join("  •  ")}`
                }]
            });
        }
    }

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
    const events = await getScheduledEvents(userId);
    const homeView = { type: "home", blocks: buildHomeViewBlocks(events) };

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
 * Parse one-time modal submission values
 */
function parseOneTimeModalValues(values) {
    return {
        startDate: values.start_date_block?.start_date?.selected_date,
        startTime: values.start_time_block?.start_time?.selected_time,
        endDate: values.end_date_block?.end_date?.selected_date,
        endTime: values.end_time_block?.end_time?.selected_time,
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
    return {
        recurrenceInterval: values.recurrence_interval_block?.recurrence_interval?.selected_option?.value,
        date: values.recurring_date_block?.recurring_date?.selected_date,
        startTime: values.start_time_block?.start_time?.selected_time,
        endTime: values.end_time_block?.end_time?.selected_time,
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

    // Handle dispatch_action from within a modal (recurrence_interval change)
    if (payload.view && payload.view.type === "modal") {
        for (const action of actions) {
            if (action.action_id === "recurrence_interval") {
                const selectedInterval = action.selected_option?.value;
                const stateValues = payload.view.state?.values || {};
                const startDate = stateValues.recurring_date_block?.recurring_date?.selected_date || null;
                const callbackId = payload.view.callback_id;

                console.info("Recurrence interval changed:", selectedInterval, "startDate:", startDate);

                // Rebuild recurring modal with estimated dates, preserving existing event context for edits
                let existingEvent = null;
                if (callbackId.startsWith("edit_recurring_event_")) {
                    const eventId = callbackId.replace("edit_recurring_event_", "");
                    existingEvent = await getEventById(eventId);
                }

                const updatedModal = buildRecurringEventModal(existingEvent, selectedInterval, startDate);
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
                    await handleModalSubmission(payload);
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

