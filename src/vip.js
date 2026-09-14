import { EmbedBuilder } from "discord.js";
import { PACKAGES, PERMANENT_EXPIRES, config, vipServers } from "./config.js";
import {
  deactivateVip,
  getActiveVipByDiscord,
  getActiveVipBySteam,
  insertVip,
  logVipAction,
  countActiveVips,
} from "./db.js";
import { reserveOnEach } from "./rcon.js";

const STEAM_RE = /^7656119\d{10}$/;

export function isSteamId64(value) {
  return STEAM_RE.test(String(value || "").trim());
}

export function packageOf(days) {
  if (days == null || days === "") return null;
  return PACKAGES[String(days)] || null;
}

export function isPermanentVip(vipOrDays) {
  if (vipOrDays && typeof vipOrDays === "object") {
    if (Number(vipOrDays.days) < 0) return true;
    if (String(vipOrDays.expires_at || "").startsWith("2099")) return true;
    return false;
  }
  return Number(vipOrDays) < 0;
}

function isoFromDate(date) {
  return date.toISOString();
}

function formatMoscow(iso) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatExpires(iso) {
  if (!iso || String(iso).startsWith("2099")) return "навсегда";
  return `${formatMoscow(iso)} МСК`;
}

export function formatVipTerm(vip) {
  if (isPermanentVip(vip)) return "навсегда";
  return `${vip.days} дн.`;
}

function resultsSummary(results) {
  if (!results.length) return "нет настроенных серверов RCON";
  return results.map((r) => `${r.ok ? "✅" : "❌"} ${r.name}`).join("\n");
}

async function giveVipRole(guild, discordId) {
  if (!config.vipRoleId) return { ok: false, reason: "VIP_ROLE_ID не задан" };
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return { ok: false, reason: "участник не найден на сервере" };
  await member.roles.add(config.vipRoleId);
  return { ok: true };
}

async function takeVipRole(guild, discordId) {
  if (!config.vipRoleId) return { ok: false, reason: "VIP_ROLE_ID не задан" };
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return { ok: false, reason: "участник не найден" };
  if (member.roles.cache.has(config.vipRoleId)) {
    await member.roles.remove(config.vipRoleId);
  }
  return { ok: true };
}

/**
 * Выдаёт VIP: reserved slots на всех серверах + роль Discord + запись в БД/лог.
 * Если VIP уже есть — продлевает от текущей даты окончания.
 */
export async function grantVip({
  guild,
  discordId,
  steamId,
  days,
  price = 0,
  actorId,
  ticketChannelId,
}) {
  const steam = String(steamId || "").trim();
  if (!isSteamId64(steam)) throw new Error("Некорректный SteamID64");
  const dayCount = Number(days);
  const permanent = dayCount < 0 || packageOf(dayCount)?.permanent;
  if (!Number.isFinite(dayCount) || (dayCount < 1 && !permanent)) {
    throw new Error("Некорректный срок VIP");
  }

  const servers = vipServers();
  if (!servers.length) throw new Error("Нет настроенных SERVER_*_RCON_* — VIP некуда писать");

  const existingDiscord = getActiveVipByDiscord(discordId);
  const existingSteam = getActiveVipBySteam(steam);
  if (existingSteam && String(existingSteam.discord_id) !== String(discordId)) {
    throw new Error(`Этот SteamID уже привязан к VIP <@${existingSteam.discord_id}>`);
  }

  // Продление / ADMIN навсегда не занимает новый слот, если VIP уже есть
  if (!existingDiscord) {
    const active = countActiveVips();
    if (active >= config.vipMaxSlots) {
      throw new Error(`Лимит VIP занят: ${active}/${config.vipMaxSlots}`);
    }
  }

  const now = new Date();
  let startsAt = now;
  if (existingDiscord && !permanent) {
    const prevEnd = new Date(existingDiscord.expires_at);
    if (prevEnd > startsAt && !isPermanentVip(existingDiscord)) startsAt = prevEnd;
  }
  if (existingDiscord) {
    deactivateVip(existingDiscord.id, permanent ? "admin_permanent" : "extended");
    logVipAction({
      action: "extend_close_old",
      vipId: existingDiscord.id,
      discordId,
      steamId: existingDiscord.steam_id,
      days: existingDiscord.days,
      expiresAt: existingDiscord.expires_at,
      actorId,
      details: { reason: permanent ? "admin_permanent" : "extended" },
    });
    if (String(existingDiscord.steam_id) !== steam) {
      await reserveOnEach(servers, existingDiscord.steam_id, false);
    }
  }

  const expiresIso = permanent
    ? PERMANENT_EXPIRES
    : isoFromDate(new Date(startsAt.getTime() + dayCount * 86400000));
  const startsIso = isoFromDate(now);
  const storeDays = permanent ? -1 : dayCount;

  const rconResults = await reserveOnEach(servers, steam, true);
  const rconOk = rconResults.every((r) => r.ok);
  if (!rconOk) {
    throw new Error(`RCON не записал на все серверы:\n${resultsSummary(rconResults)}`);
  }

  const role = await giveVipRole(guild, discordId);
  if (!role.ok) {
    console.warn("vip role", role.reason);
  }

  const vipId = insertVip({
    discordId,
    steamId: steam,
    days: storeDays,
    price: permanent ? 0 : price,
    startsAt: startsIso,
    expiresAt: expiresIso,
    grantedBy: actorId,
    ticketChannelId,
  });

  logVipAction({
    action: permanent ? "grant_permanent" : "grant",
    vipId,
    discordId,
    steamId: steam,
    days: storeDays,
    expiresAt: expiresIso,
    actorId,
    details: {
      price: permanent ? 0 : price,
      servers: rconResults,
      roleOk: role.ok,
      extended: Boolean(existingDiscord),
      permanent,
    },
  });

  return {
    vipId,
    steamId: steam,
    days: storeDays,
    permanent,
    expiresAt: expiresIso,
    expiresLabel: formatExpires(expiresIso),
    termLabel: permanent ? "навсегда" : `${dayCount} дн.`,
    rconResults,
    roleOk: role.ok,
    extended: Boolean(existingDiscord),
  };
}

