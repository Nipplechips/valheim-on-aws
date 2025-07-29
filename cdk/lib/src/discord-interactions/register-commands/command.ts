import fetch from "node-fetch";
import { capitalize, BOT_COMMANDS } from "../../util"

async function DiscordRequest(endpoint: string, options: Record<string, any>) {
    // append endpoint to root API URL
    const url = 'https://discord.com/api/v10/' + endpoint;
    // Stringify payloads
    if (options.body) options.body = JSON.stringify(options.body);
    // Use fetch to make requests
    const res = await fetch(url, {
        headers: {
            Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'User-Agent': 'DiscordBot (https://github.com/discord/discord-example-app, 1.0.0)',
        },
        ...options
    });
    // throw API errors
    if (!res.ok) {
        const data = await res.json();
        console.log(res.status);
        throw new Error(JSON.stringify(data));
    }
    console.info(`Discord response:`, res);
    // return original response
    return res;
}

async function InstallGlobalCommands(appId: string, commands: any) {
    // API endpoint to overwrite global commands
    const endpoint = `applications/${appId}/commands`;

    try {
        console.log("Registering commands", commands);
        // This is calling the bulk overwrite endpoint: https://discord.com/developers/docs/interactions/application-commands#bulk-overwrite-global-application-commands
        await DiscordRequest(endpoint, { method: 'PUT', body: commands });
    } catch (err) {
        console.error(err);
    }
}

export const commandHandler = async (event: any): Promise<any> => {
    // Get the game choices from game.js
    function createCommandChoices() {
        const choices = [
            BOT_COMMANDS.START,
            BOT_COMMANDS.STATUS,
            BOT_COMMANDS.STOP
        ];
        const commandChoices: any[] = [];

        for (let choice of choices) {
            commandChoices.push({
                name: capitalize(choice),
                value: choice.toLowerCase(),
            });
        }
        console.log("Custom command choices", choices);
        return commandChoices;
    }

    // Simple test command
    const TEST_COMMAND = {
        name: 'test',
        description: 'Basic command',
        type: 1,
        integration_types: [0, 1],
        contexts: [0, 1, 2],
    };

    // Command containing options
    const SERVER_COMMAND = {
        name: 'request',
        description: 'Request a game server be created',
        type: 1,
        integration_types: [0, 1],
        contexts: [0, 1, 2],
    };

    const STOP_COMMAND = {
        name: 'stop',
        description: 'Destroy the game server',
        type: 1,
        integration_types: [0, 1],
        contexts: [0, 1, 2],
    };

    const ALL_COMMANDS = [TEST_COMMAND, SERVER_COMMAND, STOP_COMMAND];

    return await InstallGlobalCommands(`${process.env.DISCORD_APP_ID}`, ALL_COMMANDS);
};