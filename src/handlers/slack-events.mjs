// Slack Events API handler for app_home_opened event

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
/**
 * Publishes an App Home view to Slack
 */
async function publishHomeView(userId) {
    const homeView = {
        type: "home",
        blocks: [
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
                    text: "This is your App Home. More features coming soon!"
                }
            }
        ]
    };

    const response = await fetch("https://slack.com/api/views.publish", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
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
        throw new Error(`Slack API error: ${result.error}`);
    }

    return result;
}

/**
 * Lambda handler for Slack Events API
 */
export const slackEventsHandler = async (event) => {
    console.info("Received Slack event:", JSON.stringify(event));

    let body;
    try {
        body = JSON.parse(event.body);
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


