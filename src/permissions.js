import { PermissionFlagsBits } from "discord.js";
import { config } from "./config.js";

export function isVipAdmin(member, userId) {
  if (!member && !userId) return false;
  const id = String(userId || member?.id || "");
  if (config.adminUserIds.includes(id)) return true;
  if (
    member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }
  if (member?.roles?.cache && config.adminRoleIds.length) {
    return config.adminRoleIds.some((roleId) => member.roles.cache.has(roleId));
  }
  return false;
}
