import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGES, config } from "./config.js";
import {
  closeTicket,
  createTicket,
  deleteMeta,
  getMeta,
  getOpenTicketByDiscord,
  closeOpenTicketsForDiscord,
  getTicket,
  setMeta,
  setTicketSteamId,
} from "./db.js";
import { isSteamId64 } from "./vip.js";

const LOGS_PANEL_META_KEY = "logs_admin_panel_message_id";
let logsPanelQueue = Promise.resolve();

export const CUSTOM = {
  buySelect: "vip:buy_select",
  status: "vip:status",
  closeTicket: "vip:close",
  showPay: "vip:show_pay",
  setSteam: "vip:set_steam",
  steamModal: (days) => `vip:ticket_steam:${days}`,
  steamEditModal: "vip:ticket_steam_edit",
  revokeMenu: "vip:revoke_menu",
  revokeSelect: "vip:revoke_select",
  revokeId: (vipId) => `vip:revoke:${vipId}`,
  dbRefresh: "vip:db_refresh",
};

const ACCENT = 0xc4a574;
const TICKET_EMOJI = "💎";
const BANNER_NAME = "wardogs-vip-banner.webp";
const BANNER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "banner.webp");

function bannerAttachment() {
  if (!existsSync(BANNER_PATH)) {
    console.warn("banner missing:", BANNER_PATH);
    return null;
  }
  return new AttachmentBuilder(BANNER_PATH, { name: BANNER_NAME });
}

function withBanner(container) {
  if (!existsSync(BANNER_PATH)) return container;
  return container.addMediaGalleryComponents(
    new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(`attachment://${BANNER_NAME}`),
    ),
  );
}

function messageWithBanner(container) {
  const file = bannerAttachment();
  const payload = {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  };
  if (file) payload.files = [file];
  return payload;
}

export function panelPayload() {
  const container = withBanner(
    new ContainerBuilder()
      .setAccentColor(ACCENT)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          [
            "# WARDOGS VIP",
            "Поддержи сервера — получи приоритет в очереди на **WARDOGS RUSSIA**.",
            "",
            "Выбери тариф ниже → тикет → перевод → чек.",
          ].join("\n"),
        ),
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          [
            "## Что даёт VIP",
            "VIP даёт **приоритет в очереди**, но **не** гарантирует мгновенный вход при 100/100.",
            "Не исключает уже играющих и **не** даёт преимуществ внутри матча.",
            "Правила сервера одинаковы для всех.",
            "",
            "## Оплата",
            "• **РФ** — ЮMoney",
            `• **Другие страны** — [Boosty](${config.boostyDonateUrl})`,
            "",
            "## Тарифы",
            "• **200 ₽** — 7 дней",
            "• **600 ₽** — 30 дней",
            "• **1600 ₽** — 90 дней",
          ].join("\n"),
        ),
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      )
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(CUSTOM.buySelect)
            .setPlaceholder("Выбери тариф VIP")
            .addOptions(
              {
                label: "200 ₽ · 7 дней",
                description: "Короткий тест приоритета",
                value: "7",
              },
              {
                label: "600 ₽ · 30 дней",
                description: "Оптимальный месячный тариф",
                value: "30",
              },
              {
                label: "1600 ₽ · 90 дней",
                description: "Максимальная выгода",
                value: "90",
              },
            ),
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(CUSTOM.status)
            .setLabel("Мой статус VIP")
            .setStyle(ButtonStyle.Secondary),
        ),
      ),
  );

  return messageWithBanner(container);
}

/** Панель админа в канале логов VIP — забрать / проверить БД */
export function logsAdminPanelPayload() {
  const container = new ContainerBuilder()
    .setAccentColor(0xa85c3c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          "# VIP · Админ",
          "Канал логов выдачи и снятия VIP.",
          "",
          "• **Забрать VIP** — выбрать активного игрока из базы",
          "• **База VIP** — список активных в этот канал (`/vip-db`)",
          "• На каждом логе выдачи тоже есть кнопка **Забрать VIP**",
        ].join("\n"),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(CUSTOM.revokeMenu)
          .setLabel("Забрать VIP")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(CUSTOM.dbRefresh)
          .setLabel("База VIP")
          .setStyle(ButtonStyle.Secondary),
      ),
    );

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  };
}

function componentTreeHasCustomId(components, customIds) {
  const want = new Set(customIds);
  const walk = (nodes) => {
    for (const node of nodes || []) {
      const id = node?.customId ?? node?.data?.custom_id;
      if (id && want.has(id)) return true;
      if (node?.components?.length && walk(node.components)) return true;
    }
    return false;
  };
  return walk(components);
}

