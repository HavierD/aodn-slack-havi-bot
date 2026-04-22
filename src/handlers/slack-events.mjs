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
    { text: "Vacationing", value: "vacationing" }
];

// Notification channel
const NOTIFICATION_CHANNEL = "#abc";

/**
 * Fetch all scheduled events from DynamoDB for a user
 */
async function getScheduledEvents(userId) {
    try {
        const params = {
            TableName: tableName,
            FilterExpression: "userId = :userId",
            ExpressionAttributeValues: {
                ":userId": userId
            }
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
        const params = {
            TableName: tableName,
            Key: { id: eventId }
        };
        const data = await ddbDocClient.send(new GetCommand(params));
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
        const params = {
            TableName: tableName,
            Item: event
        };
        await ddbDocClient.send(new PutCommand(params));
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
        const params = {
            TableName: tableName,
            Key: { id: eventId }
        };
        await ddbDocClient.send(new DeleteCommand(params));
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
    const timeDisplay = timeStr || "00:00";
    return `${dateStr} ${timeDisplay}`;
}

/**
 * Get status type display text
 */
function getStatusTypeText(value) {
    const status = STATUS_TYPES.find(s => s.value === value);
    return status ? status.text : value;
}

/**
 * Build the App Home view blocks
 */
function buildHomeViewBlocks(events) {
    const blocks = [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: "*Welcome to the AODN Havi Bot!* :wave:"
            }
        },
        {
            type: "divider"
        },
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: "*Your Scheduled Status Events*"
            }
        }
    ];

    if (events.length === 0) {
        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: "_No scheduled events yet. Click the button below to add one!_"
            }
        });
    } else {
        // Sort events by start date
        events.sort((a, b) => {
            const dateA = new Date(`${a.startDate} ${a.startTime || "00:00"}`);
            const dateB = new Date(`${b.startDate} ${b.startTime || "00:00"}`);
            return dateA - dateB;
        });

        for (const event of events.slice(0, 30)) { // Limit to avoid 100 Slack max blocks limit
            const statusEmoji = event.statusType === "working_remotely" ? ":house:" : ":palm_tree:";
            const recurrenceText = event.isRecurring ? "🔁 Recurring" : "📅 One-time";
            const notifyText = event.sendMessage ? `\n💬 Will notify ${NOTIFICATION_CHANNEL}` : "";

            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `${statusEmoji} *${getStatusTypeText(event.statusType)}*\n` +
                          `*Start:* ${formatDateTime(event.startDate, event.startTime)}\n` +
                          `*End:* ${formatDateTime(event.endDate, event.endTime)}\n` +
                          `${recurrenceText}${notifyText}`
                },
                accessory: {
                    type: "overflow",
                    action_id: `event_overflow_${event.id}`,
                    options: [
                        {
                            text: {
                                type: "plain_text",
                                text: "✏️ Edit"
                            },
                            value: `edit_${event.id}`
                        },
                        {
                            text: {
                                type: "plain_text",
                                text: "🗑️ Remove"
                            },
                            value: `remove_${event.id}`
                        }
                    ]
                }
            });

            blocks.push({
                type: "divider"
            });
        }
    }

    // Add scheduled event button
    blocks.push({
        type: "actions",
        elements: [
            {
                type: "button",
                text: {
                    type: "plain_text",
                    text: "➕ Add scheduled event",
                    emoji: true
                },
                style: "primary",
                action_id: "add_scheduled_event"
            }
        ]
    });

    return blocks;
}

/**
 * Build the Add/Edit modal view
 */
