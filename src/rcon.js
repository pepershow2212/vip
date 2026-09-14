import { Agent, fetch as undiciFetch } from "undici";

const insecure = new Agent({
  connect: { rejectUnauthorized: false },
});

const schemeCache = new Map();

function cacheKey(server) {
  return `${server.host}:${server.port}`;
}

function errorDetail(text) {
  if (!text) return "";
  try {
    const body = JSON.parse(text);
    return body?.error?.message || body?.error?.code || text.slice(0, 160);
  } catch {
    return text.slice(0, 160);
  }
}

async function request(server, path, scheme, timeoutMs, options = {}) {
  const { method = "GET", body, raw, headers = {} } = options;
  const payload = raw != null ? raw : body != null ? JSON.stringify(body) : undefined;
  const url = `${scheme}://${server.host}:${server.port}${path}`;
  const response = await undiciFetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${server.password}`,
      ...(payload != null && raw == null ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: scheme === "https" ? insecure : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = errorDetail(text);
    throw new Error(`RCON ${response.status} ${method} ${path}${detail ? `: ${detail}` : ""}`);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export async function rconCall(server, path, options = {}) {
  const key = cacheKey(server);
  const preferred = schemeCache.get(key) || (server.tls ? "https" : "http");
  const order = preferred === "https" ? ["https", "http"] : ["http", "https"];
  let lastError;
  for (const scheme of order) {
    try {
      const body = await request(server, path, scheme, options.timeoutMs || 8000, options);
      schemeCache.set(key, scheme);
      return body;
    } catch (error) {
      lastError = error;
      if (schemeCache.has(key) && scheme === schemeCache.get(key)) break;
      if (!server.tls && scheme === "http") break;
    }
  }
  throw lastError;
}

export async function rconGet(server, path, timeoutMs = 8000) {
  return rconCall(server, path, { method: "GET", timeoutMs });
}

function reservedIdsFromConfig(text) {
  return [...String(text || "").matchAll(/^\s*[+.]DefaultReservedPlayerIds=(\d+)/gm)].map((row) => row[1]);
}

export function applyReservedIds(text, keepIds, { minSlots = 0 } = {}) {
  const keep = [...new Set((keepIds || []).map(String).filter(Boolean))];
  const needSlots = Math.max(Number(minSlots) || 0, keep.length);
  const lines = String(text || "").split(/\r?\n/);
  const without = lines.filter((line) => !/^\s*[+!.]?DefaultReservedPlayerIds=/.test(line));
  for (let i = 0; i < without.length; i++) {
    const match = without[i].match(/^(\s*MaxReservedSlots=)(\d+)/);
    if (!match) continue;
    const current = Number(match[2]) || 0;
    if (needSlots > current) without[i] = `${match[1]}${needSlots}`;
    break;
  }
  const extra = ["!DefaultReservedPlayerIds=ClearArray", ...keep.map((id) => `.DefaultReservedPlayerIds=${id}`)];
  const max = without.findIndex((line) => /^\s*MaxReservedSlots=/.test(line));
  const session = without.findIndex((line) => /\[\/Script\/WDGame\.WDGameSession\]/.test(line));
  if (max >= 0) without.splice(max, 0, ...extra);
  else if (session >= 0) without.splice(session + 1, 0, ...extra);
  else without.push("[/Script/WDGame.WDGameSession]", `MaxReservedSlots=${Math.max(needSlots, 20)}`, ...extra);
  return without.join("\n");
}

async function writeReservedViaConfig(server, keepIds, { minSlots = 0 } = {}) {
  const doc = await rconGet(server, "/v1/config", 8000);
  const next = applyReservedIds(doc?.text || "", keepIds, { minSlots });
  await rconCall(server, "/v1/config?force=true", {
    method: "PUT",
    raw: next,
    timeoutMs: 15000,
    headers: { "content-type": "text/plain" },
  });
}

export async function listReservedSlots(server) {
  const body = await rconGet(server, "/v1/reserved-slots", 4000);
  const ids = body?.reservedSlots || body?.steamIds || [];
  if (Array.isArray(ids) && ids.length) return ids.map(String);
  if (Array.isArray(ids)) {
    try {
      const doc = await rconGet(server, "/v1/config", 6000);
      const fromConfig = reservedIdsFromConfig(doc?.text || "");
      if (fromConfig.length) return fromConfig;
    } catch {
      // empty list from API is enough
    }
    return [];
  }
  const doc = await rconGet(server, "/v1/config", 6000);
  return reservedIdsFromConfig(doc?.text || "");
}

/** Дописывает SteamID в reserved slots, чужие ID не трогает. */
export async function addReservedSlot(server, steamId, { minSlots = 0 } = {}) {
  const want = String(steamId);
  const already = await listReservedSlots(server).catch(() => []);
  if (already.includes(want)) {
    if (minSlots > 0) await writeReservedViaConfig(server, already, { minSlots });
    return { already: true };
  }
  const next = [...already, want];
  await writeReservedViaConfig(server, next, { minSlots });
  const after = await listReservedSlots(server).catch(() => []);
  if (!after.includes(want)) throw new Error(`слот не записался на ${server.name}`);
  console.log(`reserve ok ${server.name} ${want} (+${already.length} already)`);
  return { already: false };
}

/** Снимает только этот SteamID, остальных VIP/царя не трогает. */
export async function dropReservedSlot(server, steamId) {
  const want = String(steamId);
  const ids = await listReservedSlots(server).catch(() => []);
  if (!ids.includes(want)) return { missing: true };
  await writeReservedViaConfig(server, ids.filter((id) => id !== want));
  return { missing: false };
}

export async function reserveOnEach(servers, steamId, on) {
  const results = [];
  for (const server of servers || []) {
    try {
      if (on) await addReservedSlot(server, steamId);
      else await dropReservedSlot(server, steamId);
      results.push({ id: server.id, name: server.name, ok: true });
    } catch (error) {
      console.warn("reserve", server.name, error instanceof Error ? error.message : error);
      results.push({
        id: server.id,
        name: server.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
