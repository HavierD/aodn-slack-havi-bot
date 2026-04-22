import { jest } from '@jest/globals';
import { slackEventsHandler } from '../../../src/handlers/slack-events.mjs';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('Test slackEventsHandler', () => {

    beforeEach(() => {
        // Mock fetch globally
        global.fetch = jest.fn();
        // Reset DynamoDB mock
        ddbMock.reset();
        // Mock empty events for home view
        ddbMock.on(ScanCommand).resolves({
            Items: []
        });
    });

    afterEach(() => {
        jest.resetAllMocks();
    });

    it('should handle url_verification challenge', async () => {
        const event = {
            headers: { 'Content-Type': 'application/json' },
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
            headers: { 'Content-Type': 'application/json' },
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
                    'Content-Type': 'application/json; charset=utf-8'
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
            headers: { 'Content-Type': 'application/json' },
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
            headers: { 'Content-Type': 'application/json' },
            body: 'invalid-json'
        };

        const result = await slackEventsHandler(event);

        expect(result.statusCode).toBe(400);
    });

    it('should handle add_scheduled_event button click', async () => {
        // Mock successful Slack modal open
        global.fetch.mockResolvedValueOnce({
            json: async () => ({ ok: true })
        });

        const payload = {
            type: 'block_actions',
            user: { id: 'U1234567890' },
            trigger_id: '123456.789012.abcdef',
            actions: [{ action_id: 'add_scheduled_event', type: 'button' }]
        };

        const event = {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `payload=${encodeURIComponent(JSON.stringify(payload))}`
        };

        const result = await slackEventsHandler(event);

        expect(result.statusCode).toBe(200);
        expect(global.fetch).toHaveBeenCalledWith(
            'https://slack.com/api/views.open',
            expect.objectContaining({
                method: 'POST'
            })
        );
    });

    it('should handle modal submission for adding event', async () => {
        // Mock successful DynamoDB put
        ddbMock.on(PutCommand).resolves({});
        // Mock successful home view publish
        global.fetch.mockResolvedValueOnce({
            json: async () => ({ ok: true })
        });

        const payload = {
            type: 'view_submission',
            user: { id: 'U1234567890' },
            view: {
                callback_id: 'add_event',
                state: {
                    values: {
                        start_date_block: { start_date: { selected_date: '2026-04-20' } },
                        start_time_block: { start_time: { selected_time: '09:00' } },
                        end_date_block: { end_date: { selected_date: '2026-04-20' } },
                        end_time_block: { end_time: { selected_time: '17:00' } },
                        status_type_block: { status_type: { selected_option: { value: 'working_remotely' } } },
                        is_recurring_block: { is_recurring: { selected_option: { value: 'one_time' } } },
                        send_message_block: { send_message: { selected_options: [{ value: 'send_message' }] } }
                    }
                }
            }
        };

        const event = {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `payload=${encodeURIComponent(JSON.stringify(payload))}`
        };

        const result = await slackEventsHandler(event);

        expect(result.statusCode).toBe(200);
    });

    it('should handle remove event action', async () => {
        // Mock successful DynamoDB delete
        ddbMock.on(DeleteCommand).resolves({});
        // Mock successful home view publish
        global.fetch.mockResolvedValueOnce({
            json: async () => ({ ok: true })
        });

        const payload = {
            type: 'block_actions',
            user: { id: 'U1234567890' },
            trigger_id: '123456.789012.abcdef',
            actions: [{
                action_id: 'event_overflow_evt_123',
                selected_option: { value: 'remove_evt_123' }
            }]
        };

        const event = {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `payload=${encodeURIComponent(JSON.stringify(payload))}`
        };

        const result = await slackEventsHandler(event);

        expect(result.statusCode).toBe(200);
    });

    it('should handle edit event action', async () => {
        // Mock existing event in DynamoDB
        ddbMock.on(GetCommand).resolves({
            Item: {
                id: 'evt_123',
                userId: 'U1234567890',
                startDate: '2026-04-20',
                startTime: '09:00',
                endDate: '2026-04-20',
                endTime: '17:00',
                statusType: 'working_remotely',
                isRecurring: false,
                sendMessage: true
            }
        });
        // Mock successful modal open
        global.fetch.mockResolvedValueOnce({
            json: async () => ({ ok: true })
        });

        const payload = {
            type: 'block_actions',
            user: { id: 'U1234567890' },
            trigger_id: '123456.789012.abcdef',
            actions: [{
                action_id: 'event_overflow_evt_123',
                selected_option: { value: 'edit_evt_123' }
            }]
        };

        const event = {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `payload=${encodeURIComponent(JSON.stringify(payload))}`
        };

        const result = await slackEventsHandler(event);

        expect(result.statusCode).toBe(200);
        expect(global.fetch).toHaveBeenCalledWith(
            'https://slack.com/api/views.open',
            expect.objectContaining({
                method: 'POST'
            })
        );
    });
});