function buildEventModal(existingEvent = null) {
    const isEdit = existingEvent !== null;
    const modalTitle = isEdit ? "Edit Scheduled Event" : "Add Scheduled Event";
    const callbackId = isEdit ? `edit_event_${existingEvent.id}` : "add_event";

    // Build form blocks array explicitly to avoid undefined spread injections
    const startDatePicker = {
        type: "datepicker",
        action_id: "start_date",
        placeholder: {
            type: "plain_text",
            text: "Select start date"
        }
    };
    if (isEdit && existingEvent.startDate) {
        startDatePicker.initial_date = existingEvent.startDate;
    }

    const startTimePicker = {
        type: "timepicker",
        action_id: "start_time",
        placeholder: {
            type: "plain_text",
            text: "Select start time"
        }
    };
    if (isEdit && existingEvent.startTime) {
        startTimePicker.initial_time = existingEvent.startTime;
    }

    const endDatePicker = {
        type: "datepicker",
        action_id: "end_date",
        placeholder: {
            type: "plain_text",
            text: "Select end date"
        }
    };
    if (isEdit && existingEvent.endDate) {
        endDatePicker.initial_date = existingEvent.endDate;
    }

    const endTimePicker = {
        type: "timepicker",
        action_id: "end_time",
        placeholder: {
            type: "plain_text",
            text: "Select end time"
        }
    };
    if (isEdit && existingEvent.endTime) {
        endTimePicker.initial_time = existingEvent.endTime;
    }

    const statusTypeSelect = {
        type: "static_select",
        action_id: "status_type",
        placeholder: {
            type: "plain_text",
            text: "Select status type"
        },
        options: STATUS_TYPES.map(status => ({
            text: {
                type: "plain_text",
                text: status.text
            },
            value: status.value
        }))
    };
    if (isEdit && existingEvent.statusType) {
        statusTypeSelect.initial_option = {
            text: {
                type: "plain_text",
                text: getStatusTypeText(existingEvent.statusType)
            },
            value: existingEvent.statusType
        };
    }

    const isRecurringSelect = {
        type: "static_select",
        action_id: "is_recurring",
        placeholder: {
            type: "plain_text",
            text: "Select event type"
        },
        options: [
            {
                text: {
                    type: "plain_text",
                    text: "One-time"
                },
                value: "one_time"
            },
            {
                text: {
                    type: "plain_text",
                    text: "Recurring"
                },
                value: "recurring"
            }
        ]
    };

    if (isEdit) {
        isRecurringSelect.initial_option = existingEvent.isRecurring
            ? { text: { type: "plain_text", text: "Recurring" }, value: "recurring" }
            : { text: { type: "plain_text", text: "One-time" }, value: "one_time" };
    }

    const sendMessageCheckbox = {
        type: "checkboxes",
        action_id: "send_message",
        options: [
            {
                text: {
                    type: "plain_text",
                    text: `Send notification to ${NOTIFICATION_CHANNEL}`
                },
                value: "send_message"
            }
        ]
    };
    if (isEdit && existingEvent.sendMessage) {
        sendMessageCheckbox.initial_options = [
            {
                text: {
                    type: "plain_text",
                    text: `Send notification to ${NOTIFICATION_CHANNEL}`
                },
                value: "send_message"
            }
        ];
    }

    const modal = {
        type: "modal",
        callback_id: callbackId,
        title: {
            type: "plain_text",
            text: modalTitle.substring(0, 24) // Fallback limit
        },
        submit: {
            type: "plain_text",
            text: "Save"
        },
        close: {
            type: "plain_text",
            text: "Cancel"
        },
        blocks: [
            {
                type: "input",
                block_id: "start_date_block",
                element: startDatePicker,
                label: {
                    type: "plain_text",
                    text: "Start Date"
                }
            },
            {
                type: "input",
                block_id: "start_time_block",
                element: startTimePicker,
                label: {
                    type: "plain_text",
                    text: "Start Time"
                }
            },
            {
                type: "input",
                block_id: "end_date_block",
                element: endDatePicker,
                label: {
                    type: "plain_text",
                    text: "End Date"
                }
            },
            {
                type: "input",
                block_id: "end_time_block",
                element: endTimePicker,
                label: {
                    type: "plain_text",
                    text: "End Time"
                }
            },
            {
                type: "input",
                block_id: "status_type_block",
                element: statusTypeSelect,
                label: {
                    type: "plain_text",
                    text: "Status Type"
                }
            },
            {
                type: "input",
                block_id: "is_recurring_block",
                element: isRecurringSelect,
                label: {
                    type: "plain_text",
                    text: "Event Type"
                }
            },
            {
                type: "input",
                block_id: "send_message_block",
                optional: true,
                element: sendMessageCheckbox,
                label: {
                    type: "plain_text",
                    text: "Notifications"
                }
            }
        ]
    };

    return modal;
}

/**
 * Publishes an App Home view to Slack
 */
