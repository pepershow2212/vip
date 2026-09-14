import { listExpiredActive, listExpiringSoon, markReminderSent, logVipAction } from "./db.js";
import { config } from "./config.js";
import { formatExpires, isPermanentVip, revokeLogEmbed, revokeVip } from "./vip.js";

const TICK_MS = 60_000;

export function startVipScheduler(client) {
  const tick = async () => {
    try {
      await processReminders(client);
      await processExpiries(client);
    } catch (error) {
      console.error("vip scheduler", error);
    }
  };
  tick();
  return setInterval(tick, TICK_MS);
}

async function processReminders(client) {
  const rows = listExpiringSoon(72);
  for (const vip of rows) {
    if (isPermanentVip(vip)) {
      markReminderSent(vip.id);
      continue;
    }
    try {
      const user = await client.users.fetch(vip.discord_id).catch(() => null);
      if (user) {
        await user.send(
          [
            "**WARDOGS VIP**",
            `Твой VIP заканчивается через ~3 дня — **${formatExpires(vip.expires_at)}**.`,
            "Продлить можно в канале VIP: оплати тариф и прикрепи чек в тикете.",
          ].join("\n"),
        );
      }
      markReminderSent(vip.id);
      logVipAction({
        action: "remind",
        vipId: vip.id,
        discordId: vip.discord_id,
        steamId: vip.steam_id,
        days: vip.days,
        expiresAt: vip.expires_at,
        details: { channel: "dm" },
      });
    } catch (error) {
      console.warn("vip remind", vip.discord_id, error instanceof Error ? error.message : error);
      // если ЛС закрыты — всё равно помечаем, чтобы не спамить
      markReminderSent(vip.id);
    }
  }
}

async function processExpiries(client) {
  const rows = listExpiredActive();
  if (!rows.length) return;

  const guild = await client.guilds.fetch(config.discordGuildId).catch(() => null);
  if (!guild) {
    console.warn("vip expire: guild not found");
    return;
  }

  const logChannel = config.logChannelId
    ? await guild.channels.fetch(config.logChannelId).catch(() => null)
    : null;

  for (const vip of rows) {
    try {
      await revokeVip({ guild, vipRow: vip, actorId: null, reason: "expired" });
      if (logChannel?.isTextBased()) {
        await logChannel.send({
          content: `VIP истёк · <@${vip.discord_id}>`,
          embeds: [revokeLogEmbed({ vip, actorId: null, reason: "expired" })],
        });
      }
      const user = await client.users.fetch(vip.discord_id).catch(() => null);
      if (user) {
        await user
          .send("Твой **WARDOGS VIP** истёк. Приоритет в очереди снят. Продлить можно в канале VIP.")
          .catch(() => {});
      }
    } catch (error) {
      console.error("vip expire", vip.id, error);
    }
  }
}