export async function revokeVip({ guild, vipRow, actorId, reason = "manual" }) {
  const servers = vipServers();
  const rconResults = await reserveOnEach(servers, vipRow.steam_id, false);
  await takeVipRole(guild, vipRow.discord_id).catch((err) => {
    console.warn("vip role remove", err instanceof Error ? err.message : err);
  });
  deactivateVip(vipRow.id, reason);
  logVipAction({
    action: reason === "expired" ? "expire" : "revoke",
    vipId: vipRow.id,
    discordId: vipRow.discord_id,
    steamId: vipRow.steam_id,
    days: vipRow.days,
    expiresAt: vipRow.expires_at,
    actorId,
    details: { reason, servers: rconResults },
  });
  return { rconResults };
}

export function statusEmbed(vip) {
  if (!vip) {
    return new EmbedBuilder()
      .setColor(0x8b7355)
      .setTitle("Статус VIP")
      .setDescription("Активного VIP нет.");
  }
  return new EmbedBuilder()
    .setColor(0xc4a574)
    .setTitle("Статус VIP")
    .addFields(
      { name: "SteamID64", value: `\`${vip.steam_id}\``, inline: true },
      { name: "Срок", value: formatVipTerm(vip), inline: true },
      { name: "Действует до", value: formatExpires(vip.expires_at), inline: false },
    );
}

export function grantLogEmbed({ result, targetId, actorId, ticketChannelId, guildId }) {
  const embed = new EmbedBuilder()
    .setColor(result.permanent ? 0xc4a574 : 0x3d8b5f)
    .setTitle(result.permanent ? "VIP выдан · ADMIN навсегда" : "VIP выдан")
    .addFields(
      { name: "Игрок", value: `<@${targetId}>`, inline: true },
      { name: "SteamID64", value: `\`${result.steamId}\``, inline: true },
      { name: "Срок", value: result.termLabel || formatExpires(result.expiresAt), inline: true },
      { name: "До", value: result.expiresLabel, inline: false },
      { name: "Серверы", value: resultsSummary(result.rconResults), inline: false },
      { name: "Админ", value: actorId ? `<@${actorId}>` : "—", inline: true },
    )
    .setTimestamp();

  if (ticketChannelId && guildId) {
    embed.addFields({
      name: "Тикет",
      value: `[Открыть](https://discord.com/channels/${guildId}/${ticketChannelId})`,
      inline: true,
    });
  }
  if (result.extended) {
    embed.setFooter({ text: "Продление существующего VIP" });
  }
  return embed;
}

export function revokeLogEmbed({ vip, actorId, reason }) {
  return new EmbedBuilder()
    .setColor(0xa85c3c)
    .setTitle(reason === "expired" ? "VIP истёк" : "VIP снят")
    .addFields(
      { name: "Игрок", value: `<@${vip.discord_id}>`, inline: true },
      { name: "SteamID64", value: `\`${vip.steam_id}\``, inline: true },
      { name: "Причина", value: reason, inline: true },
      { name: "Был до", value: formatExpires(vip.expires_at), inline: false },
      { name: "Админ", value: actorId ? `<@${actorId}>` : "система", inline: true },
    )
    .setTimestamp();
}

export { resultsSummary, formatMoscow };
