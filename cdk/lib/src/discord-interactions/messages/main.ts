import { GetParameterCommand, ParameterType, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DiscordUtil } from "../../util";
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnits } from '@aws-lambda-powertools/metrics';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnits } from '@aws-lambda-powertools/metrics';

export async function sendDiscordMessage({ discordClient, discordChannelId, serverState, discordMessageIdParamName, ssmClient, ipAddress, dnsName, logger, metrics }: { discordClient: DiscordUtil; discordChannelId: string; serverState: string; discordMessageIdParamName: string; ssmClient: SSMClient; ipAddress?: string; dnsName?: string; logger: Logger; metrics: Metrics; }) {
    logger.info('Sending Discord message', { serverState, ipAddress, dnsName });
    
    let serverStatusMessageId;
    try {
        serverStatusMessageId = await ssmClient.send(new GetParameterCommand({
            Name: discordMessageIdParamName
        })).then(res => res.Parameter?.Value);
        logger.debug('Retrieved existing message ID', { messageId: serverStatusMessageId });
    } catch (error) {
        logger.warn('Cannot get existing Discord message id', { error });
    }

    switch (serverState) {
        case "shutting-down":
        case "terminated":
            logger.info('Sending server termination message');
            metrics.addMetric('ServerTerminationMessage', MetricUnits.Count, 1);
            
            await discordClient.sendChannelMessage({
                channelId: discordChannelId,
                components: DiscordUtil.components.gameServerLaunchedInfo({ ipAddress: undefined, dnsName: undefined, state: serverState })
            })
            break;

        default:
            if (serverStatusMessageId) {
                logger.info('Updating existing Discord message', { messageId: serverStatusMessageId });
                metrics.addMetric('MessageUpdated', MetricUnits.Count, 1);
                
                await discordClient.editChannelMessage({
                    channelId: discordChannelId,
                    messageId: serverStatusMessageId,
                    components: DiscordUtil.components.gameServerLaunchedInfo({ ipAddress, dnsName, state: serverState })
                });
            } else {
                logger.info('Creating new Discord message');
                metrics.addMetric('MessageCreated', MetricUnits.Count, 1);
                
                serverStatusMessageId = await discordClient.sendChannelMessage({
                    channelId: discordChannelId,
                    components: DiscordUtil.components.gameServerLaunchedInfo({ ipAddress, dnsName, state: serverState })
                });
                
                await ssmClient.send(new PutParameterCommand({
                    Name: discordMessageIdParamName,
                    Value: serverStatusMessageId,
                    Type: ParameterType.STRING,
                    Overwrite: true
                }));
                
                logger.debug('Stored new message ID', { messageId: serverStatusMessageId });
            }
            break;
    }
    
    logger.info('Discord message processing completed', { serverState });
}