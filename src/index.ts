export interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
  AGENT_GATEWAY_TOKEN: string;
  POOL_ENCRYPTION_KEY: string;
}

type Json = Record<string, unknown>;
type KeyRow = {
  id: string; label: string; key_ciphertext: string; key_iv: string; status: string;
  max_concurrency: number; cooldown_until: number | null; last_selected_at: number | null;
  last_success_at: number | null; consecutive_failures: number; total_requests: number;
  total_failures: number; created_at: number; updated_at: number;
};

const ANYSEARCH_URL = "https://api.anysearch.com/v1/search";
const LEASE_MS = 30_000;
const UPSTREAM_TIMEOUT_MS = 20_000;
const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function response(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function requestId(): string { return crypto.randomUUID(); }

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromB64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
async function sha256(value: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
async function sameToken(supplied: string | null, expected: string): Promise<boolean> {
  if (!supplied) return false;
  const [left, right] = await Promise.all([sha256(supplied), sha256(expected)]);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
async function requireToken(request: Request, expected: string): Promise<boolean> {
  const header = request.headers.get("authorization");
  return sameToken(header?.startsWith("Bearer ") ? header.slice(7) : null, expected);
}
async function encryptionKey(secret: string): Promise<CryptoKey> {
  const material = fromB64(secret);
  if (material.byteLength !== 32) throw new Error("POOL_ENCRYPTION_KEY must be 32 random bytes encoded as base64");
  return crypto.subtle.importKey("raw", material.slice().buffer, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(value: string, secret: string, aad: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aadBytes = new TextEncoder().encode(aad);
  const valueBytes = new TextEncoder().encode(value);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv.slice().buffer, additionalData: aadBytes.slice().buffer }, await encryptionKey(secret), valueBytes.slice().buffer);
  return { ciphertext: b64(new Uint8Array(encrypted)), iv: b64(iv) };
}
async function decrypt(ciphertext: string, iv: string, secret: string, aad: string): Promise<string> {
  const aadBytes = new TextEncoder().encode(aad);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv).slice().buffer, additionalData: aadBytes.slice().buffer }, await encryptionKey(secret), fromB64(ciphertext).slice().buffer);
  return new TextDecoder().decode(clear);
}
function now(): number { return Date.now(); }
function utcDate(): string { return new Date().toISOString().slice(0, 10); }
function publicKey(row: KeyRow): Json {
  return { id: row.id, label: row.label, status: row.status, max_concurrency: row.max_concurrency, cooldown_until: row.cooldown_until, last_selected_at: row.last_selected_at, last_success_at: row.last_success_at, consecutive_failures: row.consecutive_failures, total_requests: row.total_requests, total_failures: row.total_failures, created_at: row.created_at, updated_at: row.updated_at };
}
function log(event: string, fields: Json): void { console.log(JSON.stringify({ event, ...fields })); }
async function bodyOf(request: Request): Promise<Json | null> {
  try { const value: unknown = await request.json(); return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null; }
  catch { return null; }
}
function getSearchInput(body: Json): { query: string; payload: Json } | null {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length > 500) return null;
  const max = typeof body.max_results === "number" ? body.max_results : 10;
  if (!Number.isInteger(max) || max < 1 || max > 20) return null;
  const payload: Json = { query, max_results: max, format: "json" };
  for (const field of ["tag", "zone", "language"] as const) if (typeof body[field] === "string" && body[field].length <= 100) payload[field] = body[field];
  if (body.params && typeof body.params === "object" && !Array.isArray(body.params)) payload.params = body.params;
  return { query, payload };
}
async function acquire(env: Env, leaseId: string): Promise<KeyRow | null> {
  const current = now();
  const candidate = await env.DB.prepare(`SELECT k.* FROM anysearch_keys k JOIN anysearch_key_slots s ON s.key_id = k.id WHERE (k.status = 'active' OR (k.status = 'cooldown' AND k.cooldown_until < ?)) AND (s.lease_expires_at IS NULL OR s.lease_expires_at < ?) ORDER BY COALESCE(k.last_selected_at, 0), k.id LIMIT 1`).bind(current, current).first<KeyRow>();
  if (!candidate) return null;
  const slot = await env.DB.prepare(`UPDATE anysearch_key_slots SET lease_id = ?, lease_expires_at = ? WHERE key_id = ? AND slot_no = (SELECT slot_no FROM anysearch_key_slots WHERE key_id = ? AND (lease_expires_at IS NULL OR lease_expires_at < ?) ORDER BY slot_no LIMIT 1) AND (lease_expires_at IS NULL OR lease_expires_at < ?) RETURNING slot_no`).bind(leaseId, current + LEASE_MS, candidate.id, candidate.id, current, current).first<{ slot_no: number }>();
  if (!slot) return acquire(env, leaseId);
  await env.DB.prepare("UPDATE anysearch_keys SET status = 'active', cooldown_until = NULL, last_selected_at = ?, total_requests = total_requests + 1, updated_at = ? WHERE id = ?").bind(current, current, candidate.id).run();
  return candidate;
}
async function release(env: Env, keyId: string, leaseId: string): Promise<void> {
  await env.DB.prepare("UPDATE anysearch_key_slots SET lease_id = NULL, lease_expires_at = NULL WHERE key_id = ? AND lease_id = ?").bind(keyId, leaseId).run();
}
async function updateOutcome(env: Env, key: KeyRow, status: number, retryAfter: string | null): Promise<void> {
  const timestamp = now();
  const usage = env.DB.prepare(`INSERT INTO anysearch_daily_usage (key_id, usage_date, request_count, failure_count) VALUES (?, ?, 1, ?) ON CONFLICT(key_id, usage_date) DO UPDATE SET request_count = request_count + 1, failure_count = failure_count + excluded.failure_count`).bind(key.id, utcDate(), status >= 400 ? 1 : 0);
  let keyUpdate: D1PreparedStatement;
  if (status >= 200 && status < 300) keyUpdate = env.DB.prepare("UPDATE anysearch_keys SET status = 'active', cooldown_until = NULL, last_success_at = ?, consecutive_failures = 0, updated_at = ? WHERE id = ?").bind(timestamp, timestamp, key.id);
  else if (status === 401 || status === 403) keyUpdate = env.DB.prepare("UPDATE anysearch_keys SET status = 'disabled', consecutive_failures = consecutive_failures + 1, total_failures = total_failures + 1, updated_at = ? WHERE id = ?").bind(timestamp, key.id);
  else if (status === 402) keyUpdate = env.DB.prepare("UPDATE anysearch_keys SET status = 'exhausted', consecutive_failures = consecutive_failures + 1, total_failures = total_failures + 1, updated_at = ? WHERE id = ?").bind(timestamp, key.id);
  else if (status === 429) {
    const seconds = Math.min(3600, Math.max(10, Number.parseInt(retryAfter ?? "60", 10) || 60));
    keyUpdate = env.DB.prepare("UPDATE anysearch_keys SET status = 'cooldown', cooldown_until = ?, consecutive_failures = consecutive_failures + 1, total_failures = total_failures + 1, updated_at = ? WHERE id = ?").bind(timestamp + seconds * 1000, timestamp, key.id);
  } else keyUpdate = env.DB.prepare("UPDATE anysearch_keys SET consecutive_failures = consecutive_failures + 1, total_failures = total_failures + 1, updated_at = ? WHERE id = ?").bind(timestamp, key.id);
  await env.DB.batch([usage, keyUpdate]);
}
async function upstreamSearch(env: Env, key: KeyRow, payload: Json): Promise<Response> {
  const token = await decrypt(key.key_ciphertext, key.key_iv, env.POOL_ENCRYPTION_KEY, `anysearch-key:${key.id}:v1`);
  const abort = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  return fetch(ANYSEARCH_URL, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload), signal: abort });
}
async function handleSearch(request: Request, env: Env, id: string): Promise<Response> {
  if (!(await requireToken(request, env.AGENT_GATEWAY_TOKEN))) return response({ error: { code: "unauthorized", message: "Agent authentication required" }, request_id: id }, 401);
  const body = await bodyOf(request); const input = body && getSearchInput(body);
  if (!input) return response({ error: { code: "invalid_request", message: "query is required (1-500 chars); max_results must be 1-20" }, request_id: id }, 400);
  for (let attempt = 0; attempt < 2; attempt++) {
    const leaseId = requestId(); const key = await acquire(env, leaseId);
    if (!key) return response({ error: { code: "pool_unavailable", message: "No usable AnySearch key is currently available" }, request_id: id }, 503);
    const started = now();
    try {
      const upstream = await upstreamSearch(env, key, input.payload);
      const payload: unknown = await upstream.json().catch(() => ({ code: upstream.status, message: "AnySearch returned an invalid JSON response" }));
      await updateOutcome(env, key, upstream.status, upstream.headers.get("retry-after"));
      log("anysearch.search", { request_id: id, key_id: key.id, upstream_status: upstream.status, duration_ms: now() - started, upstream_request_id: upstream.headers.get("x-request-id") });
      if (upstream.status >= 500 && attempt === 0) continue;
      return response({ ...(payload && typeof payload === "object" ? payload as Json : { data: payload }), gateway_request_id: id }, upstream.status);
    } catch (error) {
      await updateOutcome(env, key, 503, null);
      log("anysearch.upstream_error", { request_id: id, key_id: key.id, duration_ms: now() - started, error: error instanceof Error ? error.name : "unknown" });
      if (attempt === 1) return response({ error: { code: "upstream_unavailable", message: "AnySearch is temporarily unavailable" }, request_id: id }, 502);
    } finally { await release(env, key.id, leaseId); }
  }
  return response({ error: { code: "upstream_unavailable", message: "AnySearch is temporarily unavailable" }, request_id: id }, 502);
}
async function addKey(request: Request, env: Env, id: string): Promise<Response> {
  const body = await bodyOf(request); const rawKey = body && typeof body.key === "string" ? body.key.trim() : "";
  const label = body && typeof body.label === "string" ? body.label.trim() : "";
  const concurrency = body && typeof body.max_concurrency === "number" ? body.max_concurrency : 2;
  if (!rawKey || rawKey.length > 500 || !label || label.length > 100 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) return response({ error: { code: "invalid_request", message: "label, key, and max_concurrency (1-50) are required" }, request_id: id }, 400);
  const keyId = crypto.randomUUID(); const timestamp = now(); const encrypted = await encrypt(rawKey, env.POOL_ENCRYPTION_KEY, `anysearch-key:${keyId}:v1`);
  const statements: D1PreparedStatement[] = [env.DB.prepare("INSERT INTO anysearch_keys (id, label, key_ciphertext, key_iv, max_concurrency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(keyId, label, encrypted.ciphertext, encrypted.iv, concurrency, timestamp, timestamp)];
  for (let slot = 1; slot <= concurrency; slot++) statements.push(env.DB.prepare("INSERT INTO anysearch_key_slots (key_id, slot_no) VALUES (?, ?)").bind(keyId, slot));
  await env.DB.batch(statements);
  log("pool.key_added", { request_id: id, key_id: keyId, max_concurrency: concurrency });
  return response({ data: { id: keyId, label, status: "active", max_concurrency: concurrency }, request_id: id }, 201);
}
async function admin(request: Request, env: Env, id: string, path: string): Promise<Response> {
  if (!(await requireToken(request, env.ADMIN_TOKEN))) return response({ error: { code: "unauthorized", message: "Admin authentication required" }, request_id: id }, 401);
  if (request.method === "POST" && path === "/admin/keys") return addKey(request, env, id);
  if (request.method === "GET" && path === "/admin/keys") {
    const rows = await env.DB.prepare("SELECT * FROM anysearch_keys ORDER BY created_at DESC").all<KeyRow>();
    return response({ data: rows.results.map(publicKey), request_id: id });
  }
  const match = path.match(/^\/admin\/keys\/([^/]+)$/);
  if (match && request.method === "PATCH") {
    const body = await bodyOf(request); const status = body?.status;
    const concurrency = body?.max_concurrency;
    if (status !== undefined && (typeof status !== "string" || !["active", "cooldown", "exhausted", "disabled"].includes(status))) return response({ error: { code: "invalid_request", message: "status must be active, cooldown, exhausted, or disabled" }, request_id: id }, 400);
    if (concurrency !== undefined && (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50)) return response({ error: { code: "invalid_request", message: "max_concurrency must be an integer from 1 to 50" }, request_id: id }, 400);
    if (status === undefined && concurrency === undefined) return response({ error: { code: "invalid_request", message: "provide status and/or max_concurrency" }, request_id: id }, 400);
    const key = await env.DB.prepare("SELECT * FROM anysearch_keys WHERE id = ?").bind(match[1]).first<KeyRow>();
    if (!key) return response({ error: { code: "not_found", message: "Key not found" }, request_id: id }, 404);
    if (typeof concurrency === "number" && concurrency < key.max_concurrency) return response({ error: { code: "invalid_request", message: "Reducing concurrency requires draining leases and is not supported by this endpoint" }, request_id: id }, 409);
    const timestamp = now();
    const statements: D1PreparedStatement[] = [env.DB.prepare("UPDATE anysearch_keys SET status = COALESCE(?, status), cooldown_until = CASE WHEN ? = 'active' THEN NULL ELSE cooldown_until END, max_concurrency = COALESCE(?, max_concurrency), updated_at = ? WHERE id = ?").bind(status ?? null, status ?? null, concurrency ?? null, timestamp, key.id)];
    if (typeof concurrency === "number") for (let slot = key.max_concurrency + 1; slot <= concurrency; slot++) statements.push(env.DB.prepare("INSERT INTO anysearch_key_slots (key_id, slot_no) VALUES (?, ?)").bind(key.id, slot));
    await env.DB.batch(statements);
    log("pool.key_updated", { request_id: id, key_id: key.id, status: status ?? key.status, max_concurrency: concurrency ?? key.max_concurrency });
    return response({ data: { id: key.id, status: status ?? key.status, max_concurrency: concurrency ?? key.max_concurrency }, request_id: id });
  }
  return response({ error: { code: "not_found", message: "Unknown admin endpoint" }, request_id: id }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = requestId(); const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") return response({ ok: true, service: "zhiyuan-anysearch-gateway", request_id: id });
      if (request.method === "POST" && url.pathname === "/v1/search") return handleSearch(request, env, id);
      if (url.pathname.startsWith("/admin/")) return admin(request, env, id, url.pathname);
      return response({ error: { code: "not_found", message: "Unknown endpoint" }, request_id: id }, 404);
    } catch (error) {
      log("gateway.unhandled_error", { request_id: id, error: error instanceof Error ? error.name : "unknown" });
      return response({ error: { code: "internal_error", message: "Internal gateway error" }, request_id: id }, 500);
    }
  }
} satisfies ExportedHandler<Env>;
