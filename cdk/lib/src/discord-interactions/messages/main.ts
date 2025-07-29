import { GetParameterCommand, ParameterType, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DiscordUtil } from "../../util";

export async function sendDiscordMessage({ discordClient, discordChannelId, serverState, discordMessageIdParamName, ssmClient, ipAddress, dnsName }: { discordClient: DiscordUtil; discordChannelId: string; serverState: string; discordMessageIdParamName: string; ssmClient: SSMClient; ipAddress?: string; dnsName?: string; }) {
    let serverStatusMessageId;
    try {
        serverStatusMessageId = await ssmClient.send(new GetParameterCommand({
            Name: discordMessageIdParamName
        })).then(res => res.Parameter?.Value);
    } catch (error) {
        console.error(`Cannot get existing Discord message id`, error);
    }

    switch (serverState) {
        case "shutting-down":
        case "terminated":
            await discordClient.sendChannelMessage({
                channelId: discordChannelId,
                components: DiscordUtil.components.gameServerLaunchedInfo({ ipAddress: undefined, dnsName: undefined, state: serverState })
            })
            break;

        default:
            if (serverStatusMessageId) {
                await discordClient.editChannelMessage({
                    channelId: discordChannelId,
                    messageId: serverStatusMessageId,
                    components: DiscordUtil.components.gameServerLaunchedInfo({ ipAddress, dnsName, state: serverState })
                });
            } else {
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
            }
            break;

    }
}