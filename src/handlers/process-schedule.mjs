import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(client);
const tableName = process.env.SAMPLE_TABLE;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Format local date as YYYY-MM-DD (using en-CA locale)
function localDateString() {
    return new Date().toLocaleDateString('en-CA');
}

// Format hour as HH:00 (24-hour)
function localHourString() {
    const h = new Date().getHours();
    return String(h).padStart(2, '0') + ':00';
}

async function queryByIndex(indexName, dateKeyName, timeKeyName, dateValue, timeValue) {
    const items = [];
    let ExclusiveStartKey = undefined;

    do {
        const params = {
            TableName: tableName,
            IndexName: indexName,
            KeyConditionExpression: `${dateKeyName} = :d AND ${timeKeyName} = :t`,
            ExpressionAttributeValues: { ':d': dateValue, ':t': timeValue },
            ExclusiveStartKey,
        };

        const res = await ddbDocClient.send(new QueryCommand(params));
        if (res.Items) items.push(...res.Items);
        ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    return items;
}

export const processScheduleHandler = async (event) => {
    console.info('processScheduleHandler invoked', { event });

    const date = localDateString();
    const time = localHourString();

    console.info('Local date/time', { date, time });

    try {
        // Query StartDateStartTimeIndex
        console.info('Querying StartDateStartTimeIndex for', { date, time });
        const startItems = await queryByIndex('StartDateStartTimeIndex', 'startDate', 'startTime', date, time);
        console.info(`Found ${startItems.length} items on StartDateStartTimeIndex`);

        for (const it of startItems) {
            const id = it.id;
            if (!id) {
                console.warn('Index item missing id, skipping', it);
                continue;
            }
            const getRes = await ddbDocClient.send(new GetCommand({ TableName: tableName, Key: { id } }));
            console.info('Full item (start):', JSON.stringify(getRes.Item || getRes, null, 2));
            await sleep(1000);
        }

        // Query EndDateEndTimeIndex
        console.info('Querying EndDateEndTimeIndex for', { date, time });
        const endItems = await queryByIndex('EndDateEndTimeIndex', 'endDate', 'endTime', date, time);
        console.info(`Found ${endItems.length} items on EndDateEndTimeIndex`);

        for (const it of endItems) {
            const id = it.id;
            if (!id) {
                console.warn('Index item missing id, skipping', it);
                continue;
            }
            const getRes = await ddbDocClient.send(new GetCommand({ TableName: tableName, Key: { id } }));
            console.info('Full item (end):', JSON.stringify(getRes.Item || getRes, null, 2));
            await sleep(1000);
        }

        console.info('processScheduleHandler completed');
        return { statusCode: 200, body: 'Done' };
    } catch (err) {
        console.error('Error in processScheduleHandler:', err);
        return { statusCode: 500, body: String(err) };
    }
};

