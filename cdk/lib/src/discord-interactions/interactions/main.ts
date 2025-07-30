import { AutoScalingClient, SetDesiredCapacityCommand } from "@aws-sdk/client-auto-scaling";
import { BotCommand, BotInteraction, DiscordUtil } from "../../util";
import { DeleteParameterCommand, ParameterType, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { MessageComponentTypes } from "discord-interactions";
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';


export async function handleDiscordCommand({ command, discordMessageIdParameterName, autoscalingClient, ssmClient, asgName, logger, metrics }: { command: BotCommand; discordMessageIdParameterName: string; autoscalingClient: AutoScalingClient; ssmClient: SSMClient; asgName: string; logger: Logger; metrics: Metrics; }) {
    logger.info('Handling Discord command', { command });

    switch (command) {
        case BotCommand.REQUEST:
            metrics.addMetric('ServerRequested', MetricUnit.Count, 1);
            return DiscordUtil.componentResponse(DiscordUtil.components.REQUEST_SERVER_COMMAND_RESPONSE);

        case 'stop':
            logger.info('Processing server stop command');
            metrics.addMetric('ServerStopRequested', MetricUnit.Count, 1);
            
            await ssmClient.send(new DeleteParameterCommand({
                Name: discordMessageIdParameterName
            })).catch((err) => logger.error('Failed to delete SSM parameter', { error: err }));
            
            await autoscalingClient.send(new SetDesiredCapacityCommand({
                AutoScalingGroupName: asgName,
                DesiredCapacity: 0,
                HonorCooldown: false
            }));
            
            logger.info('Server stop command completed');
            return DiscordUtil.componentResponse([{
                type: MessageComponentTypes.CONTAINER,
                components: [
                    {
                        type: MessageComponentTypes.TEXT_DISPLAY,
                        content: "Server Stopped!"
                    }
                ]
            }]);

        default:
            logger.warn('Unknown command received', { command });
            metrics.addMetric('UnknownCommand', MetricUnit.Count, 1);
            return DiscordUtil.componentResponse(DiscordUtil.components.unknownCommandResponse(command));
    }
}

export async function handleDiscordMessageInteraction({ interaction, launchArguments, launchArgumentsParameterName, discordMessageIdParameterName, ssmClient, autoscalingClient, asgName, logger, metrics }: { launchArgumentsParameterName: string; discordMessageIdParameterName:string; interaction: BotInteraction; launchArguments: string; ssmClient: SSMClient; autoscalingClient: AutoScalingClient; asgName: string; logger: Logger; metrics: Metrics; }) {
    logger.info('Handling Discord message interaction', { interaction });
    
    switch (interaction) {
        case BotInteraction.START_SERVER_CHORES:
        case BotInteraction.START_SERVER_NORMAL:
            try {
                logger.info('Starting server scale-up', { mode: interaction });
                metrics.addMetric('ServerStartRequested', MetricUnit.Count, 1);
                
                await autoscalingClient.send(new SetDesiredCapacityCommand({
                    AutoScalingGroupName: asgName,
                    DesiredCapacity: 1,
                    HonorCooldown: false
                }));

                await ssmClient.send(new PutParameterCommand({
                    Name: launchArgumentsParameterName,
                    Value: launchArguments,
                    Type: ParameterType.STRING,
                    Overwrite: true
                }));

                logger.info('Server start request completed successfully');
                metrics.addMetric('ServerStartSuccess', MetricUnit.Count, 1);
                return DiscordUtil.interactionResponse(`Ok, ill go make one. Ill send you a message when its ready`);
            } catch (error: any) {
                logger.error('Failed to start server', { error, interaction });
                metrics.addMetric('ServerStartFailure', MetricUnit.Count, 1);
                return DiscordUtil.interactionResponse(`### No games for you!\n${error.message}`);
            }
            break;

        case BotInteraction.STOP_SERVER:
            try {
                logger.info('Processing server stop via interaction');
                metrics.addMetric('ServerStopViaInteraction', MetricUnit.Count, 1);
                
                await ssmClient.send(new DeleteParameterCommand({
                    Name: discordMessageIdParameterName
                })).catch((err) => logger.error('Failed to delete SSM parameter', { error: err }));
                
                await autoscalingClient.send(new SetDesiredCapacityCommand({
                    AutoScalingGroupName: asgName,
                    DesiredCapacity: 0,
                    HonorCooldown: false
                }));
                
                logger.info('Server stop via interaction completed');
                return DiscordUtil.interactionResponse(`Ok, ill stop the server`);
            } catch (error: any) {
                logger.error('Failed to stop server via interaction', { error });
                metrics.addMetric('ServerStopFailure', MetricUnit.Count, 1);
                return DiscordUtil.interactionResponse(`### Cant stop server!\n${error.message}`);
            }
    }
}