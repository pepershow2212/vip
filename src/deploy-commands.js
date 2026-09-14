import { REST, Routes } from "discord.js";
import { config, envFileExists } from "./config.js";
import { commands } from "./bot.js";

if (!config.discordToken || !config.discordClientId) {
  console.error("Нужны DISCORD_TOKEN и DISCORD_CLIENT_ID (.env или переменные Bothost)");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(config.discordToken);

const body = commands;
if (config.discordGuildId) {
  await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), {
    body,
  });
  console.log(`Команды задеплоены в гильдию ${config.discordGuildId}`);
} else {
  await rest.put(Routes.applicationCommands(config.discordClientId), { body });
  console.log("Команды задеплоены глобально");
}
