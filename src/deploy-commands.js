import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commands } from "./bot.js";

export async function deploySlashCommands() {
  if (!config.discordToken || !config.discordClientId) {
    throw new Error("Нужны DISCORD_TOKEN и DISCORD_CLIENT_ID");
  }

  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  if (config.discordGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), {
      body: commands,
    });
    return { scope: "guild", id: config.discordGuildId, count: commands.length };
  }

  await rest.put(Routes.applicationCommands(config.discordClientId), { body: commands });
  return { scope: "global", id: null, count: commands.length };
}

const isMain = process.argv[1] && String(process.argv[1]).replace(/\\/g, "/").endsWith("deploy-commands.js");
if (isMain) {
  try {
    const result = await deploySlashCommands();
    if (result.scope === "guild") {
      console.log(`Команды задеплоены в гильдию ${result.id} (${result.count})`);
    } else {
      console.log(`Команды задеплоены глобально (${result.count})`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
