import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: resolve(root, ".env") });

function env(name, fallback = "") {
  const value = process.env[name];
  return value == null || value === "" ? fallback : value;
}

function flag(name) {
  return ["1", "true", "yes"].includes(String(process.env[name] || "").toLowerCase());
}

function csv(name) {
  return env(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function makeServer(id) {
  const key = String(id);
  const host = env(`SERVER_${key}_RCON_HOST`);
  const password = env(`SERVER_${key}_RCON_PASSWORD`);
  return {
    id: key,
    name: env(`SERVER_${key}_NAME`, `СЕРВЕР ${key}`),
    host,
    port: Number(env(`SERVER_${key}_RCON_PORT`, "7776")) || 7776,
    password,
    tls: flag(`SERVER_${key}_RCON_TLS`),
    enabled: Boolean(host && password),
  };
}

export const PACKAGES = {
  7: { days: 7, price: 200, label: "7 дней" },
  30: { days: 30, price: 600, label: "30 дней" },
  90: { days: 90, price: 1600, label: "90 дней" },
  "-1": { days: -1, price: 0, label: "ADMIN · навсегда", permanent: true },
};

export const PERMANENT_EXPIRES = "2099-12-31T23:59:59.000Z";

export const config = {
  root,
  discordToken: env("DISCORD_TOKEN") || env("DISCORD_BOT_TOKEN"),
  discordClientId: env("DISCORD_CLIENT_ID"),
  discordGuildId: env("DISCORD_GUILD_ID"),
  vipRoleId: env("VIP_ROLE_ID"),
  adminRoleIds: csv("ADMIN_ROLE_IDS"),
  adminUserIds: csv("ADMIN_USER_IDS"),
  // «Поддержи нас» — панель VIP
  panelChannelId: env("PANEL_CHANNEL_ID", "1541820559984435332"),
  // Категория тикетов оплаты
  ticketCategoryId: env("TICKET_CATEGORY_ID", "1490790855512952848"),
  // Куда переносить закрытые тикеты (опционально)
  archiveCategoryId: env("ARCHIVE_CATEGORY_ID", "1549146851058655272"),
  logChannelId: env("LOG_CHANNEL_ID", "1549139317404999790"),
  yoomoneyWallet: env("YOOMONEY_WALLET", "4100119612206096"),
  vipMaxSlots: Math.max(1, Number(env("VIP_MAX_SLOTS", "80")) || 80),
  databasePath: resolve(root, env("DATABASE_PATH", "./data/vip.db")),
  servers: [1, 2, 3, 4, 5, 6].map(makeServer),
};

export function vipServers() {
  return config.servers.filter((server) => server.enabled);
}

export function ensureDataDir() {
  mkdirSync(dirname(config.databasePath), { recursive: true });
}

export function envFileExists() {
  return existsSync(resolve(root, ".env"));
}
