import Database from "better-sqlite3";
import { config, ensureDataDir } from "./config.js";

let db;

export function getDb() {
  if (db) return db;
  ensureDataDir();
  db = new Database(config.databasePath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS vips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      steam_id TEXT NOT NULL,
      days INTEGER NOT NULL,
      price INTEGER NOT NULL DEFAULT 0,
      starts_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      reminder_sent INTEGER NOT NULL DEFAULT 0,
      granted_by TEXT,
      ticket_channel_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT,
      revoke_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS vip_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      vip_id INTEGER,
      discord_id TEXT,
      steam_id TEXT,
      days INTEGER,
      expires_at TEXT,
      actor_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tickets (
      channel_id TEXT PRIMARY KEY,
      discord_id TEXT NOT NULL,
      package_days INTEGER NOT NULL,
      price INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_vips_active ON vips(active, expires_at);
    CREATE INDEX IF NOT EXISTS idx_vips_discord ON vips(discord_id, active);
    CREATE INDEX IF NOT EXISTS idx_vips_steam ON vips(steam_id, active);
  `);
  return db;
}

export function logVipAction({ action, vipId, discordId, steamId, days, expiresAt, actorId, details }) {
  getDb()
    .prepare(
      `INSERT INTO vip_logs (action, vip_id, discord_id, steam_id, days, expires_at, actor_id, details)
       VALUES (@action, @vipId, @discordId, @steamId, @days, @expiresAt, @actorId, @details)`,
    )
    .run({
      action,
      vipId: vipId ?? null,
      discordId: discordId ?? null,
      steamId: steamId ?? null,
      days: days ?? null,
      expiresAt: expiresAt ?? null,
      actorId: actorId ?? null,
      details: details ? JSON.stringify(details) : null,
    });
}

export function createTicket({ channelId, discordId, packageDays, price }) {
  getDb()
    .prepare(
      `INSERT INTO tickets (channel_id, discord_id, package_days, price, status)
       VALUES (?, ?, ?, ?, 'open')`,
    )
    .run(channelId, discordId, packageDays, price);
}

export function getTicket(channelId) {
  return getDb().prepare(`SELECT * FROM tickets WHERE channel_id = ?`).get(channelId) || null;
}

export function closeTicket(channelId, status = "closed") {
  getDb()
    .prepare(`UPDATE tickets SET status = ?, closed_at = datetime('now') WHERE channel_id = ?`)
    .run(status, channelId);
}

export function getVipById(id) {
  return getDb().prepare(`SELECT * FROM vips WHERE id = ?`).get(Number(id)) || null;
}

export function getActiveVipById(id) {
  return (
    getDb()
      .prepare(
        `SELECT * FROM vips
         WHERE id = ? AND active = 1 AND datetime(expires_at) > datetime('now')`,
      )
      .get(Number(id)) || null
  );
}

export function getActiveVipBySteam(steamId) {
  return (
    getDb()
      .prepare(
        `SELECT * FROM vips
         WHERE steam_id = ? AND active = 1 AND datetime(expires_at) > datetime('now')
         ORDER BY datetime(expires_at) DESC LIMIT 1`,
      )
      .get(String(steamId)) || null
  );
}

export function insertVip({ discordId, steamId, days, price, startsAt, expiresAt, grantedBy, ticketChannelId }) {
  const result = getDb()
    .prepare(
      `INSERT INTO vips
        (discord_id, steam_id, days, price, starts_at, expires_at, active, reminder_sent, granted_by, ticket_channel_id)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    )
    .run(
      String(discordId),
      String(steamId),
      days,
      price || 0,
      startsAt,
      expiresAt,
      grantedBy ? String(grantedBy) : null,
      ticketChannelId || null,
    );
  return result.lastInsertRowid;
}

export function deactivateVip(id, reason) {
  getDb()
    .prepare(
      `UPDATE vips SET active = 0, revoked_at = datetime('now'), revoke_reason = ? WHERE id = ?`,
    )
    .run(reason || null, id);
}

export function markReminderSent(id) {
  getDb().prepare(`UPDATE vips SET reminder_sent = 1 WHERE id = ?`).run(id);
}

export function listExpiringSoon(hours = 72) {
  return getDb()
    .prepare(
      `SELECT * FROM vips
       WHERE active = 1
         AND reminder_sent = 0
         AND datetime(expires_at) > datetime('now')
         AND datetime(expires_at) <= datetime('now', ?)`,
    )
    .all(`+${Number(hours)} hours`);
}

export function listExpiredActive() {
  return getDb()
    .prepare(
      `SELECT * FROM vips
       WHERE active = 1 AND datetime(expires_at) <= datetime('now')`,
    )
    .all();
}

export function countActiveVips() {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM vips
       WHERE active = 1 AND datetime(expires_at) > datetime('now')`,
    )
    .get().n;
}

export function listActiveVips(limit = 50) {
  return getDb()
    .prepare(
      `SELECT * FROM vips
       WHERE active = 1 AND datetime(expires_at) > datetime('now')
       ORDER BY datetime(expires_at) ASC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(Number(limit) || 50, 100)));
}

export function listVipHistory(limit = 20) {
  return getDb()
    .prepare(
      `SELECT * FROM vip_logs
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(Number(limit) || 20, 50)));
}
