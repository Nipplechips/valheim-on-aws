import { AutoScalingClient, SetDesiredCapacityCommand } from "@aws-sdk/client-auto-scaling";
import { BotCommand, BotInteraction, DiscordUtil } from "../../util";
import { DeleteParameterCommand, ParameterType, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { MessageComponentTypes } from "discord-interactions";

export async function handleDiscordCommand({ command, discordMessageIdParameterName, autoscalingClient, ssmClient, asgName }: { command: BotCommand; discordMessageIdParameterName: string; autoscalingClient: AutoScalingClient; ssmClient: SSMClient; asgName: string; }) {
    console.log(`Handling command: ${command}`);

    switch (command) {
        case BotCommand.REQUEST:
            return DiscordUtil.componentResponse(DiscordUtil.components.REQUEST_SERVER_COMMAND_RESPONSE);

        case 'stop':
            await ssmClient.send(new DeleteParameterCommand({
                Name: discordMessageIdParameterName
            })).catch((err) => console.error('ssm param error', err));
            await autoscalingClient.send(new SetDesiredCapacityCommand({
                AutoScalingGroupName: asgName,
                DesiredCapacity: 0,
                HonorCooldown: false
            }));
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
            return DiscordUtil.componentResponse(DiscordUtil.components.unknownCommandResponse(command));
    }
}

export async function handleDiscordMessageInteraction({ interaction, launchArguments, launchArgumentsParameterName, discordMessageIdParameterName, ssmClient, autoscalingClient, asgName }: { launchArgumentsParameterName: string; discordMessageIdParameterName:string; interaction: BotInteraction; launchArguments: string; ssmClient: SSMClient; autoscalingClient: AutoScalingClient; asgName: string; }) {
    switch (interaction) {
        case BotInteraction.START_SERVER_CHORES:
        case BotInteraction.START_SERVER_NORMAL:
            try {
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

                return DiscordUtil.interactionResponse(`Ok, ill go make one. Ill send you a message when its ready`);
            } catch (error: any) {
                console.error("Error in scale-up request", error);
                return DiscordUtil.interactionResponse(`### No games for you!\n${error.message}`);
            }
            break;

        case BotInteraction.STOP_SERVER:
            try {
                await ssmClient.send(new DeleteParameterCommand({
                    Name: discordMessageIdParameterName
                })).catch((err) => console.error('ssm param error', err));
                await autoscalingClient.send(new SetDesiredCapacityCommand({
                    AutoScalingGroupName: asgName,
                    DesiredCapacity: 0,
                    HonorCooldown: false
                }));
                return DiscordUtil.interactionResponse(`Ok, ill stop the server`);
            } catch (error: any) {
                console.error("Error in scale-up request", error);
                return DiscordUtil.interactionResponse(`### Cant stop server!\n${error.message}`);
            }
    }
}