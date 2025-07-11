"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_ec2_1 = require("@aws-sdk/client-ec2");
const discord_interactions_1 = require("discord-interactions");
const ec2Client = new client_ec2_1.EC2Client({});
const publicKey = process.env.DISCORD_APP_PUBLIC_KEY;
const instanceId = process.env.INSTANCE_ID;
const handler = async (event, context) => {
    console.log('EVENT:', JSON.stringify(event));
    try {
        // Verify Discord signature
        const signature = event.headers['x-signature-ed25519'];
        const timestamp = event.headers['x-signature-timestamp'];
        const body = event.body || '';
        if (!(0, discord_interactions_1.verifyKey)(publicKey, signature, timestamp, body)) {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'Invalid signature' })
            };
        }
        const requestBody = JSON.parse(body);
        console.log('BODY:', requestBody);
        // Handle Discord ping
        if (requestBody.type === discord_interactions_1.InteractionType.PING) {
            console.log('Ping detected, returning type 1');
            return {
                statusCode: 200,
                body: JSON.stringify({ type: discord_interactions_1.InteractionResponseType.PONG })
            };
        }
        // Parse command options
        const options = requestBody.data?.options || [];
        if (!options.length || !options[0].value) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Invalid JSON structure' })
            };
        }
        const action = options[0].value;
        let message;
        // Perform EC2 actions
        switch (action) {
            case 'start':
                await ec2Client.send(new client_ec2_1.StartInstancesCommand({ InstanceIds: [instanceId] }));
                message = 'Instance starting';
                break;
            case 'stop':
                await ec2Client.send(new client_ec2_1.StopInstancesCommand({ InstanceIds: [instanceId] }));
                message = 'Instance stopping';
                break;
            case 'status':
                const response = await ec2Client.send(new client_ec2_1.DescribeInstancesCommand({ InstanceIds: [instanceId] }));
                const state = response.Reservations?.[0]?.Instances?.[0]?.State?.Name || 'unknown';
                message = `Server status: [ ${state} ]`;
                break;
            default:
                return {
                    statusCode: 400,
                    body: JSON.stringify({ error: "Invalid action. Use 'start', 'stop', or 'status'." })
                };
        }
        console.log('Returning message:', message);
        return {
            statusCode: 200,
            body: JSON.stringify({
                type: discord_interactions_1.InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                data: {
                    tts: false,
                    content: message,
                    embeds: [],
                    allowed_mentions: { parse: [] }
                }
            })
        };
    }
    catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal server error' })
        };
    }
};
exports.handler = handler;
