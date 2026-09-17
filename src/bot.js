import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
} from "discord.js";
import { config, vipServers } from "./config.js";
import {
  getActiveVipByDiscord,
  getActiveVipBySteam,
  getActiveVipById,
  getTicket,
  countActiveVips,
  listActiveVips,
  listVipHistory,
  closeOpenTicketsForDiscord,
} from "./db.js";
import { isVipAdmin } from "./permissions.js";
import {
  CUSTOM,
  grantRevokeComponents,
  handleCloseTicket,
  handleSetSteamButton,
  handleShowPay,
  handleSteamEditModal,
  keepLogsAdminPanelBottom,
  openPaymentTicket,
  panelPayload,
  revokeSelectPayload,
  scheduleTicketClose,
  steamModalForPackage,
} from "./panel.js";
import {
  formatExpires,
  formatVipTerm,
  grantLogEmbed,
  grantVip,
  isSteamId64,
  packageOf,
  revokeLogEmbed,
  revokeVip,
  statusEmbed,
  syncVipDatabaseToServers,
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
    .addStringOption((o) =>
      o
        .setName("steam_id")
        .setDescription("SteamID64 (в тикете можно не указывать — берётся из заявки)")
        .setRequired(false),
    )
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
          { name: "ADMIN · навсегда", value: -1 },
        ),
    ),

  new SlashCommandBuilder()
    .setName("vip-revoke")
    .setDescription("Снять VIP досрочно")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((o) => o.setName("user").setDescription("Игрок Discord").setRequired(false))
    .addStringOption((o) => o.setName("steam_id").setDescription("SteamID64").setRequired(false)),

  new SlashCommandBuilder()
    .setName("vip-sync")
    .setDescription("Админ: прогнать всю VIP-базу в reserved на все SERVER_*")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addBooleanOption((o) =>
      o.setName("post_log").setDescription("Дублировать отчёт в канал логов (по умолчанию да)").setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("vip-db")
    .setDescription("Админ: проверить VIP в базе (список уходит в лог-канал)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((o) =>
      o.setName("user").setDescription("Проверить конкретного игрока").setRequired(false),
    )
    .addStringOption((o) =>
      o.setName("steam_id").setDescription("Или SteamID64").setRequired(false),
    )
    .addBooleanOption((o) =>
      o.setName("post_log").setDescription("Дублировать в канал логов (по умолчанию да)").setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("vip-logs-panel")
    .setDescription("Админ-панель в канале логов VIP (забрать / база)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

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
    components: grantRevokeComponents(result.vipId),
  });
  await keepLogsAdminPanelBottom(channel);
}

async function sendRevokeLog(guild, embed, content) {
  if (!config.logChannelId) return;
  const channel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.send({ content, embeds: [embed] });
  await keepLogsAdminPanelBottom(channel);
}