function isLogsAdminPanelMessage(message) {
  return componentTreeHasCustomId(message?.components, [CUSTOM.revokeMenu, CUSTOM.dbRefresh]);
}

/**
 * Держит админ-панель последним сообщением в канале логов:
 * удаляет старые панели и шлёт новую вниз.
 */
export function keepLogsAdminPanelBottom(channel) {
  if (!channel?.isTextBased?.()) return Promise.resolve(null);
  logsPanelQueue = logsPanelQueue
    .then(() => relocateLogsAdminPanel(channel))
    .catch((error) => {
      console.error("logs admin panel pin", error instanceof Error ? error.message : error);
      return null;
    });
  return logsPanelQueue;
}

async function relocateLogsAdminPanel(channel) {
  const knownId = getMeta(LOGS_PANEL_META_KEY);
  const toDelete = new Set();
  if (knownId) toDelete.add(String(knownId));

  try {
    const recent = await channel.messages.fetch({ limit: 40 });
    for (const msg of recent.values()) {
      if (msg.author?.id === channel.client.user?.id && isLogsAdminPanelMessage(msg)) {
        toDelete.add(msg.id);
      }
    }
  } catch (error) {
    console.warn("logs panel scan", error instanceof Error ? error.message : error);
  }

  for (const id of toDelete) {
    await channel.messages.delete(id).catch(() => {});
  }
  deleteMeta(LOGS_PANEL_META_KEY);

  const sent = await channel.send(logsAdminPanelPayload());
  setMeta(LOGS_PANEL_META_KEY, sent.id);
  return sent;
}

export function grantRevokeComponents(vipId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(CUSTOM.revokeId(vipId))
        .setLabel("Забрать VIP")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

export function revokeSelectPayload(rows) {
  if (!rows.length) {
    return {
      content: "Активных VIP в базе нет.",
      flags: MessageFlags.Ephemeral,
    };
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(CUSTOM.revokeSelect)
    .setPlaceholder("Кого забрать VIP")
    .addOptions(
      rows.slice(0, 25).map((v) => ({
        label: `${v.steam_id}`.slice(0, 100),
        description: `до ${String(v.expires_at).slice(0, 16)} · id ${v.id}`.slice(0, 100),
        value: String(v.id),
      })),
    );

  return {
    content: "Выбери VIP для снятия:",
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  };
}

function ticketOverwrites(guild, userId) {
  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: userId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: guild.members.me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];
  for (const roleId of config.adminRoleIds) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }
  for (const adminId of config.adminUserIds) {
    overwrites.push({
      id: adminId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }
  return overwrites;
}

export function paymentDetailsText(pkg) {
  return [
    `Сумма: ${pkg.price} ₽`,
    `Тариф: VIP ${pkg.label}`,
    `РФ · ЮMoney: ${config.yoomoneyWallet}`,
    `Другие страны · Boosty: ${config.boostyDonateUrl}`,
  ].join("\n");
}

export function steamModalForPackage(days) {
  const pkg = PACKAGES[String(days)];
  return new ModalBuilder()
    .setCustomId(CUSTOM.steamModal(days))
    .setTitle(`VIP · ${pkg?.label || "тариф"}`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("steam_id")
          .setLabel("Твой SteamID64")
          .setPlaceholder("7656119xxxxxxxxxx")
          .setStyle(TextInputStyle.Short)
          .setMinLength(17)
          .setMaxLength(17)
          .setRequired(true),
      ),
    );
}

export function steamEditModal(currentSteam = "") {
  const input = new TextInputBuilder()
    .setCustomId("steam_id")
    .setLabel("Твой SteamID64")
    .setPlaceholder("7656119xxxxxxxxxx")
    .setStyle(TextInputStyle.Short)
    .setMinLength(17)
    .setMaxLength(17)
    .setRequired(true);
  if (currentSteam && isSteamId64(currentSteam)) {
    input.setValue(String(currentSteam));
  }
  return new ModalBuilder()
    .setCustomId(CUSTOM.steamEditModal)
    .setTitle("Указать SteamID64")
    .addComponents(new ActionRowBuilder().addComponents(input));
}

export function paymentPayload(pkg, { mention = "", steamId = "" } = {}) {
  const steamLine = steamId
    ? `SteamID64: \`${steamId}\``
    : "SteamID64: _не указан — нажми кнопку ниже_";
  const container = withBanner(
    new ContainerBuilder()
      .setAccentColor(ACCENT)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          [mention || null, `# Оплата VIP · ${pkg.label}`].filter(Boolean).join("\n"),
        ),
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          [
            "## 1. SteamID",
            steamLine,
            "",
            `## 2. Перевод · **сумма ${pkg.price} ₽**`,
            "",
            "**РФ · ЮMoney**",
            `\`${config.yoomoneyWallet}\``,
            "",
            "**Другие страны · Boosty**",
            config.boostyDonateUrl,
            "_Карты / зарубежная оплата — укажи в комментарии тариф VIP._",
            "",
            "```",
            paymentDetailsText(pkg),
            "```",
          ].join("\n"),
        ),
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          [
            "## 3. Чек",
            "Прикрепи **скрин оплаты** в этот канал.",
            "ЮMoney: видны **сумма** и **кошелёк**.",
            "Boosty: видны **сумма** и донат на **wardogsrussia**.",
            "",
            "## 4. Выдача",
            "Админ проверит чек и выдаст VIP на **WARDOGS RUSSIA**.",
            "",
            "_Админ:_ `/vip-grant` в этом тикете — SteamID, игрок и срок из тикета.",
          ].join("\n"),
        ),
      )
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(CUSTOM.showPay)
            .setLabel("Скопировать реквизиты")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setLabel("Оплатить Boosty")
            .setStyle(ButtonStyle.Link)
            .setURL(config.boostyDonateUrl),
          new ButtonBuilder()
            .setCustomId(CUSTOM.setSteam)
            .setLabel("Изменить SteamID")
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(CUSTOM.closeTicket)
            .setLabel("Закрыть тикет")
            .setStyle(ButtonStyle.Danger),
        ),
      ),
  );

  return messageWithBanner(container);
}

