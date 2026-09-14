import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} from "discord.js";
import { config, envFileExists, vipServers } from "./config.js";
import { getDb } from "./db.js";
import { handleInteraction } from "./bot.js";
import { startVipScheduler } from "./scheduler.js";

if (!config.discordToken) {
  if (!envFileExists()) {
    console.error("Нет .env и нет DISCORD_TOKEN в окружении — заполни .env или переменные Bothost");
  } else {
    console.error("DISCORD_TOKEN не задан");
  }
  process.exit(1);
}

if (!envFileExists()) {
  console.log("файла .env нет — беру Discord и RCON из переменных окружения (Bothost)");
}

getDb();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (c) => {
  const servers = vipServers();
  console.log(`VIP bot online as ${c.user.tag}`);
  console.log(
    `RCON targets (${servers.length}): ${servers.map((s) => `${s.name} ${s.host}:${s.port}`).join(" | ") || "none"}`,
  );
  if (!servers.length) {
    console.warn("SERVER_*_RCON_HOST/PASSWORD пустые — выдача VIP в reserved slots не сработает");
  }
  startVipScheduler(client);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await handleInteraction(interaction);
  } catch (error) {
    console.error("interaction", error);
    const payload = {
      content: "Ошибка обработки команды.",
      ephemeral: true,
    };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

await client.login(config.discordToken);
