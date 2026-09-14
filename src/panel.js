import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from "discord.js";
import { PACKAGES, config } from "./config.js";
import { closeTicket, createTicket, getTicket } from "./db.js";

export const CUSTOM = {
  buySelect: "vip:buy_select",
  status: "vip:status",
  closeTicket: "vip:close",
  showPay: "vip:show_pay",
};

const ACCENT = 0xc4a574;

export function panelPayload() {
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          "# WARDOGS VIP",
          "Поддержи сервера — получи приоритет в очереди на **всех** WARDOGS.",
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
          "## Тарифы",
          "• **200 ₽** — 7 дней",
          "• **600 ₽** — 30 дней",
          "• **1600 ₽** — 90 дней",
          "",
          "Выбери тариф → тикет → перевод → **чек**. Админ выдаст VIP вручную.",
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
    );

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
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
  return overwrites;
}

export function paymentDetailsText(pkg) {
  return [
    `ЮMoney: ${config.yoomoneyWallet}`,
    `Сумма: ${pkg.price} ₽`,
    `Тариф: VIP ${pkg.label}`,
  ].join("\n");
}

export function paymentPayload(pkg, { mention = "" } = {}) {
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          mention || null,
          `# Оплата VIP — ${pkg.label}`,
          `Переведи **${pkg.price} ₽** на ЮMoney:`,
          `\`${config.yoomoneyWallet}\``,
          "",
          "```",
          paymentDetailsText(pkg),
          "```",
          "",
          "**Прикрепи чек** (скрин перевода) — администратор выдаст VIP.",
          "В чеке должны быть видны сумма и кошелёк.",
          "",
          "_Админ:_ `/vip-grant steam_id:...` — игрок и срок подставятся из тикета.",
        ]
          .filter((line) => line != null)
          .join("\n"),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(CUSTOM.showPay)
          .setLabel("Реквизиты")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(CUSTOM.closeTicket)
          .setLabel("Закрыть тикет")
          .setStyle(ButtonStyle.Danger),
      ),
    );

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  };
}

export async function openPaymentTicket(interaction, days) {
  const pkg = PACKAGES[String(days)];
  if (!pkg) {
    await interaction.reply({ content: "Неизвестный тариф.", ephemeral: true });
    return;
  }

  if (!config.ticketCategoryId) {
    await interaction.reply({
      content: "TICKET_CATEGORY_ID не задан в .env",
      ephemeral: true,
    });
    return;
  }

  const existing = interaction.guild.channels.cache.find(
    (ch) =>
      ch.parentId === config.ticketCategoryId &&
      typeof ch.topic === "string" &&
      ch.topic.startsWith(`vip:${interaction.user.id}:`),
  );
  if (existing) {
    await interaction.reply({
      content: `У тебя уже есть открытый тикет: ${existing}`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const channel = await interaction.guild.channels.create({
    name: `vip-${interaction.user.username}`
      .slice(0, 90)
      .toLowerCase()
      .replace(/[^a-z0-9\-а-яё]/gi, "-"),
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
  });

  const mention = `${interaction.user}${config.adminRoleIds.map((id) => ` <@&${id}>`).join("")}`;
  await channel.send(paymentPayload(pkg, { mention }));

  await interaction.editReply({ content: `Тикет создан: ${channel}` });
}

export async function handleShowPay(interaction) {
  const ticket = getTicket(interaction.channelId);
  const days = ticket?.package_days;
  const pkg = PACKAGES[String(days)] || null;
  if (!pkg) {
    await interaction.reply({
      content: "Не удалось определить тариф тикета.",
      ephemeral: true,
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
    ephemeral: true,
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
      ephemeral: true,
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

  const baseName = String(channel.name || "vip")
    .replace(/^архив-/, "")
    .slice(0, 90);
  const archivedName = `архив-${baseName}`.slice(0, 100);

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
