import { PermissionFlagsBits } from "discord.js";
import { config } from "./config.js";

/** Админ VIP: Discord Administrator / Manage Guild, либо ADMIN_ROLE_IDS / ADMIN_USER_IDS. */
export function isVipAdmin(member, userId) {
  if (!member && !userId) return false;
  const id = String(userId || member?.id || "");
  if (config.adminUserIds.includes(id)) return true;

  const perms = member?.permissions;
  if (perms?.has(PermissionFlagsBits.Administrator)) return true;
  if (perms?.has(PermissionFlagsBits.ManageGuild)) return true;

  if (config.adminRoleIds.length && member?.roles?.cache) {
    return config.adminRoleIds.some((roleId) => member.roles.cache.has(roleId));
  }
  return false;
}
