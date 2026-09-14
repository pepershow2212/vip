import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from "discord.js";
import { config, vipServers } from "./config.js";
import { getActiveVipByDiscord, getActiveVipBySteam, getTicket, countActiveVips } from "./db.js";
import { isVipAdmin } from "./permissions.js";
import {
  CUSTOM,
  handleCloseTicket,
  handleShowPay,
  openPaymentTicket,
  panelPayload,
  scheduleTicketClose,
} from "./panel.js";
import {
  grantLogEmbed,
  grantVip,
  isSteamId64,
  packageOf,
  revokeLogEmbed,
  revokeVip,
  statusEmbed,
} from "./vip.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("vip-panel")
    .setDescription("Опубликовать панель VIP в канале «Поддержи нас»")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("vip-grant")
    .setDescription("Выдать VIP после проверки чека (в тикете user/days подставятся сами)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName("steam_id").setDescription("SteamID64").setRequired(true))
    .addUserOption((o) =>
      o.setName("user").setDescription("Игрок Discord (не нужен, если команда в тикете)").setRequired(false),
    )
    .addIntegerOption((o) =>
      o
        .setName("days")
        .setDescription("Срок (не нужен, если команда в тикете)")
        .setRequired(false)
        .addChoices(
          { name: "7 дней (200 ₽)", value: 7 },
          { name: "30 дней (600 ₽)", value: 30 },
          { name: "90 дней (1600 ₽)", value: 90 },
        ),
    ),

  new SlashCommandBuilder()
    .setName("vip-revoke")
    .setDescription("Снять VIP досрочно")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((o) => o.setName("user").setDescription("Игрок Discord").setRequired(false))
    .addStringOption((o) => o.setName("steam_id").setDescription("SteamID64").setRequired(false)),

  new SlashCommandBuilder()
    .setName("vip-status")
    .setDescription("Проверить свой VIP или статус игрока")
    .addUserOption((o) => o.setName("user").setDescription("Чей статус смотреть").setRequired(false)),
].map((c) => c.toJSON());

function parseTicketTopic(topic) {
  const match = String(topic || "").match(/^vip:(\d+):(\d+)$/);
  if (!match) return null;
  return { discordId: match[1], days: Number(match[2]) };
}

async function sendGrantLog(guild, { result, targetId, actorId, ticketChannelId }) {
  if (!config.logChannelId) return;
  const channel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.send({
    content: `VIP выдан · <@${targetId}>`,
    embeds: [
      grantLogEmbed({
        result,
        targetId,
        actorId,
        ticketChannelId,
        guildId: guild.id,
      }),
    ],
  });
}

async function sendRevokeLog(guild, embed, content) {
  if (!config.logChannelId) return;
  const channel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.send({ content, embeds: [embed] });
}

export async function handleInteraction(interaction) {
  if (interaction.isChatInputCommand()) {
    await handleCommand(interaction);
    return;
  }
  if (interaction.isStringSelectMenu()) {
    await handleSelect(interaction);
    return;
  }
  if (interaction.isButton()) {
    await handleButton(interaction);
  }
}

