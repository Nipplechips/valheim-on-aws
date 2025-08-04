import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { InteractionResponseType, InteractionType, verifyKey } from "discord-interactions";
import { handleDiscordCommand, handleDiscordMessageInteraction } from "./main";
import { AutoScalingClient } from "@aws-sdk/client-auto-scaling";
import { SSMClient } from "@aws-sdk/client-ssm";
import { BotInteraction } from "../../util";
import type { LambdaInterface } from '@aws-lambda-powertools/commons/types';

const logger = new Logger({ serviceName: 'discord-interactions' });
const metrics = new Metrics({ namespace: 'Valheim/Discord', serviceName: 'discord-interactions' });
const tracer = new Tracer({ serviceName: 'discord-interactions' });

const ssmClient = tracer.captureAWSv3Client(new SSMClient({}));
const autoscalingClient = tracer.captureAWSv3Client(new AutoScalingClient({}));

const publicKey = `${process.env.DISCORD_APP_PUBLIC_KEY!}`;
const asgName = process.env.ASG_NAME!;
const launchArgumentsParameterName: string = process.env.LAUNCH_ARGS_PARAM_NAME!;
const discordMessageIdParameterName: string = process.env.DISCORD_MESSAGE_ID_PARAM_NAME!;

export const discordBotPingHandler = async (event: any, context: any) => {
    const signature = event.headers['x-signature-ed25519'];
    const timestamp = event.headers['x-signature-timestamp'];
    const body = event.body!;

    console.info(`signature`, signature)
    console.info(`timestamp`, timestamp)
    console.info(`key`, publicKey)

    if (!signature) {
        throw new Error('Missing signature');
    }
    if (!timestamp) {
        throw new Error('Missing timestamp');
    }

    const isValid = await verifyKey(body, signature, timestamp, publicKey);
    if (!isValid) {
        logger.error('Failed to verify Discord signature');
        metrics.addMetric('AuthenticationFailure', MetricUnit.Count, 1);
        return {
            statusCode: 401,
            body: JSON.stringify({ message: "Invalid Key" })
        }
    }

    const interaction = JSON.parse(body);
    logger.info(`Interaction`, interaction)
    if (interaction.type === InteractionType.PING) {
        logger.debug(`Ping received`);
        metrics.addMetric('PingReceived', MetricUnit.Count, 1);
        return JSON.stringify({ type: InteractionResponseType.PONG });
    }

    return {
        statusCode: 200,
        body: JSON.stringify({ message: "Hello World" })
    }
};


class DiscordBotHandler implements LambdaInterface {
    @tracer.captureLambdaHandler()
    @logger.injectLambdaContext()
    @metrics.logMetrics()
    public async handler(event: any, context: unknown): Promise<any> {
        try {
            const signature = event.headers['x-signature-ed25519'];
            const timestamp = event.headers['x-signature-timestamp'];
            const body = event.body!;

            if (!signature) {
                metrics.addMetric('ValidationError', MetricUnit.Count, 1);
                throw new Error('Missing signature');
            }
            if (!timestamp) {
                metrics.addMetric('ValidationError', MetricUnit.Count, 1);
                throw new Error('Missing timestamp');
            }

            const isValid = await verifyKey(body, signature, timestamp, publicKey);
            if (!isValid) {
                logger.error('Failed to verify Discord signature');
                metrics.addMetric('AuthenticationFailure', MetricUnit.Count, 1);
                return {
                    statusCode: 401,
                    body: JSON.stringify({ message: "Invalid Key" })
                }
            }

            const interaction = JSON.parse(body);
            let response;

            switch (interaction.type) {
                case InteractionType.PING:
                    metrics.addMetric('PingReceived', MetricUnit.Count, 1);
                    return JSON.stringify({ type: InteractionResponseType.PONG });

                case InteractionType.APPLICATION_COMMAND:
                    logger.debug('Processing application command', { command: interaction.data.name });
                    metrics.addMetric('CommandReceived', MetricUnit.Count, 1);
                    response = await handleDiscordCommand({
                        autoscalingClient,
                        ssmClient,
                        asgName,
                        command: interaction.data.name,
                        discordMessageIdParameterName,
                        logger,
                        metrics
                    });
                    break;

                case InteractionType.MESSAGE_COMPONENT:
                    logger.debug('Processing message component', { customId: interaction.data.custom_id });
                    metrics.addMetric('ComponentInteraction', MetricUnit.Count, 1);
                    response = await handleDiscordMessageInteraction({
                        autoscalingClient,
                        ssmClient,
                        asgName,
                        interaction: interaction.data.custom_id,
                        launchArguments: BotInteraction.START_SERVER_CHORES ? "-modifier raids none" : "",
                        launchArgumentsParameterName,
                        discordMessageIdParameterName,
                        logger,
                        metrics
                    });
                    break;

                default:
                    logger.warn('Unknown interaction type received', { type: interaction?.type });
                    metrics.addMetric('UnknownInteraction', MetricUnit.Count, 1);
                    response = {
                        statusCode: 400,
                        body: JSON.stringify({ message: `Unknown interaction type: ${interaction?.type}` })
                    }
                    break;
            }

            console.info(`RESPONSE:`, response);
            return response;
        } catch (error) {
            logger.error('Discord handler error', { error });
            metrics.addMetric('HandlerError', MetricUnit.Count, 1);
            return {
                statusCode: 500,
                body: JSON.stringify({ message: "Internal Server Error" })
            }
        }
    }
}

const handlerInstance = new DiscordBotHandler();
export const discordBotHandler = handlerInstance.handler.bind(handlerInstance);