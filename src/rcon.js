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

function uniqIds(ids) {
  return [...new Set((ids || []).map(String).filter(Boolean))];
}

/**
 * Переписывает только DefaultReservedPlayerIds.
 * MaxReservedSlots и остальной конфиг не трогает.
 */
export function applyReservedIds(text, keepIds) {
  const keep = uniqIds(keepIds);
  const lines = String(text || "").split(/\r?\n/);
  const without = lines.filter((line) => !/^\s*[+!.]?DefaultReservedPlayerIds=/.test(line));
  const extra = ["!DefaultReservedPlayerIds=ClearArray", ...keep.map((id) => `.DefaultReservedPlayerIds=${id}`)];
  const max = without.findIndex((line) => /^\s*MaxReservedSlots=/.test(line));
  const session = without.findIndex((line) => /\[\/Script\/WDGame\.WDGameSession\]/.test(line));
  if (max >= 0) without.splice(max, 0, ...extra);
  else if (session >= 0) without.splice(session + 1, 0, ...extra);
  else without.push("[/Script/WDGame.WDGameSession]", ...extra);
  return without.join("\n");
}

/**
 * Собирает полный список reserved: API ∪ конфиг.
 * Так не теряем ID, добавленные вручную в панели.
 */
export async function listReservedSlots(server) {
  const fromApi = [];
  const fromConfig = [];

  try {
    const body = await rconGet(server, "/v1/reserved-slots", 4000);
    const ids = body?.reservedSlots || body?.steamIds || [];
    if (Array.isArray(ids)) fromApi.push(...ids.map(String));
  } catch {
    // fallback to config
  }

  try {
    const doc = await rconGet(server, "/v1/config", 6000);
    fromConfig.push(...reservedIdsFromConfig(doc?.text || ""));
  } catch {
    // ignore
  }

  return uniqIds([...fromApi, ...fromConfig]);
}

async function writeReservedExact(server, beforeIds, nextIds, steamId, mode) {
  const before = uniqIds(beforeIds);
  const next = uniqIds(nextIds);
  const want = String(steamId);

  // Защита: кроме целевого SteamID никто не должен пропасть / появиться лишним
  const removed = before.filter((id) => !next.includes(id));
  const added = next.filter((id) => !before.includes(id));

  if (mode === "add") {
    if (removed.length) {
      throw new Error(
        `abort add ${server.name}: нельзя затереть чужие reserved (${removed.join(",")})`,
      );
    }
    if (!added.includes(want) && !next.includes(want)) {
      throw new Error(`abort add ${server.name}: целевой ID не в списке`);
    }
    if (added.some((id) => id !== want)) {
      throw new Error(`abort add ${server.name}: лишние ID в записи`);
    }
  }

  if (mode === "drop") {
    if (removed.length !== 1 || removed[0] !== want) {
      throw new Error(
        `abort drop ${server.name}: снимаем только свой ID, а не [${removed.join(",")}]`,
      );
    }
    if (added.length) {
      throw new Error(`abort drop ${server.name}: неожиданные новые ID`);
    }
  }

  // Пустой список после drop — ок только если до этого был ровно один (наш) ID
  if (mode === "drop" && next.length === 0 && before.length > 1) {
    throw new Error(`abort drop ${server.name}: список стал пустым, хотя были чужие ID`);
  }

  const doc = await rconGet(server, "/v1/config", 8000);
  const configText = doc?.text || "";
  const configIds = reservedIdsFromConfig(configText);

  // Ещё раз сверяем с конфигом прямо перед записью (ручные ID из панели)
  const live = uniqIds([...configIds, ...before]);
  let finalIds;
  if (mode === "add") {
    finalIds = live.includes(want) ? live : [...live, want];
  } else {
    finalIds = live.filter((id) => id !== want);
  }

  // Финальная защита по live-конфигу
  const lost = live.filter((id) => id !== want && !finalIds.includes(id));
  if (lost.length) {
    throw new Error(`abort ${mode} ${server.name}: потеряли чужие ID ${lost.join(",")}`);
  }

  const payload = applyReservedIds(configText, finalIds);
  await rconCall(server, "/v1/config?force=true", {
    method: "PUT",
    raw: payload,
    timeoutMs: 15000,
    headers: { "content-type": "text/plain" },
  });

  return finalIds;
}

/** Дописывает только SteamID из базы VIP. Чужие (панель / царь) не трогает. */
export async function addReservedSlot(server, steamId) {
  const want = String(steamId);
  const already = await listReservedSlots(server);
  if (already.includes(want)) {
    console.log(`reserve skip ${server.name} ${want} (уже есть, чужих не трогаем)`);
    return { already: true };
  }
  await writeReservedExact(server, already, [...already, want], want, "add");
  const after = await listReservedSlots(server);
  if (!after.includes(want)) throw new Error(`слот не записался на ${server.name}`);
  const lost = already.filter((id) => !after.includes(id));
  if (lost.length) {
    throw new Error(`после add потеряны чужие ID на ${server.name}: ${lost.join(",")}`);
  }
  console.log(`reserve ok ${server.name} ${want} (+${already.length} already)`);
  return { already: false };
}

