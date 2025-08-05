import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DiscordUtil } from "../../util";
import { sendDiscordMessage } from "./main";

const logger = new Logger({ serviceName: 'discord-messaging' });
const metrics = new Metrics({ namespace: 'Valheim/Discord', serviceName: 'discord-messaging' });
const tracer = new Tracer({ serviceName: 'discord-messaging' });

let appToken: string | undefined;
const discordMessageIdParamName = process.env.DISCORD_MESSAGE_ID_PARAM!;

const ssmClient = tracer.captureAWSv3Client(new SSMClient({}));

class DiscordMessagingHandler {
    @tracer.captureLambdaHandler()
    @logger.injectLambdaContext()
    @metrics.logMetrics()
    public async handler(event: any, context: unknown): Promise<any> {
        const { state, ipAddress, dnsName } = event.detail;

        logger.info('Processing Discord message event', { state, ipAddress, dnsName });
        metrics.addMetric('MessageEventReceived', MetricUnit.Count, 1);

        if (!appToken) {
            logger.debug('Decoding public key');
            const publicKeyResponse = await ssmClient.send(new GetParameterCommand({
                Name: `${process.env.DISCORD_APP_TOKEN_PARAM}`,
                WithDecryption: true
            }));
            appToken = publicKeyResponse.Parameter?.Value
        }

        try {
            return await sendDiscordMessage({
                discordClient: new DiscordUtil(appToken!),
                discordChannelId: "1397663670947020886",
                discordMessageIdParamName,
                serverState: state,
                dnsName,
                ipAddress,
                ssmClient,
                logger,
                metrics
            });
        } catch (error) {
            logger.error('Discord messaging handler error', { error, state });
            metrics.addMetric('MessageHandlerError', MetricUnit.Count, 1);
            return {
                statusCode: 500,
                body: JSON.stringify({ message: "Internal Server Error" })
            }
        }
    }
}

const handlerInstance = new DiscordMessagingHandler();
export const discordMessagingHandler = handlerInstance.handler.bind(handlerInstance);