async function publishHomeView(userId) {
    const events = await getScheduledEvents(userId);
    const homeView = {
        type: "home",
        blocks: buildHomeViewBlocks(events)
    };

    const response = await fetch("https://slack.com/api/views.publish", {
        method: "POST",
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Authorization": `Bearer ${SLACK_BOT_TOKEN}`
        },
        body: JSON.stringify({
            user_id: userId,
            view: homeView
        })
    });

    const result = await response.json();
    if (!result.ok) {
        console.error("Failed to publish home view:", result.error);
        if (result.response_metadata && result.response_metadata.messages) {
            console.error("Slack Home View Validation Errors:", JSON.stringify(result.response_metadata.messages));
        }
        if (result.error === 'invalid_auth' || result.error === 'not_authed') {
            console.error("Token validation failed. Please check:");
            console.error("1. SLACK_BOT_TOKEN environment variable is set correctly in SAM/CloudFormation");
            console.error("2. Token starts with 'xoxb-' (Bot User OAuth Token)");
            console.error("3. Token has not been revoked or regenerated");
            console.error("4. Bot has required scopes: chat:write, users:read");
            console.error(`Token info: set=${!!SLACK_BOT_TOKEN}, length=${SLACK_BOT_TOKEN?.length || 0}`);
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
        body: JSON.stringify({
            trigger_id: triggerId,
            view: modal
        })
    });

    const result = await response.json();
    if (!result.ok) {
        console.error("Failed to open modal:", result.error);
        if (result.response_metadata && result.response_metadata.messages) {
            console.error("Slack Modal Validation Errors:", JSON.stringify(result.response_metadata.messages));
        }
        if (result.error === 'invalid_auth' || result.error === 'not_authed') {
            console.error("Token validation failed. Check SLACK_BOT_TOKEN environment variable.");
            console.error(`Token info: set=${!!SLACK_BOT_TOKEN}, length=${SLACK_BOT_TOKEN?.length || 0}`);
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
 * Parse modal submission values
 */
function parseModalValues(values) {
    const startDate = values.start_date_block?.start_date?.selected_date;
    const startTime = values.start_time_block?.start_time?.selected_time;
    const endDate = values.end_date_block?.end_date?.selected_date;
    const endTime = values.end_time_block?.end_time?.selected_time;
    const statusType = values.status_type_block?.status_type?.selected_option?.value;
    const isRecurringValue = values.is_recurring_block?.is_recurring?.selected_option?.value;
    const isRecurring = isRecurringValue === "recurring";
    const sendMessageOptions = values.send_message_block?.send_message?.selected_options || [];
    const sendMessage = sendMessageOptions.some(opt => opt.value === "send_message");

    return {
        startDate,
        startTime,
        endDate,
        endTime,
        statusType,
        isRecurring,
        sendMessage
    };
}

/**
 * Handle interactive actions (buttons, overflow menus)
 */
async function handleInteractiveAction(payload) {
    const userId = payload.user.id;
    const triggerId = payload.trigger_id;
    const actions = payload.actions || [];

    for (const action of actions) {
        const actionId = action.action_id;

        console.info("=== INTERACTIVE ACTION RECEIVED ===");
        console.info("Action ID:", actionId);
        console.info("Action Value:", action.selected_option?.value || action.value);
        console.info("User ID:", userId);
        console.info("Full Action Payload:", JSON.stringify(action, null, 2));

        // Handle "Add scheduled event" button
        if (actionId === "add_scheduled_event") {
            console.info("Opening Add Event modal for user:", userId);
            const modal = buildEventModal();
            await openModal(triggerId, modal);
            return;
        }

        // Handle overflow menu actions (Edit/Remove)
        if (actionId.startsWith("event_overflow_")) {
            const selectedValue = action.selected_option?.value;

            if (selectedValue?.startsWith("edit_")) {
                const eventId = selectedValue.replace("edit_", "");
                console.info("Opening Edit modal for event:", eventId);
                const existingEvent = await getEventById(eventId);
                if (existingEvent) {
                    const modal = buildEventModal(existingEvent);
                    await openModal(triggerId, modal);
                } else {
                    console.error("Event not found:", eventId);
                }
                return;
            }

            if (selectedValue?.startsWith("remove_")) {
                const eventId = selectedValue.replace("remove_", "");
                console.info("Removing event:", eventId);
                await deleteScheduledEvent(eventId);
                // Refresh the home view
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
    console.info("Callback ID:", callbackId);
    console.info("User ID:", userId);
    console.info("Raw Values:", JSON.stringify(values, null, 2));

    const parsedValues = parseModalValues(values);

    console.info("=== PARSED FORM VALUES ===");
    console.info("Start Date:", parsedValues.startDate);
    console.info("Start Time:", parsedValues.startTime);
    console.info("End Date:", parsedValues.endDate);
    console.info("End Time:", parsedValues.endTime);
    console.info("Status Type:", parsedValues.statusType);
    console.info("Status Type Display:", getStatusTypeText(parsedValues.statusType));
    console.info("Is Recurring:", parsedValues.isRecurring);
    console.info("Send Message:", parsedValues.sendMessage);
    console.info("Notification Channel:", parsedValues.sendMessage ? NOTIFICATION_CHANNEL : "N/A");

    // Determine if this is an add or edit operation
    let eventId;
    if (callbackId === "add_event") {
        eventId = generateEventId();
        console.info("Creating new event with ID:", eventId);
    } else if (callbackId.startsWith("edit_event_")) {
        eventId = callbackId.replace("edit_event_", "");
        console.info("Updating existing event with ID:", eventId);
    } else {
        console.error("Unknown callback_id:", callbackId);
        return;
    }

    // Build the event object
    const eventData = {
        id: eventId,
        userId: userId,
        ...parsedValues,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    console.info("=== EVENT DATA TO SAVE ===");
    console.info(JSON.stringify(eventData, null, 2));

    // Save to DynamoDB
    const success = await saveScheduledEvent(eventData);
    if (success) {
        console.info("Event saved successfully");
    } else {
        console.error("Failed to save event");
    }

    // Refresh the home view
    await publishHomeView(userId);
}

/**
 * Lambda handler for Slack Events API
 */
export const slackEventsHandler = async (event) => {
    console.info("Received Slack event:", JSON.stringify(event));

    // API Gateway often base64-encodes non-JSON payloads (like URL-encoded form data)
    let rawBody = event.body || "";
    if (event.isBase64Encoded) {
        rawBody = Buffer.from(rawBody, 'base64').toString('utf-8');
        console.info("Decoded base64 body");
    }

    // Check if this is an interactivity payload (URL-encoded form data)
    // API Gateway may send headers with various casings, so we need to check all possibilities
    const headers = event.headers || {};
    const contentType = headers["Content-Type"] || headers["content-type"] || headers["CONTENT-TYPE"] || "";

    console.info("Content-Type header:", contentType);
    console.info("All headers:", JSON.stringify(headers));

    if (contentType.includes("application/x-www-form-urlencoded") || rawBody.startsWith("payload=")) {
        // Parse URL-encoded payload
        const params = new URLSearchParams(rawBody);
        const payloadStr = params.get("payload");

        if (payloadStr) {
            let payload;
            try {
                payload = JSON.parse(payloadStr);
            } catch (err) {
                console.error("Failed to parse interactivity payload:", err);
                return {
                    statusCode: 400,
                    body: JSON.stringify({ error: "Invalid payload" })
                };
            }

            console.info("=== INTERACTIVITY PAYLOAD ===");
            console.info("Type:", payload.type);
            console.info("Full Payload:", JSON.stringify(payload, null, 2));

            // Handle block_actions (button clicks, overflow menu selections)
            if (payload.type === "block_actions") {
                try {
                    await handleInteractiveAction(payload);
                } catch (err) {
                    console.error("Error handling interactive action:", err);
                }
                return {
                    statusCode: 200,
                    body: ""
                };
            }

            // Handle view_submission (modal form submission)
            if (payload.type === "view_submission") {
                try {
                    await handleModalSubmission(payload);
                } catch (err) {
                    console.error("Error handling modal submission:", err);
                }
                // Return empty response to close the modal
                return {
                    statusCode: 200,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({})
                };
            }

            // Handle view_closed (modal closed without submission)
            if (payload.type === "view_closed") {
                console.info("Modal closed by user:", payload.user.id);
                return {
                    statusCode: 200,
                    body: ""
                };
            }
        }
    }

    // Handle JSON body (Events API)
    let body;
    try {
        body = JSON.parse(rawBody);
    } catch (err) {
        console.error("Failed to parse request body:", err);
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Invalid JSON body" })
        };
    }

    // Handle Slack URL verification challenge
    if (body.type === "url_verification") {
        console.info("Handling url_verification challenge");
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ challenge: body.challenge })
        };
    }

    // Handle event callbacks
    if (body.type === "event_callback") {
        const slackEvent = body.event;

        console.info("=== EVENT CALLBACK ===");
        console.info("Event Type:", slackEvent.type);
        console.info("Event Details:", JSON.stringify(slackEvent, null, 2));

        // Handle app_home_opened event
        if (slackEvent.type === "app_home_opened") {
            console.info(`app_home_opened by user: ${slackEvent.user}`);

            try {
                await publishHomeView(slackEvent.user);
                console.info("Successfully published home view");
            } catch (err) {
                console.error("Error publishing home view:", err);
                // Still return 200 to acknowledge the event to Slack
            }
        }
    }

    // Always respond with 200 to acknowledge receipt (within 3 seconds)
    return {
        statusCode: 200,
        body: ""
    };
};