export async function handleInteraction(interaction) {
  if (interaction.isChatInputCommand()) {
    await handleCommand(interaction);
    return;
  }
  if (interaction.isModalSubmit()) {
    await handleModal(interaction);
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const servers = vipServers();
    const targetId = config.panelChannelId || interaction.channelId;
    const channel =
      targetId === interaction.channelId
        ? interaction.channel
        : await interaction.guild.channels.fetch(targetId).catch(() => null);
    if (!channel?.isTextBased()) {
      await interaction.editReply({
        content: `Канал панели не найден: \`${targetId}\``,
      });
      return;
    }
    try {
      await channel.send(panelPayload());
      await interaction.editReply({
        content: `Панель в ${channel}. RCON: **${servers.length}** · VIP слотов: **${countActiveVips()}/${config.vipMaxSlots}**`,
      });
    } catch (error) {
      console.error("vip-panel send", error);
      await interaction.editReply({
        content: `Не удалось отправить панель: ${error instanceof Error ? error.message : error}`,
      });
    }
    return;
  }

  if (name === "vip-logs-panel") {
    if (!isVipAdmin(interaction.member, interaction.user.id)) {
      await interaction.reply({ content: "Недостаточно прав.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = await interaction.guild.channels.fetch(config.logChannelId).catch(() => null);
    if (!channel?.isTextBased()) {
      await interaction.editReply({
        content: `Канал логов не найден: \`${config.logChannelId}\``,
      });
      return;
    }
    try {
      await keepLogsAdminPanelBottom(channel);
      await interaction.editReply({
        content: `Админ-панель VIP закреплена внизу ${channel}`,
      });
    } catch (error) {
      console.error("vip-logs-panel send", error);
      await interaction.editReply({
        content: `Не удалось отправить: ${error instanceof Error ? error.message : error}`,
      });
    }
    return;
  }

  if (name === "vip-sync") {
    if (!isVipAdmin(interaction.member, interaction.user.id)) {
      await interaction.reply({ content: "Недостаточно прав.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const shouldPost = interaction.options.getBoolean("post_log") !== false;

    try {
      const sync = await syncVipDatabaseToServers({ actorId: interaction.user.id });
      const lines = sync.results.map((r) => {
        if (!r.ok) return `❌ **${r.name}** — ${r.error || "ошибка"}`;
        if (r.already) {
          return `✅ **${r.name}** — уже актуально (reserved ${r.reservedAfter})`;
        }
        return `✅ **${r.name}** — дописано **${r.added}** · reserved ${r.reservedBefore} → ${r.reservedAfter}`;
      });

      const embed = new EmbedBuilder()
        .setColor(sync.ok ? 0x3d8b5f : 0xa85c3c)
        .setTitle(sync.ok ? "VIP sync · готово" : "VIP sync · с ошибками")
        .setDescription(
          [
            `Активных VIP в БД: **${sync.steamIds.length}**`,
            `Серверов RCON: **${sync.servers.length}**`,
            "",
            ...lines,
          ].join("\n"),
        )
        .setFooter({ text: `Запросил ${interaction.user.tag}` })
        .setTimestamp();

      if (shouldPost && config.logChannelId) {
        const logChannel = await interaction.guild.channels.fetch(config.logChannelId).catch(() => null);
        if (logChannel?.isTextBased()) {
          await logChannel.send({
            content: `Sync VIP-базы · <@${interaction.user.id}>`,
            embeds: [embed],
          });
          await keepLogsAdminPanelBottom(logChannel);
        }
      }

      await interaction.editReply({
        content: sync.ok
          ? `Готово: **${sync.steamIds.length}** VIP → **${sync.servers.length}** сервер(ов).`
          : "Синк завершён с ошибками — смотри отчёт.",
        embeds: [embed],
      });
    } catch (error) {
      await interaction.editReply({
        content: `Ошибка sync: ${error instanceof Error ? error.message : error}`,
      });
    }
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

  if (name === "vip-db") {
    if (!isVipAdmin(interaction.member, interaction.user.id)) {
      await interaction.reply({ content: "Недостаточно прав.", flags: MessageFlags.Ephemeral });
      return;
    }

    const user = interaction.options.getUser("user");
    const steamId = interaction.options.getString("steam_id")?.trim();
    const postLog = interaction.options.getBoolean("post_log");
    const shouldPost = postLog !== false;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let embed;
    if (user || steamId) {
      const vip = user ? getActiveVipByDiscord(user.id) : getActiveVipBySteam(steamId);
      if (!vip) {
        embed = new EmbedBuilder()
          .setColor(0x8b7355)
          .setTitle("VIP в базе")
          .setDescription(
            user
              ? `Активного VIP у <@${user.id}> нет.`
              : `Активного VIP для \`${steamId}\` нет.`,
          )
          .addFields({
            name: "Слоты",
            value: `${countActiveVips()}/${config.vipMaxSlots}`,
            inline: true,
          });
      } else {
        embed = new EmbedBuilder()
          .setColor(0xc4a574)
          .setTitle(`VIP #${vip.id} в базе`)
          .addFields(
            { name: "Discord", value: `<@${vip.discord_id}>`, inline: true },
            { name: "SteamID64", value: `\`${vip.steam_id}\``, inline: true },
            { name: "Срок", value: formatVipTerm(vip), inline: true },
            { name: "До", value: formatExpires(vip.expires_at), inline: false },
            { name: "Цена", value: `${vip.price || 0} ₽`, inline: true },
            {
              name: "Выдал",
              value: vip.granted_by ? `<@${vip.granted_by}>` : "—",
              inline: true,
            },
            {
              name: "Тикет",
              value: vip.ticket_channel_id
                ? `[открыть](https://discord.com/channels/${interaction.guildId}/${vip.ticket_channel_id})`
                : "—",
              inline: true,
            },
          )
          .setFooter({ text: `Активных: ${countActiveVips()}/${config.vipMaxSlots}` });
      }
    } else {
      const rows = listActiveVips(80);
      const lines = rows.length
        ? rows.map(
            (v, i) =>
              `${i + 1}. <@${v.discord_id}> · \`${v.steam_id}\` · ${formatVipTerm(v)} · до ${formatExpires(v.expires_at)}`,
          )
        : ["Активных VIP нет."];

      // Discord embed description max 4096
      let body = lines.join("\n");
      if (body.length > 3900) body = `${body.slice(0, 3900)}\n…`;

      const history = listVipHistory(8)
        .map((h) => `\`${h.action}\` <@${h.discord_id || "?"}> · \`${h.steam_id || "—"}\``)
        .join("\n");

      embed = new EmbedBuilder()
        .setColor(0xc4a574)
        .setTitle(`VIP база · ${countActiveVips()}/${config.vipMaxSlots}`)
        .setDescription(body)
        .setTimestamp();
      if (history) {
        embed.addFields({ name: "Последние действия", value: history.slice(0, 1000) });
      }
    }

    if (shouldPost && config.logChannelId) {
      const logChannel = await interaction.guild.channels.fetch(config.logChannelId).catch(() => null);
      if (logChannel?.isTextBased()) {
        await logChannel.send({
          content: `Проверка БД · <@${interaction.user.id}>`,
          embeds: [embed],
        });
        await keepLogsAdminPanelBottom(logChannel);
      }
    }

    await interaction.editReply({
      content: shouldPost ? `Отчёт отправлен в <#${config.logChannelId}>.` : "Только тебе:",
      embeds: [embed],
    });
    return;
  }

  if (name === "vip-grant") {
    if (!isVipAdmin(interaction.member, interaction.user.id)) {
      await interaction.reply({ content: "Недостаточно прав.", flags: MessageFlags.Ephemeral });
      return;
    }

    const ticket = getTicket(interaction.channelId);
    const fromTopic = parseTicketTopic(interaction.channel?.topic);
    const steamOpt = interaction.options.getString("steam_id")?.trim();
    const steamId = steamOpt || ticket?.steam_id || null;
    const userOpt = interaction.options.getUser("user");
    const daysOpt = interaction.options.getInteger("days");
    const discordId = userOpt?.id || ticket?.discord_id || fromTopic?.discordId;
    const days =
      daysOpt != null ? daysOpt : ticket?.package_days ?? fromTopic?.days ?? null;
    const pkg = packageOf(days);

    if (!discordId) {
      await interaction.reply({
        content: "Укажи `user` или выполни команду внутри тикета оплаты.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (days == null || !pkg) {
      await interaction.reply({
        content: "Укажи `days` (7 / 30 / 90 / ADMIN навсегда) или выполни команду в тикете.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!steamId) {
      await interaction.reply({
        content:
          "Нет SteamID: укажи `steam_id` или попроси игрока нажать **Изменить SteamID** в тикете.",
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
        `<@${discordId}>, тебе выдан **VIP** — **${result.termLabel}**.`,
        `SteamID: \`${result.steamId}\``,
        `Действует до: **${result.expiresLabel}**`,
        result.extended ? "_Предыдущий VIP заменён/продлён._" : "",
        result.permanent ? "_ADMIN · бессрочный приоритет._" : "",
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

      // Всегда закрываем open-тикеты игрока после выдачи VIP
      closeOpenTicketsForDiscord(discordId, "granted");

      if (ticketChannelId) {
        const ticketChannel =
          interaction.channelId === ticketChannelId
            ? interaction.channel
            : await interaction.guild.channels.fetch(ticketChannelId).catch(() => null);
        if (ticketChannel) {
          scheduleTicketClose(ticketChannel);
        }
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

async function executeRevoke(interaction, vip) {
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
}

async function handleModal(interaction) {
  if (interaction.customId === CUSTOM.steamEditModal) {
    await handleSteamEditModal(interaction);
    return;
  }
  if (interaction.customId.startsWith("vip:ticket_steam:")) {
    const days = Number(interaction.customId.split(":")[2]);
    const steam = interaction.fields.getTextInputValue("steam_id").trim();
    await openPaymentTicket(interaction, days, steam);
  }
}

async function handleSelect(interaction) {
  if (interaction.customId === CUSTOM.buySelect) {
    const days = Number(interaction.values[0]);
    if (!packageOf(days)) {
      await interaction.reply({ content: "Неизвестный тариф.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(steamModalForPackage(days));
    return;
  }

  if (interaction.customId === CUSTOM.revokeSelect) {
    if (!isVipAdmin(interaction.member, interaction.user.id)) {
      await interaction.reply({ content: "Недостаточно прав.", flags: MessageFlags.Ephemeral });
      return;
    }
    const vipId = Number(interaction.values[0]);
    const vip = getActiveVipById(vipId);
    if (!vip) {
      await interaction.reply({ content: "Этот VIP уже не активен.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await executeRevoke(interaction, vip);
      await interaction.editReply({
        content: `VIP снят у <@${vip.discord_id}> (\`${vip.steam_id}\`).`,
      });
    } catch (error) {
      await interaction.editReply({
        content: `Ошибка: ${error instanceof Error ? error.message : error}`,
      });
    }
  }
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

  if (id === CUSTOM.setSteam) {
    await handleSetSteamButton(interaction);
    return;
  }

  if (id === CUSTOM.closeTicket) {
    await handleCloseTicket(interaction);
    return;
  }

  if (id === CUSTOM.revokeMenu) {
    if (!isVipAdmin(interaction.member, interaction.user.id)) {
      await interaction.reply({ content: "Недостаточно прав.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply(revokeSelectPayload(listActiveVips(25)));
    return;
  }

  if (id === CUSTOM.dbRefresh) {
    if (!isVipAdmin(interaction.member, interaction.user.id)) {
      await interaction.reply({ content: "Недостаточно прав.", flags: MessageFlags.Ephemeral });
      return;
    }
    const rows = listActiveVips(80);
    const lines = rows.length
      ? rows.map(
          (v, i) =>
            `${i + 1}. <@${v.discord_id}> · \`${v.steam_id}\` · ${formatVipTerm(v)} · до ${formatExpires(v.expires_at)}`,
        )
      : ["Активных VIP нет."];
    let body = lines.join("\n");
    if (body.length > 3900) body = `${body.slice(0, 3900)}\n…`;
    const embed = new EmbedBuilder()
      .setColor(0xc4a574)
      .setTitle(`VIP база · ${countActiveVips()}/${config.vipMaxSlots}`)
      .setDescription(body)
      .setTimestamp();
    await interaction.reply({
      content: `Проверка БД · <@${interaction.user.id}>`,
      embeds: [embed],
    });
    if (config.logChannelId && interaction.channelId === config.logChannelId) {
      await keepLogsAdminPanelBottom(interaction.channel);
    }
    return;
  }

  if (id.startsWith("vip:revoke:")) {
    if (!isVipAdmin(interaction.member, interaction.user.id)) {
      await interaction.reply({ content: "Недостаточно прав.", flags: MessageFlags.Ephemeral });
      return;
    }
    const vipId = Number(id.split(":")[2]);
    const vip = getActiveVipById(vipId);
    if (!vip) {
      await interaction.reply({ content: "Этот VIP уже не активен.", flags: MessageFlags.Ephemeral });
      await interaction.message.edit({ components: [] }).catch(() => {});
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await executeRevoke(interaction, vip);
      await interaction.message.edit({ components: [] }).catch(() => {});
      await interaction.editReply({
        content: `VIP снят у <@${vip.discord_id}> (\`${vip.steam_id}\`).`,
      });
    } catch (error) {
      await interaction.editReply({
        content: `Ошибка: ${error instanceof Error ? error.message : error}`,
      });
    }
  }
}