export async function openPaymentTicket(interaction, days, steamId) {
  const pkg = PACKAGES[String(days)];
  if (!pkg) {
    await interaction.reply({ content: "Неизвестный тариф.", flags: MessageFlags.Ephemeral });
    return;
  }

  const steam = String(steamId || "").trim();
  if (!isSteamId64(steam)) {
    await interaction.reply({
      content: "SteamID64 должен быть вида `7656119xxxxxxxxxx` (17 цифр).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!config.ticketCategoryId) {
    await interaction.reply({
      content: "TICKET_CATEGORY_ID не задан в .env",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const openDb = getOpenTicketByDiscord(interaction.user.id);
  if (openDb) {
    const ch = await interaction.guild.channels.fetch(openDb.channel_id).catch(() => null);
    const topic = String(ch?.topic || "");
    const stillOpenChannel =
      ch &&
      ch.parentId === config.ticketCategoryId &&
      topic.startsWith(`vip:${interaction.user.id}:`) &&
      !topic.startsWith("archived:") &&
      !/архив/i.test(String(ch.name || ""));

    if (stillOpenChannel) {
      await interaction.reply({
        content: `У тебя уже есть открытый тикет: ${ch}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Канал удалён / уже в архиве, а в БД ошибочно open — освобождаем
    closeOpenTicketsForDiscord(interaction.user.id, "closed");
  }

  const existing = interaction.guild.channels.cache.find(
    (ch) =>
      ch.parentId === config.ticketCategoryId &&
      typeof ch.topic === "string" &&
      ch.topic.startsWith(`vip:${interaction.user.id}:`) &&
      !ch.topic.startsWith("archived:") &&
      !/архив/i.test(String(ch.name || "")),
  );
  if (existing) {
    await interaction.reply({
      content: `У тебя уже есть открытый тикет: ${existing}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = await interaction.guild.channels.create({
    name: `${TICKET_EMOJI}｜vip-${interaction.user.username}`
      .slice(0, 100)
      .toLowerCase()
      .replace(/[^a-z0-9\-а-яё💎｜]/gi, "-"),
    type: ChannelType.GuildText,
    parent: config.ticketCategoryId,
    topic: `vip:${interaction.user.id}:${pkg.days}`,
    permissionOverwrites: ticketOverwrites(interaction.guild, interaction.user.id),
    reason: `VIP ticket ${pkg.days}d for ${interaction.user.id}`,
  });

  createTicket({
    channelId: channel.id,
    discordId: interaction.user.id,
    packageDays: pkg.days,
    price: pkg.price,
    steamId: steam,
  });

  const mention = `${interaction.user}${config.adminRoleIds.map((id) => ` <@&${id}>`).join("")}`;
  await channel.send(paymentPayload(pkg, { mention, steamId: steam }));

  await interaction.editReply({ content: `Тикет создан: ${channel}` });
}

export async function handleSetSteamButton(interaction) {
  const ticket = getTicket(interaction.channelId);
  const isOwner = ticket && ticket.discord_id === interaction.user.id;
  const isAdmin =
    config.adminUserIds.includes(interaction.user.id) ||
    interaction.member?.roles?.cache?.some((r) => config.adminRoleIds.includes(r.id)) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

  if (!isOwner && !isAdmin) {
    await interaction.reply({
      content: "SteamID может менять только автор тикета или админ.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!ticket || ticket.status !== "open") {
    await interaction.reply({
      content: "Тикет не найден или уже закрыт.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.showModal(steamEditModal(ticket.steam_id || ""));
}

export async function handleSteamEditModal(interaction) {
  const ticket = getTicket(interaction.channelId);
  if (!ticket || ticket.status !== "open") {
    await interaction.reply({
      content: "Тикет не найден или уже закрыт.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const isOwner = ticket.discord_id === interaction.user.id;
  const isAdmin =
    config.adminUserIds.includes(interaction.user.id) ||
    interaction.member?.roles?.cache?.some((r) => config.adminRoleIds.includes(r.id)) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!isOwner && !isAdmin) {
    await interaction.reply({ content: "Недостаточно прав.", flags: MessageFlags.Ephemeral });
    return;
  }

  const steam = interaction.fields.getTextInputValue("steam_id").trim();
  if (!isSteamId64(steam)) {
    await interaction.reply({
      content: "SteamID64 должен быть вида `7656119xxxxxxxxxx`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  setTicketSteamId(ticket.channel_id, steam);
  const pkg = PACKAGES[String(ticket.package_days)];
  await interaction.reply({
    content: `SteamID обновлён: \`${steam}\`${pkg ? `\nАдмин: \`/vip-grant\` (можно без steam_id).` : ""}`,
  });
}

export async function handleShowPay(interaction) {
  const ticket = getTicket(interaction.channelId);
  const days = ticket?.package_days;
  const pkg = PACKAGES[String(days)] || null;
  if (!pkg) {
    await interaction.reply({
      content: "Не удалось определить тариф тикета.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({
    content: [
      "**Реквизиты для оплаты** — скопируй блок:",
      "```",
      paymentDetailsText(pkg),
      "```",
    ].join("\n"),
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleCloseTicket(interaction) {
  const ticket = getTicket(interaction.channelId);
  const isOwner = ticket && ticket.discord_id === interaction.user.id;
  const isAdmin =
    config.adminUserIds.includes(interaction.user.id) ||
    interaction.member?.roles?.cache?.some((r) => config.adminRoleIds.includes(r.id)) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);

  if (!isOwner && !isAdmin) {
    await interaction.reply({
      content: "Закрыть тикет может только автор или админ.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({ content: "Тикет архивируется…" });
  await archiveTicketChannel(interaction.channel, {
    status: "closed",
    reason: "closed by user/admin",
  });
}

/**
 * Архивирует тикет: лок, переименование, опционально в категорию ARCHIVE_CATEGORY_ID.
 * Не удаляет канал.
 */
export async function archiveTicketChannel(channel, { status = "granted", reason = "archived" } = {}) {
  if (!channel) return;
  closeTicket(channel.id, status);
  const ownerId = getTicket(channel.id)?.discord_id;
  if (ownerId) {
    closeOpenTicketsForDiscord(ownerId, status);
  }
  const overwrites = [
    {
      id: channel.guild.id,
      deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    },
    {
      id: channel.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];
  if (ownerId) {
    overwrites.push({
      id: ownerId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles],
    });
  }
  for (const roleId of config.adminRoleIds) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
      ],
    });
  }
  for (const adminId of config.adminUserIds) {
    overwrites.push({
      id: adminId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
      ],
    });
  }

  const baseName = String(channel.name || "vip")
    .replace(/^💎｜?/, "")
    .replace(/^архив-/, "")
    .replace(/^💎｜?архив-/, "")
    .slice(0, 90);
  const archivedName = `${TICKET_EMOJI}｜архив-${baseName}`.slice(0, 100);

  const edit = {
    name: archivedName,
    topic: `archived:${reason}`.slice(0, 1024),
    permissionOverwrites: overwrites,
    reason: `VIP ticket archive: ${reason}`,
  };
  if (config.archiveCategoryId) {
    edit.parent = config.archiveCategoryId;
  }

  try {
    await channel.edit(edit);
    if (channel.isTextBased()) {
      await channel.send("Тикет **архивирован**. Переписка сохранена, писать больше нельзя.");
    }
  } catch (error) {
    console.error("archive ticket", channel.id, error instanceof Error ? error.message : error);
  }
}

export function scheduleTicketClose(channel, reason = "VIP granted") {
  if (!channel) return;
  closeTicket(channel.id, "granted");
  setTimeout(() => {
    archiveTicketChannel(channel, { status: "granted", reason }).catch((error) => {
      console.error("schedule archive", error instanceof Error ? error.message : error);
    });
  }, 8_000);
}
