import { InteractionResponseType, InteractionType, verifyKey } from "discord-interactions";
import { handleDiscordCommand, handleDiscordMessageInteraction } from "./main";
import { AutoScalingClient } from "@aws-sdk/client-auto-scaling";
import { SSMClient } from "@aws-sdk/client-ssm";
import { BotCommand, BotInteraction } from "../../util";

const ssmClient = new SSMClient({});
const autoscalingClient = new AutoScalingClient({});

const publicKey = process.env.DISCORD_APP_PUBLIC_KEY!;
const asgName = process.env.ASG_NAME!;
const launchArgumentsParameterName: string = process.env.LAUNCH_ARGS_PARAM_NAME!;
const discordMessageIdParameterName: string = process.env.DISCORD_MESSAGE_ID_PARAM_NAME!;

export const discordBotHandler = async (event: any): Promise<any> => {
    try {
        const signature = event.headers['x-signature-ed25519'];
        const timestamp = event.headers['x-signature-timestamp'];
        const body = event.body!;

        if (!signature) {
            throw new Error('Missing signature');
        }
        if (!timestamp) {
            throw new Error('Missing timestamp');
        }

        const isValid = await verifyKey(body, signature, timestamp, publicKey);
        if (!isValid) {
            console.error("Failed to verify key!");
            return {
                statusCode: 401,
                body: JSON.stringify({ message: "Invalid Key" })
            }
        }

        const interaction = JSON.parse(body);

        switch (interaction.type) {
            case InteractionType.PING:
                return JSON.stringify({ type: InteractionResponseType.PONG });

            case InteractionType.APPLICATION_COMMAND:
                // Respond to command
                console.debug(`COMMAND:`, interaction);
                return await handleDiscordCommand({
                    autoscalingClient,
                    ssmClient,
                    asgName,
                    command: interaction.data.name,
                    discordMessageIdParameterName
                });

            case InteractionType.MESSAGE_COMPONENT:
                console.debug(`MESSAGE:`, interaction);
                // Respond to component interaction
                return await handleDiscordMessageInteraction({
                    autoscalingClient,
                    ssmClient,
                    asgName,
                    interaction: interaction.data.custom_id,
                    launchArguments: BotInteraction.START_SERVER_CHORES ? "-modifier raids none" : "",
                    launchArgumentsParameterName,
                    discordMessageIdParameterName
                });

            default:
                return {
                    statusCode: 400,
                    body: JSON.stringify({ message: `Unknown interaction type: ${interaction?.type}` })
                }
        }
    } catch (error) {
        console.error(`DiscordCommandHandler`, error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: "Internal Server Error" })
        }
    }
}