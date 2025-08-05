import { InteractionResponseType, InteractionResponseFlags, ButtonStyleTypes, MessageComponentTypes, SeparatorSpacingTypes } from 'discord-interactions';
import 'dotenv/config';
import axios from 'axios';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'discord-util' });

export enum BotCommand {
  REQUEST = "request",
  STATUS = "status",
  STOP = "stop",
};
export enum BotInteraction {
  START_SERVER_NORMAL = "server_config_normal",
  START_SERVER_CHORES = "server_config_chores",
  STOP_SERVER = "stop"
}

export function capitalize(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export class DiscordUtil {
  private readonly DISCORD_ENDPOINT = "https://discord.com/api/v10";
  private DISCORD_HEADERS: Record<string, string>;

  static components = {
    REQUEST_SERVER_COMMAND_RESPONSE: [
      {
        type: MessageComponentTypes.CONTAINER,
        components: [
          {
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: "## Launch options"
          },
          {
            type: MessageComponentTypes.SEPARATOR,
            spacing: SeparatorSpacingTypes.LARGE
          },
          {
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: "Chores mode has encounters disabled"
          },
          {
            type: MessageComponentTypes.ACTION_ROW,
            components: [
              {
                type: MessageComponentTypes.BUTTON,
                label: "Normal",
                custom_id: "server_config_normal",
                style: ButtonStyleTypes.PRIMARY,
                emoji: {
                  name: "<:troll:1097082989491535963>",
                  id: "1097082989491535963"
                }
              },
              {
                type: MessageComponentTypes.BUTTON,
                label: "🧹 Chores",
                custom_id: "server_config_chores",
                style: ButtonStyleTypes.SECONDARY
              }
            ]
          }
        ]
      }
    ],
    gameServerLaunchedInfo: ({ ipAddress, dnsName, state }: { ipAddress?: string, dnsName?: string, state: string }) => {

      logger.debug('Generating server launch info component', { ipAddress, dnsName, state });
      const stage = `${state}`.toLowerCase();

      const steps: Record<string, string> = {
        pending: "🕧 Bid for server\n◻ Launching server\n◻ Downloading Valheim\n◻ Installing Valheim\n◻ Restoring World\n◻ Launching Game",
        running: "✅ Bid for server\n🕐 Launching server\n◻ Downloading Valheim\n◻ Installing Valheim\n◻ Restoring World\n◻ Launching Game",
        provisioned: "✅ Bid for server\n✅ Launching server\n🕜 Downloading Valheim\n◻ Installing Valheim\n◻ Restoring World\n◻ Launching Game",
        steam_installed: "✅ Bid for server\n✅ Launching server\n✅ Downloading Valheim\n🕑 Installing Valheim\n◻ Restoring World\n◻ Launching Game",
        installed: "✅ Bid for server\n✅ Launching server\n✅ Downloading Valheim\n✅ Installing Valheim\n🕝 Restoring World\n◻ Launching Game",
        world_restored: "✅ Bid for server\n✅ Launching server\n✅ Downloading Valheim\n✅ Installing Valheim\n✅ Restoring World\n🕒 Launching Game",
        started: "✅ Bid for server\n✅ Launching server\n✅ Downloading Valheim\n✅ Installing Valheim\n✅ Restoring World\n✅ Launching Game",
        stopping: "stopping",
        stopped: "stopped"
      };

      const server_status_map = new Map<string, string>();
      server_status_map.set("provisioned", "🟠");
      server_status_map.set("running", "🟠");
      server_status_map.set("steam_installed", "🟠");
      server_status_map.set("installed", "🟡");
      server_status_map.set("world_restored", "🟡");
      server_status_map.set("started", "🟢");

      const title = [
        `# Game Server ${server_status_map.get(stage) ?? "⚫️"}`,
        `${ipAddress ? `\`\`\`${ipAddress}\`\`\`` : ``}`
      ].join("\n");

      const launchAction = ipAddress ? `steam://run/892970//+connect ${ipAddress}:2456 +password hello123` : ``
      const actionList: { type: MessageComponentTypes, components: any[] } = {
        type: MessageComponentTypes.ACTION_ROW,
        components: [
          {
            type: MessageComponentTypes.BUTTON,
            label: "Stop",
            style: ButtonStyleTypes.DANGER,
            custom_id: "stop_server"
          }
        ]
      }

      if (dnsName && [
        "provisioned",
        "steam_installed",
        "installed",
        "world_restored",
        "started"
      ].includes(stage)) {
        actionList.components.push({
          type: MessageComponentTypes.BUTTON,
          label: "📈 Monitor",
          style: ButtonStyleTypes.LINK,
          url: `http://${dnsName}:19999`
        })
      }

      return [
        {
          type: MessageComponentTypes.CONTAINER,
          components: [
            {
              "type": MessageComponentTypes.SECTION,
              "components": [
                {
                  "type": MessageComponentTypes.TEXT_DISPLAY,
                  "content": `${title}`
                },
                {
                  "type": MessageComponentTypes.TEXT_DISPLAY,
                  "content": `### 🤖 ${state}`
                },
                {
                  "type": MessageComponentTypes.TEXT_DISPLAY,
                  "content": `${steps[stage] ?? ''}\n${launchAction}`
                }
              ],
              "accessory": {
                "type": 11,
                "media": {
                  "url": "https://i.pinimg.com/736x/8c/11/ad/8c11ad41159a2404b34a618a0101df59.jpg"
                }
              }
            },
            actionList
          ]
        }
      ]
    },
    unknownCommandResponse: (command: string) => [
      {
        type: MessageComponentTypes.CONTAINER,
        components: [
          {
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: `## Unknown command: \`${command}\``
          }
        ]
      }
    ],
  }

  constructor(appToken: string) {
    if(!appToken || `${appToken}`.length < 1){
      throw Error("Cannot accept empty token");
    }
    this.DISCORD_HEADERS = {
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': 'JDojo (https://github.com/discord/discord-example-app, 1.0.0)',
      'Authorization': `Bot ${appToken}`
    };
  }

  static componentResponse(components: any[]) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.IS_COMPONENTS_V2,
        components
      },
    }
  }
  static interactionResponse(message: string) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: `${message}`
      }
    }
  }

  public async editChannelMessage({ channelId, messageId, components }: { channelId: string; messageId: string; components: any[]; }) {

    try {
      const response = await axios.patch(`${this.DISCORD_ENDPOINT}/channels/${channelId}/messages/${messageId}`, {
        flags: InteractionResponseFlags.IS_COMPONENTS_V2,
        components
      }, {
        headers: this.DISCORD_HEADERS
      });
      logger.info('Discord channel message updated', { messageId: response.data?.id });
      return;
    } catch (error: any) {
      if (error.response) {
        logger.error('Discord API error response', {
          data: error.response.data,
          status: error.response.status,
          headers: error.response.headers
        });
      } else if (error.request) {
        logger.error('Discord API request error', { request: error.request });
      } else {
        logger.error('Unknown Discord API error', { message: error.message });
      }
      logger.debug('Request config', { config: error.config });
    }
  }
  public async sendChannelMessage({ channelId, components }: { channelId: string; components: any[]; }) {
    try {
      const response = await axios.post(`${this.DISCORD_ENDPOINT}/channels/${channelId}/messages`, {
        flags: InteractionResponseFlags.IS_COMPONENTS_V2,
        components
      }, {
        headers: this.DISCORD_HEADERS
      });

      logger.info('Discord channel message sent', { messageId: response.data?.id });
      return response.data?.id;

    } catch (error: any) {
      if (error.response) {
        logger.error('Discord API error response', {
          data: error.response.data,
          status: error.response.status,
          headers: error.response.headers
        });
      } else if (error.request) {
        logger.error('Discord API request error', { request: error.request });
      } else {
        logger.error('Discord API error', { message: error.message });
      }
      logger.debug('Request config', { config: error.config });
    }
  }
}
