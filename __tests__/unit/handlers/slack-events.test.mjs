import { slackEventsHandler } from '../../../src/handlers/slack-events.mjs';

describe('Test slackEventsHandler', () => {

    beforeEach(() => {
        // Mock fetch globally
        global.fetch = jest.fn();
    });

    afterEach(() => {
        jest.resetAllMocks();
    });

    it('should handle url_verification challenge', async () => {
        const event = {
            body: JSON.stringify({
                type: 'url_verification',
                challenge: 'test-challenge-12345'
            })
        };

        const result = await slackEventsHandler(event);

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        expect(body.challenge).toBe('test-challenge-12345');
    });

    it('should handle app_home_opened event', async () => {
        // Mock successful Slack API response
        global.fetch.mockResolvedValueOnce({
            json: async () => ({ ok: true })
        });

        const event = {
            body: JSON.stringify({
                type: 'event_callback',
                event: {
                    type: 'app_home_opened',
                    user: 'U1234567890',
                    channel: 'D1234567890',
                    tab: 'home'
                }
            })
        };

        const result = await slackEventsHandler(event);

        expect(result.statusCode).toBe(200);
        expect(global.fetch).toHaveBeenCalledWith(
            'https://slack.com/api/views.publish',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Content-Type': 'application/json'
                })
            })
        );
    });

    it('should return 200 even if Slack API fails', async () => {
        // Mock failed Slack API response
        global.fetch.mockResolvedValueOnce({
            json: async () => ({ ok: false, error: 'invalid_token' })
        });

        const event = {
            body: JSON.stringify({
                type: 'event_callback',
                event: {
                    type: 'app_home_opened',
                    user: 'U1234567890'
                }
            })
        };

        const result = await slackEventsHandler(event);

        // Should still return 200 to acknowledge the event
        expect(result.statusCode).toBe(200);
    });

    it('should return 400 for invalid JSON body', async () => {
        const event = {
            body: 'invalid-json'
        };

        const result = await slackEventsHandler(event);

        expect(result.statusCode).toBe(400);
    });
});