async function handleCommand(interaction) {
  const name = interaction.commandName;

  if (name === "vip-panel") {
    if (!isVipAdmin(interaction.member, interaction.user.id)) {
      await interaction.reply({ content: "Недостаточно прав.", flags: MessageFlags.Ephemeral });
      return;
    }
    const servers = vipServers();
    const targetId = config.panelChannelId || interaction.channelId;
    const channel =
      targetId === interaction.channelId
        ? interaction.channel
        : await interaction.guild.channels.fetch(targetId).catch(() => null);
    if (!channel?.isTextBased()) {
      await interaction.reply({
        content: `Канал панели не найден: \`${targetId}\``,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await channel.send(panelPayload());
    await interaction.reply({
      content: `Панель в ${channel}. RCON: **${servers.length}** · VIP слотов: **${countActiveVips()}/${config.vipMaxSlots}**`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (name === "vip-status") {
    const target = interaction.options.getUser("user") || interaction.user;
    if (target.id !== interaction.user.id && !isVipAdmin(interaction.member, interaction.user.id)) {
      await interaction.reply({
        content: "Чужой статус могут смотреть только админы.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const vip = getActiveVipByDiscord(target.id);
    await interaction.reply({ embeds: [statusEmbed(vip)], flags: MessageFlags.Ephemeral });
    return;
  }

  if (name === "vip-grant") {
    if (!isVipAdmin(interaction.member, interaction.user.id)) {
      await interaction.reply({ content: "Недостаточно прав.", flags: MessageFlags.Ephemeral });
      return;
    }

    const ticket = getTicket(interaction.channelId);
    const fromTopic = parseTicketTopic(interaction.channel?.topic);
    const steamId = interaction.options.getString("steam_id", true).trim();
    const userOpt = interaction.options.getUser("user");
    const daysOpt = interaction.options.getInteger("days");

    const discordId = userOpt?.id || ticket?.discord_id || fromTopic?.discordId;
    const days = daysOpt || ticket?.package_days || fromTopic?.days;
    const pkg = packageOf(days);

    if (!discordId) {
      await interaction.reply({
        content: "Укажи `user` или выполни команду внутри тикета оплаты.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!days || !pkg) {
      await interaction.reply({
        content: "Укажи `days` или выполни команду внутри тикета оплаты.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!isSteamId64(steamId)) {
      await interaction.reply({
        content: "SteamID64 должен быть вида `7656119xxxxxxxxxx`",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const result = await grantVip({
        guild: interaction.guild,
        discordId,
        steamId,
        days,
        price: pkg.price,
        actorId: interaction.user.id,
        ticketChannelId: ticket?.channel_id || (fromTopic ? interaction.channelId : null),
      });

      const ticketChannelId = ticket?.channel_id || (fromTopic ? interaction.channelId : null);
      await sendGrantLog(interaction.guild, {
        result,
        targetId: discordId,
        actorId: interaction.user.id,
        ticketChannelId,
      });

      const publicMsg = [
        `<@${discordId}>, тебе выдан **VIP** на **${result.days} дн.**`,
        `SteamID: \`${result.steamId}\``,
        `Действует до: **${result.expiresLabel}**`,
        result.extended ? "_Срок продлён от текущей даты окончания._" : "",
        "",
        "Приоритет в очереди записан на серверах:",
        ...result.rconResults.map((r) => `${r.ok ? "✅" : "❌"} ${r.name}`),
        ticketChannelId ? "\nТикет будет **архивирован** через ~8 сек." : "",
      ]
        .filter(Boolean)
        .join("\n");

      if (interaction.channel?.isTextBased()) {
        await interaction.channel.send(publicMsg);
      }

      if (ticketChannelId && interaction.channelId === ticketChannelId) {
        scheduleTicketClose(interaction.channel);
      }

      await interaction.editReply({
        content: `Готово. VIP #${result.vipId} → <@${discordId}> до ${result.expiresLabel} · слоты ${countActiveVips()}/${config.vipMaxSlots}`,
      });
    } catch (error) {
      await interaction.editReply({
        content: `Ошибка выдачи: ${error instanceof Error ? error.message : error}`,
      });
    }
    return;
  }

  if (name === "vip-revoke") {
    if (!isVipAdmin(interaction.member, interaction.user.id)) {
      await interaction.reply({ content: "Недостаточно прав.", flags: MessageFlags.Ephemeral });
      return;
    }
    const user = interaction.options.getUser("user");
    const steamId = interaction.options.getString("steam_id")?.trim();
    if (!user && !steamId) {
      await interaction.reply({ content: "Укажи user или steam_id.", flags: MessageFlags.Ephemeral });
      return;
    }

    const vip = user ? getActiveVipByDiscord(user.id) : getActiveVipBySteam(steamId);
    if (!vip) {
      await interaction.reply({ content: "Активный VIP не найден.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await revokeVip({
        guild: interaction.guild,
        vipRow: vip,
        actorId: interaction.user.id,
        reason: "manual",
      });
      await sendRevokeLog(
        interaction.guild,
        revokeLogEmbed({ vip, actorId: interaction.user.id, reason: "manual" }),
        `VIP снят · <@${vip.discord_id}>`,
      );
      await interaction.editReply({ content: `VIP снят у <@${vip.discord_id}> (\`${vip.steam_id}\`).` });
    } catch (error) {
      await interaction.editReply({
        content: `Ошибка: ${error instanceof Error ? error.message : error}`,
      });
    }
  }
}

async function handleSelect(interaction) {
  if (interaction.customId !== CUSTOM.buySelect) return;
  const days = Number(interaction.values[0]);
  await openPaymentTicket(interaction, days);
}

async function handleButton(interaction) {
  const id = interaction.customId;

  if (id === CUSTOM.status) {
    const vip = getActiveVipByDiscord(interaction.user.id);
    await interaction.reply({ embeds: [statusEmbed(vip)], flags: MessageFlags.Ephemeral });
    return;
  }

  if (id === CUSTOM.showPay) {
    await handleShowPay(interaction);
    return;
  }

  if (id === CUSTOM.closeTicket) {
    await handleCloseTicket(interaction);
  }
}