/** Снимает только этот SteamID из базы VIP. Остальных из панели не трогает. */
export async function dropReservedSlot(server, steamId) {
  const want = String(steamId);
  const ids = await listReservedSlots(server);
  if (!ids.includes(want)) return { missing: true };

  const next = ids.filter((id) => id !== want);
  await writeReservedExact(server, ids, next, want, "drop");

  const after = await listReservedSlots(server);
  if (after.includes(want)) throw new Error(`слот не снялся на ${server.name}`);
  const lost = next.filter((id) => !after.includes(id));
  if (lost.length) {
    throw new Error(`после drop потеряны чужие ID на ${server.name}: ${lost.join(",")}`);
  }
  console.log(`reserve drop ${server.name} ${want} (осталось ${after.length})`);
  return { missing: false };
}

export async function reserveOnEach(servers, steamId, on) {
  const results = [];
  for (const server of servers || []) {
    try {
      const detail = on
        ? await addReservedSlot(server, steamId)
        : await dropReservedSlot(server, steamId);
      results.push({
        id: server.id,
        name: server.name,
        ok: true,
        already: Boolean(detail?.already),
        missing: Boolean(detail?.missing),
      });
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

/** Откатывает успешные ADD (только те, где ID реально дописали, не «уже был»). */
export async function rollbackAddedSlots(servers, steamId, addResults) {
  const byId = new Map((servers || []).map((s) => [String(s.id), s]));
  for (const row of addResults || []) {
    if (!row.ok || row.already) continue;
    const server = byId.get(String(row.id));
    if (!server) continue;
    try {
      await dropReservedSlot(server, steamId);
    } catch (error) {
      console.warn(
        "rollback add",
        server.name,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/**
 * Дописывает все VIP SteamID на один сервер одним PUT.
 * Чужие reserved (панель / царь) не трогает — только merge.
 */
export async function mergeVipIdsOnServer(server, steamIds) {
  const want = uniqIds(steamIds);
  const before = await listReservedSlots(server);
  const missing = want.filter((id) => !before.includes(id));
  if (!missing.length) {
    console.log(`sync skip ${server.name}: все ${want.length} VIP уже в reserved`);
    return {
      already: true,
      added: 0,
      missing: 0,
      reservedBefore: before.length,
      reservedAfter: before.length,
    };
  }

  const doc = await rconGet(server, "/v1/config", 8000);
  const configText = doc?.text || "";
  const configIds = reservedIdsFromConfig(configText);
  const live = uniqIds([...configIds, ...before]);
  const finalIds = uniqIds([...live, ...want]);

  const lost = live.filter((id) => !finalIds.includes(id));
  if (lost.length) {
    throw new Error(`abort sync ${server.name}: потеряли чужие ID ${lost.join(",")}`);
  }

  const payload = applyReservedIds(configText, finalIds);
  await rconCall(server, "/v1/config?force=true", {
    method: "PUT",
    raw: payload,
    timeoutMs: 20000,
    headers: { "content-type": "text/plain" },
  });

  const after = await listReservedSlots(server);
  const stillMissing = want.filter((id) => !after.includes(id));
  if (stillMissing.length) {
    throw new Error(
      `sync ${server.name}: не записались ${stillMissing.slice(0, 5).join(",")}${stillMissing.length > 5 ? "…" : ""}`,
    );
  }
  const lostAfter = live.filter((id) => !after.includes(id));
  if (lostAfter.length) {
    throw new Error(`после sync потеряны ID на ${server.name}: ${lostAfter.join(",")}`);
  }

  const added = after.length - before.length;
  console.log(
    `sync ok ${server.name}: +${missing.length} VIP (reserved ${before.length} → ${after.length})`,
  );
  return {
    already: false,
    added: missing.length,
    missing: missing.length,
    reservedBefore: before.length,
    reservedAfter: after.length,
    delta: added,
  };
}

/** Прогоняет VIP-базу на все переданные серверы. */
export async function syncVipIdsToServers(servers, steamIds) {
  const results = [];
  for (const server of servers || []) {
    try {
      const detail = await mergeVipIdsOnServer(server, steamIds);
      results.push({
        id: server.id,
        name: server.name,
        ok: true,
        ...detail,
      });
    } catch (error) {
      console.warn("sync", server.name, error instanceof Error ? error.message : error);
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
