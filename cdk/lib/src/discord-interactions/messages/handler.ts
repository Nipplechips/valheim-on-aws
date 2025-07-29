import { SSMClient } from "@aws-sdk/client-ssm";
import { DiscordUtil } from "../../util";
import { sendDiscordMessage } from "./main";

const publicKey = process.env.DISCORD_APP_PUBLIC_KEY!;
const discordAppId = process.env.DISCORD_APP_ID!;
const appToken = process.env.DISCORD_APP_TOKEN!;
const discordMessageIdParamName = process.env.DISCORD_MESSAGE_ID_PARAM!;

const ssmClient = new SSMClient({});

export const discordMessagingHandler = async (event: any): Promise<any> => {

    const {state, ipAddress, dnsName} = event.detail;

    try {
       return await sendDiscordMessage({
           discordClient: new DiscordUtil(appToken),
           discordChannelId: "1397663670947020886",
           discordMessageIdParamName,
           serverState: state,
           dnsName,
           ipAddress,
           ssmClient,
       });
    } catch (error) {
        console.error(`DiscordCommandHandler`, error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: "Internal Server Error" })
        }
    }
}