import type { CatalogEnv, CatalogSyncMessage } from './env';
import {
  createCatalogResponse,
  getModelScopeDetail,
  isVerifiedGgufModel,
  ModelScopeHttpError,
  SCORE_VERSION,
  searchModelScope,
} from './modelScope';
import { withModelScope } from './tokenPool';
import type {
  CatalogModel,
  CatalogSearchResponse,
  CatalogSize,
  CatalogTask,
} from './types';

type DbModelRow = { model_json: string; updated_at?: string };
type DbPageRow = { response_json: string; checked_at: string; stale_after: string };

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization, x-zhiyuan-client-id',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
const NON_GENERATIVE_GGUF_PATTERN =
  /(?:^|[/\s._-])(?:embedding|embed|bge|e5|gte|rerank(?:er)?|sentence[-_ ]transformers?|clip|siglip|colbert|vector(?:izer)?|text[-_ ]embedding|flux|comfyui|stable[-_ ]diffusion|sdxl|controlnet|diffusion|vae|image[-_ ]generation|image[-_ ]to[-_ ]image|lora|adapter)(?=$|[/\s._-])/i;
// Model catalogue data changes rarely (a handful of new repos per day at
// most), so cached pages stay valid for a long time; the stale-while-error
// fallback below still serves them long after expiry when upstream is down.
const SEARCH_CACHE_TTL_SECONDS = 24 * 60 * 60;
const FEATURED_CACHE_TTL_SECONDS = 3 * 24 * 60 * 60;
const DETAIL_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_SEARCH_LIMIT = 50;
const MAX_RANK_MODELS = 50;
const MAX_JSON_BODY_BYTES = 128 * 1024;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...headers },
  });
}

function errorResponse(code: string, status: number, detail?: string): Response {
  return json(
    { error: code, ...(detail ? { detail } : {}) },
    status,
    { 'cache-control': 'no-store' },
  );
}

function normalizeQuery(value: string | null): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
}

function parseList(value: string | null): string[] {
  return value
    ? value
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 20)
    : [];
}

function parseTask(value: string | null): CatalogTask {
  const allowed: CatalogTask[] = ['all', 'chat', 'reasoning', 'embedding', 'code', 'vision'];
  return allowed.includes(value as CatalogTask) ? (value as CatalogTask) : 'all';
}

function parseSize(value: string | null): CatalogSize {
  const allowed: CatalogSize[] = ['all', 'small', 'desktop', 'workstation', 'large'];
  return allowed.includes(value as CatalogSize) ? (value as CatalogSize) : 'all';
}

function upstreamQuery(query: string, _task: CatalogTask): string {
  // Task filtering is handled by the upstream pipeline filter plus the local
  // capability check in matchesFilters. Appending the task keyword to the
  // query only narrows results to models whose name/description contains the
  // keyword (e.g. "vision"), silently dropping real vision-language models
  // like Qwen2.5-VL that never mention it.
  return query;
}

function modelFromRow(row: DbModelRow): CatalogModel | null {
  try {
    const model = JSON.parse(row.model_json) as CatalogModel;
    return model && typeof model === 'object' && isVerifiedGgufModel(model) ? model : null;
  } catch {
    return null;
  }
}

function responseFromPageRow(row: DbPageRow): CatalogSearchResponse | null {
  try {
    const value = JSON.parse(row.response_json) as CatalogSearchResponse;
    if (!value || !Array.isArray(value.models)) return null;
    return { ...value, models: value.models.filter(isVerifiedGgufModel) };
  } catch {
    return null;
  }
}

function matchesFilters(
  model: CatalogModel,
  task: CatalogTask,
  size: CatalogSize,
  tags: string[],
): boolean {
  if (!isVerifiedGgufModel(model)) return false;
  if (
    NON_GENERATIVE_GGUF_PATTERN.test(
      `${model.repoId} ${model.name} ${model.description} ${model.tags.join(' ')}`,
    )
  ) {
    return false;
  }
  if (task !== 'all' && !model.capability.includes(task)) return false;
  if (size !== 'all' && !model.sizes.includes(size)) return false;
  if (tags.length && !tags.some((tag) => model.tags.some((value) => value.toLowerCase() === tag))) {
    return false;
  }
  return true;
}

/**
 * Category and keyword pages are answered from the D1 model library, which
 * stores every verified GGUF model seen so far with its inferred capability.
 * This avoids relying on an upstream search that can match non-installable
 * records and whose totalCount counts them too.
 *
 * The corpus is small (tens of rows), so the whole matched set is loaded and
 * filtered in memory. That keeps totalCount consistent with the visible
 * models and keeps every page full, unlike SQL LIMIT/OFFSET which would
 * under-fill pages after capability/verified filtering.
 */
async function searchDbModels(
  env: CatalogEnv,
  input: {
    task: CatalogTask;
    size: CatalogSize;
    tags: string[];
    query: string;
    page: number;
    limit: number;
  },
): Promise<{ models: CatalogModel[]; totalCount: number }> {
  // task/size are whitelist enums from parseTask/parseSize, safe to inline.
  const conditions: string[] = [];
  if (input.task !== 'all') conditions.push(`capability_json LIKE '%"${input.task}"%'`);
  if (input.size !== 'all') conditions.push(`sizes_json LIKE '%"${input.size}"%'`);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await env.DB.prepare(
    `SELECT model_json FROM models ${where} ORDER BY downloads DESC`,
  ).all<{ model_json: string }>();
  const keyword = input.query.trim().toLowerCase();
  const filtered = (rows.results ?? [])
    .map((row) => {
      try {
        return JSON.parse(row.model_json) as CatalogModel;
      } catch {
        return null;
      }
    })
    .filter((model): model is CatalogModel => {
      if (!model || !matchesFilters(model, input.task, input.size, input.tags)) return false;
      if (!keyword) return true;
      const haystack = [
        model.repoId,
        model.name,
        model.description,
        model.recommendedTag,
        ...model.tags,
        ...model.sizes,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(keyword);
    });
  return {
    models: filtered.slice((input.page - 1) * input.limit, input.page * input.limit),
    totalCount: filtered.length,
  };
}

async function upsertModels(
  env: CatalogEnv,
  models: CatalogModel[],
  requireVerified = true,
): Promise<void> {
  const accepted = requireVerified
    ? models.filter(isVerifiedGgufModel)
    : models.filter(
        (model) => model.repoId && (model.metadataStatus === 'verified' || model.metadataStatus === 'pending'),
      );
  if (!accepted.length) return;
  const now = new Date().toISOString();
  const statements = accepted.map((model) =>
    env.DB.prepare(
      `INSERT INTO models(id, repo_id, source, name, description, tags_json, sizes_json, capability_json, model_json, downloads, quality_score, trust_score, community_score, featured, featured_rank, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         repo_id = excluded.repo_id,
         source = excluded.source,
         name = excluded.name,
         description = excluded.description,
         tags_json = excluded.tags_json,
         sizes_json = excluded.sizes_json,
         capability_json = excluded.capability_json,
         model_json = excluded.model_json,
         downloads = excluded.downloads,
         quality_score = excluded.quality_score,
         trust_score = excluded.trust_score,
         community_score = excluded.community_score,
         featured = CASE WHEN excluded.featured = 1 THEN 1 ELSE featured END,
         featured_rank = CASE WHEN excluded.featured = 1 THEN excluded.featured_rank ELSE featured_rank END,
         updated_at = excluded.updated_at`,
    ).bind(
      model.id,
      model.repoId,
      model.source,
      model.name,
      model.description,
      JSON.stringify(model.tags),
      JSON.stringify(model.sizes),
      JSON.stringify(model.capability),
      JSON.stringify(model),
      model.downloads ?? null,
      model.qualityScore ?? null,
      model.trustScore ?? null,
      model.communityScore ?? null,
      model.isFeatured ? 1 : 0,
      model.featuredRank ?? null,
      now,
    ),
  );
  await env.DB.batch(statements);

  const fileStatements = accepted.flatMap((model) =>
    (model.files ?? []).map((file) =>
      env.DB.prepare(
        `INSERT INTO model_files(model_id, path, size_bytes, sha256, quantization, is_recommended, download_url)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(model_id, path) DO UPDATE SET
           size_bytes = excluded.size_bytes,
           sha256 = excluded.sha256,
           quantization = excluded.quantization,
           is_recommended = excluded.is_recommended,
           download_url = excluded.download_url`,
      ).bind(
        model.id,
        file.path,
        file.sizeBytes ?? null,
        file.sha256 ?? null,
        file.quantization ?? null,
        file.isRecommended ? 1 : 0,
        file.downloadUrl ?? null,
      ),
    ),
  );
  if (fileStatements.length) await env.DB.batch(fileStatements);
}

async function readCatalogPage(env: CatalogEnv, cacheKey: string): Promise<{
  response: CatalogSearchResponse;
  fresh: boolean;
} | null> {
  const row = await env.DB.prepare(
    'SELECT response_json, checked_at, stale_after FROM catalog_pages WHERE cache_key = ? LIMIT 1',
  )
    .bind(cacheKey)
    .first<DbPageRow>();
  if (!row) return null;
  const response = responseFromPageRow(row);
  return response ? { response, fresh: Date.parse(row.stale_after) > Date.now() } : null;
}

async function writeCatalogPage(
  env: CatalogEnv,
  cacheKey: string,
  response: CatalogSearchResponse,
  ttlSeconds: number,
): Promise<void> {
  const checkedAt = new Date();
  const staleAfter = new Date(checkedAt.getTime() + ttlSeconds * 1000);
  await env.DB.prepare(
    `INSERT INTO catalog_pages(cache_key, response_json, checked_at, stale_after)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       response_json = excluded.response_json,
       checked_at = excluded.checked_at,
       stale_after = excluded.stale_after`,
  )
    .bind(cacheKey, JSON.stringify(response), checkedAt.toISOString(), staleAfter.toISOString())
    .run();
}

function searchCacheKey(input: {
  query: string;
  task: CatalogTask;
  size: CatalogSize;
  tags: string[];
  limit: number;
  page: number;
  featuredOnly: boolean;
}): string {
  return [
    input.featuredOnly ? 'featured' : 'search',
    input.query.toLowerCase(),
    input.task,
    input.size,
    [...input.tags].sort().join(','),
    input.limit,
    input.page,
  ].join('|');
}

function staleResponse(value: CatalogSearchResponse): CatalogSearchResponse {
  return {
    ...value,
    warning: 'ModelScope 暂时不可用，正在展示最近一次已验证的 GGUF 目录。',
    source: 'cloud-catalog',
    catalogUpdatedAt: value.catalogUpdatedAt,
  };
}

async function search(env: CatalogEnv, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = normalizeQuery(url.searchParams.get('q') ?? url.searchParams.get('query'));
  const task = parseTask(url.searchParams.get('task'));
  const size = parseSize(url.searchParams.get('size'));
  const tags = parseList(url.searchParams.get('tags'));
  const limit = Math.min(
    MAX_SEARCH_LIMIT,
    Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20),
  );
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const featuredOnly = url.searchParams.get('featured') === '1';
  const forceRefresh = url.searchParams.get('refresh') === '1';
  const cacheKey = searchCacheKey({ query, task, size, tags, limit, page, featuredOnly });
  const cached = await readCatalogPage(env, cacheKey);
  if (cached?.fresh && !forceRefresh) {
    return json(cached.response, 200, {
      'cache-control': 'public, max-age=60, s-maxage=300',
      'x-catalog-cache': 'd1-hit',
    });
  }

  try {
    let models: CatalogModel[] = [];
    let totalCount = 0;
    let hasNextPage = false;
    let needsUpsert = true;

    if (query.trim()) {
      // Keyword search: answer from the verified D1 GGUF library so totalCount
      // counts installable models only; fall back to the upstream search when
      // the library has not seen any matching model yet.
      const db = await searchDbModels(env, { task, size, tags, query, page, limit });
      if (db.totalCount > 0) {
        models = db.models;
        totalCount = db.totalCount;
        hasNextPage = page * limit < totalCount;
        needsUpsert = false;
      } else {
        const result = await withModelScope(env, (token) =>
          searchModelScope(token, query, page, limit, task),
        );
        models = result.models.filter((model) => matchesFilters(model, task, size, tags));
        totalCount = result.total ?? models.length;
        hasNextPage = totalCount > page * limit;
      }
    } else if (!featuredOnly && (task !== 'all' || size !== 'all' || tags.length > 0)) {
      // Category page: answer from the D1 model library by capability/size/tags.
      const db = await searchDbModels(env, { task, size, tags, query: '', page, limit });
      models = db.models;
      totalCount = db.totalCount;
      hasNextPage = page * limit < totalCount;
      if (db.totalCount === 0) {
        // Cold-start fallback while the library has not seen this category yet.
        const result = await withModelScope(env, (token) =>
          searchModelScope(token, '', page, limit, task),
        );
        models = result.models.filter((model) => matchesFilters(model, task, size, tags));
        totalCount = result.total ?? models.length;
        hasNextPage = totalCount > page * limit;
      } else {
        needsUpsert = false;
      }
    } else if (!featuredOnly) {
      // Browse (no query, no filters): answer from the verified D1 library —
      // every catalogue page is served without touching the upstream, which
      // is what keeps first paint and pagination fast even when ModelScope
      // rate-limits or is unreachable. Fall back to upstream only while the
      // library is still cold.
      const db = await searchDbModels(env, {
        task: 'all',
        size: 'all',
        tags: [],
        query: '',
        page,
        limit,
      });
      models = db.models;
      totalCount = db.totalCount;
      hasNextPage = page * limit < totalCount;
      if (db.totalCount === 0) {
        const result = await withModelScope(env, (token) =>
          searchModelScope(token, '', page, limit, task),
        );
        models = result.models.filter((model) => matchesFilters(model, task, size, tags));
        totalCount = result.total ?? models.length;
        hasNextPage = totalCount > page * limit;
      } else {
        needsUpsert = false;
      }
    } else {
      // Featured recommendations: curated upstream list, refreshed by cron.
      const result = await withModelScope(env, (token) =>
        searchModelScope(token, '', page, limit, task),
      );
      models = result.models.filter((model) => matchesFilters(model, task, size, tags));
      totalCount = featuredOnly ? models.length : (result.total ?? models.length);
      hasNextPage = !featuredOnly && totalCount > page * limit;
    }

    if (featuredOnly) {
      models = models.map((model, index) => ({
        ...model,
        isFeatured: true,
        featuredRank: index + 1,
      }));
    }
    if (needsUpsert) await upsertModels(env, models);
    const response: CatalogSearchResponse = {
      ...createCatalogResponse(models, totalCount),
      ...(hasNextPage ? { nextPageNumber: page + 1 } : {}),
      source: 'modelscope',
    };
    await writeCatalogPage(
      env,
      cacheKey,
      response,
      featuredOnly ? FEATURED_CACHE_TTL_SECONDS : SEARCH_CACHE_TTL_SECONDS,
    );
    return json(response, 200, {
      'cache-control': featuredOnly
        ? 'public, max-age=300, s-maxage=1800'
        : 'public, max-age=60, s-maxage=300',
      'x-catalog-cache': 'miss',
    });
  } catch {
    if (cached) {
      return json(staleResponse(cached.response), 200, {
        'cache-control': 'public, max-age=30, s-maxage=30',
        'x-catalog-cache': 'd1-stale',
      });
    }
    return errorResponse('catalog_unavailable', 503);
  }
}

async function bootstrap(env: CatalogEnv, request: Request): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = '/v1/catalog/search';
  url.searchParams.set('featured', '1');
  url.searchParams.set('limit', '24');
  return search(env, new Request(url.toString(), request));
}

async function readStoredModel(env: CatalogEnv, repoId: string): Promise<{
  model: CatalogModel;
  fresh: boolean;
} | null> {
  const row = await env.DB.prepare(
    'SELECT model_json, updated_at FROM models WHERE repo_id = ? LIMIT 1',
  )
    .bind(repoId)
    .first<DbModelRow>();
  if (!row) return null;
  const model = modelFromRow(row);
  if (!model) return null;
  return {
    model,
    fresh: Boolean(
      row.updated_at && Date.parse(row.updated_at) + DETAIL_CACHE_TTL_SECONDS * 1000 > Date.now(),
    ),
  };
}

function detailResponse(model: CatalogModel, filesOnly: boolean, cacheStatus: string): Response {
  const body = filesOnly
    ? {
        repoId: model.repoId,
        files: model.files ?? [],
        source: 'cloud-catalog',
        scoreVersion: SCORE_VERSION,
        metadataStatus: model.metadataStatus,
        runtime: model.runtime,
      }
    : model;
  return json(body, 200, {
    'cache-control': 'public, max-age=300, s-maxage=1800',
    'x-catalog-cache': cacheStatus,
  });
}

async function detail(
  env: CatalogEnv,
  owner: string,
  repo: string,
  filesOnly = false,
  forceRefresh = false,
): Promise<Response> {
  const repoId = `${owner}/${repo}`;
  const stored = await readStoredModel(env, repoId);
  if (stored?.fresh && !forceRefresh) {
    return detailResponse(stored.model, filesOnly, 'd1-hit');
  }
  try {
    const model = await withModelScope(env, (token) =>
      getModelScopeDetail(token, owner, repo),
    );
    if (!model) return errorResponse('model_not_found_or_not_installable', 404);
    await upsertModels(env, [model]);
    return detailResponse(model, filesOnly, 'miss');
  } catch (error) {
    if (stored) {
      const response = detailResponse(stored.model, filesOnly, 'd1-stale');
      const headers = new Headers(response.headers);
      headers.set('warning', '110 - "stale verified GGUF metadata"');
      return new Response(response.body, { status: response.status, headers });
    }
    const status = error instanceof ModelScopeHttpError ? error.status : 503;
    return errorResponse(status === 404 ? 'model_not_found' : 'catalog_unavailable', status === 404 ? 404 : 503);
  }
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  let difference = leftDigest.length ^ rightDigest.length;
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= leftDigest[index] ^ rightDigest[index];
  }
  return difference === 0;
}

async function authorizeAdmin(request: Request, env: CatalogEnv): Promise<boolean> {
  const expected = env.MODEL_CATALOG_ADMIN_TOKEN;
  const actual = request.headers.get('authorization') ?? '';
  return Boolean(expected && (await constantTimeEqual(actual, `Bearer ${expected}`)));
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_JSON_BODY_BYTES) return null;
  try {
    const body: unknown = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function feedback(request: Request, env: CatalogEnv): Promise<Response> {
  if (!(await authorizeAdmin(request, env))) return errorResponse('unauthorized', 401);
  const body = await readJsonBody(request);
  if (!body || typeof body.modelId !== 'string' || typeof body.event !== 'string') {
    return errorResponse('invalid_request', 400);
  }
  const modelId = body.modelId.trim().slice(0, 256);
  const event = body.event.trim().slice(0, 64);
  if (!modelId || !event) return errorResponse('invalid_request', 400);
  const metadata =
    body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? JSON.stringify(body.metadata).slice(0, 16_384)
      : '{}';
  await env.DB.prepare(
    'INSERT INTO model_feedback(model_id, event, rating, device_class, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(
      modelId,
      event,
      typeof body.rating === 'number' && Number.isFinite(body.rating) ? body.rating : null,
      typeof body.deviceClass === 'string' ? body.deviceClass.slice(0, 64) : null,
      metadata,
      new Date().toISOString(),
    )
    .run();
  return json({ ok: true }, 200, { 'cache-control': 'no-store' });
}

async function refreshFeatured(env: CatalogEnv): Promise<void> {
  const result = await withModelScope(env, (token) => searchModelScope(token, '', 1, 24));
  const models = result.models.map((model, index) => ({
    ...model,
    isFeatured: true,
    featuredRank: index + 1,
  }));
  await env.DB.prepare('UPDATE models SET featured = 0, featured_rank = NULL').run();
  await upsertModels(env, models);
  const response: CatalogSearchResponse = {
    ...createCatalogResponse(models, models.length),
    source: 'modelscope',
  };
  await writeCatalogPage(
    env,
    searchCacheKey({
      query: '',
      task: 'all',
      size: 'all',
      tags: [],
      limit: 24,
      page: 1,
      featuredOnly: true,
    }),
    response,
    FEATURED_CACHE_TTL_SECONDS,
  );
}

async function hydrateModel(env: CatalogEnv, repoId: string): Promise<void> {
  const stored = await readStoredModel(env, repoId);
  if (stored?.fresh) return;
  const [owner, repo] = repoId.split('/');
  if (!owner || !repo) return;
  let model: CatalogModel | null;
  try {
    model = await withModelScope(env, (token) => getModelScopeDetail(token, owner, repo));
  } catch (error) {
    if (error instanceof ModelScopeHttpError && error.status === 404) {
      // The model was removed upstream; drop the stale local record so the
      // catalog never surfaces entries that can no longer be installed.
      await env.DB.prepare('DELETE FROM model_files WHERE model_id = ?').bind(repoId).run();
      await env.DB.prepare('DELETE FROM models WHERE repo_id = ?').bind(repoId).run();
      return;
    }
    throw error;
  }
  if (model) await upsertModels(env, [model]);
}

const TOP_MODEL_SCAN_PAGES = 5;
const TOP_MODEL_SCAN_PAGE_SIZE = 50;
const QUEUE_SEND_BATCH_LIMIT = 100;
const CATALOGUE_SYNC_PAGE_SIZE = 50;
const CATALOGUE_SYNC_MAX_PAGES = 300;
const CATALOGUE_COVERAGE_THRESHOLD = 0.9;
const QUEUE_UPSTREAM_PACE_MS = 1_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Backfill the verified D1 library page by page until it covers the upstream
 * catalogue. Passive hydration only adds pages users actually visited, which
 * leaves category pages (code/vision/…) far too thin. The full sweep is
 * expensive (every search hit is hydrated with file metadata), so it runs only
 * while library coverage stays below the threshold; once covered, the top-model
 * scan in enqueueTopModels keeps the library fresh incrementally.
 */
async function enqueueCatalogueSync(env: CatalogEnv): Promise<void> {
  const first = await withModelScope(env, (token) =>
    searchModelScope(token, '', 1, CATALOGUE_SYNC_PAGE_SIZE, 'all', fetch, false),
  );
  const upstreamTotal = first.total ?? first.models.length;
  if (upstreamTotal <= 0) return;
  const stored = await env.DB.prepare('SELECT COUNT(*) AS n FROM models').first<{ n: number }>();
  const coverage = stored?.n ? stored.n / upstreamTotal : 0;
  if (coverage >= CATALOGUE_COVERAGE_THRESHOLD) return;
  await upsertModels(env, first.models, false);
  const totalPages = Math.min(
    CATALOGUE_SYNC_MAX_PAGES,
    Math.max(1, Math.ceil(upstreamTotal / CATALOGUE_SYNC_PAGE_SIZE)),
  );
  const messages: CatalogSyncMessage[] = [];
  for (let page = 2; page <= totalPages; page += 1) {
    messages.push({ kind: 'sync-page', page });
  }
  for (let offset = 0; offset < messages.length; offset += QUEUE_SEND_BATCH_LIMIT) {
    await env.MODEL_SYNC_QUEUE.sendBatch(
      messages.slice(offset, offset + QUEUE_SEND_BATCH_LIMIT).map((body) => ({ body })),
    );
  }
}

async function syncCataloguePage(env: CatalogEnv, page: number): Promise<void> {
  // Gentle soft rate-limit: queue consumers run several batches in parallel
  // and ModelScope throttles aggressive bursts, so pace each page request.
  await wait(QUEUE_UPSTREAM_PACE_MS);
  const result = await withModelScope(env, (token) =>
    searchModelScope(token, '', page, CATALOGUE_SYNC_PAGE_SIZE, 'all', fetch, false),
  );
  await upsertModels(env, result.models, false);
}

/**
 * Discover new models by scanning the top-downloaded GGUF list on ModelScope
 * for both the text-generation and image-text-to-text pipelines, then queue
 * hydration for every repo id. Hydration skips models already stored fresh,
 * so repeated runs only add genuinely new entries.
 */
async function enqueueTopModels(env: CatalogEnv): Promise<void> {
  const messages: CatalogSyncMessage[] = [];
  const seen = new Set<string>();
  // Only queue hydration for repos the library has not seen yet; blindly
  // re-enqueueing every scanned repo each cron run burned through the Queues
  // free-tier daily write quota (hydrateModel skips fresh rows anyway).
  const rows = await env.DB.prepare('SELECT repo_id FROM models').all<{ repo_id: string }>();
  const known = new Set((rows.results ?? []).map((row) => row.repo_id));
  for (const task of ['all', 'vision'] as const) {
    for (let page = 1; page <= TOP_MODEL_SCAN_PAGES; page += 1) {
      // Listing-only scan: hydrateDetails=false keeps the cron run well under
      // the worker time budget — per-repo detail work happens later inside the
      // hydrate-model queue consumer.
      const result = await withModelScope(env, (token) =>
        searchModelScope(token, '', page, TOP_MODEL_SCAN_PAGE_SIZE, task, fetch, false),
      );
      for (const model of result.models) {
        if (seen.has(model.repoId) || known.has(model.repoId)) continue;
        seen.add(model.repoId);
        messages.push({ kind: 'hydrate-model', repoId: model.repoId });
      }
    }
  }
  for (let offset = 0; offset < messages.length; offset += QUEUE_SEND_BATCH_LIMIT) {
    await env.MODEL_SYNC_QUEUE.sendBatch(
      messages.slice(offset, offset + QUEUE_SEND_BATCH_LIMIT).map((body) => ({ body })),
    );
  }
}

async function rank(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body || !Array.isArray(body.models) || body.models.length > MAX_RANK_MODELS) {
    return errorResponse('invalid_request', 400);
  }
  const models = body.models.filter(
    (model): model is CatalogModel =>
      Boolean(
        model &&
          typeof model === 'object' &&
          typeof (model as CatalogModel).repoId === 'string' &&
          isVerifiedGgufModel(model as CatalogModel),
      ),
  );
  const sorted = [...models].sort(
    (left, right) =>
      (right.score?.value ?? right.qualityScore ?? 0) -
      (left.score?.value ?? left.qualityScore ?? 0),
  );
  return json(
    { models: sorted, scoreVersion: SCORE_VERSION },
    200,
    { 'cache-control': 'no-store' },
  );
}

function rateLimitKey(request: Request): string {
  const clientId = request.headers.get('x-zhiyuan-client-id')?.trim();
  const stableClient = clientId && /^[a-zA-Z0-9._:-]{8,128}$/.test(clientId) ? clientId : 'public-desktop';
  return `${stableClient}:${new URL(request.url).pathname}`;
}

function edgeCacheRequest(request: Request): Request {
  const url = new URL(request.url);
  url.searchParams.delete('refresh');
  url.searchParams.sort();
  return new Request(url.toString(), { method: 'GET' });
}

async function route(request: Request, env: CatalogEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({
      ok: true,
      service: 'zhiyuan-model-catalog',
      scoreVersion: SCORE_VERSION,
      catalogPolicy: 'verified-single-file-gguf',
    });
  }
  if (request.method === 'GET' && url.pathname === '/v1/catalog/bootstrap') {
    return bootstrap(env, request);
  }
  if (request.method === 'GET' && url.pathname === '/v1/catalog/search') {
    return search(env, request);
  }
  if (request.method === 'GET' && url.pathname === '/v1/catalog/rank') {
    return errorResponse('method_not_allowed', 405);
  }
  if (request.method === 'POST' && url.pathname === '/v1/catalog/rank') {
    return rank(request);
  }
  if (request.method === 'POST' && url.pathname === '/v1/catalog/feedback') {
    return feedback(request, env);
  }
  const filesMatch = url.pathname.match(/^\/v1\/catalog\/models\/([^/]+)\/([^/]+)\/files$/);
  if (request.method === 'GET' && filesMatch) {
    return detail(
      env,
      decodeURIComponent(filesMatch[1]),
      decodeURIComponent(filesMatch[2]),
      true,
      url.searchParams.get('refresh') === '1',
    );
  }
  const detailMatch = url.pathname.match(/^\/v1\/catalog\/models\/([^/]+)\/([^/]+)$/);
  if (request.method === 'GET' && detailMatch) {
    return detail(
      env,
      decodeURIComponent(detailMatch[1]),
      decodeURIComponent(detailMatch[2]),
      false,
      url.searchParams.get('refresh') === '1',
    );
  }
  return errorResponse('not_found', 404);
}

export default {
  async fetch(request: Request, env: CatalogEnv, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    try {
      const limit = await env.CATALOG_RATE_LIMITER.limit({ key: rateLimitKey(request) });
      if (!limit.success) return errorResponse('rate_limited', 429);

      const url = new URL(request.url);
      const isCatalogGet =
        request.method === 'GET' &&
        (url.pathname === '/v1/catalog/bootstrap' ||
          url.pathname === '/v1/catalog/search' ||
          /^\/v1\/catalog\/models\/[^/]+\/[^/]+(?:\/files)?$/.test(url.pathname));
      const forceRefresh = url.searchParams.get('refresh') === '1';
      const cacheKey = isCatalogGet ? edgeCacheRequest(request) : null;
      if (cacheKey && !forceRefresh) {
        const cached = await caches.default.match(cacheKey);
        if (cached) {
          const headers = new Headers(cached.headers);
          headers.set('x-catalog-cache', 'edge-hit');
          return new Response(cached.body, { status: cached.status, headers });
        }
      }

      const response = await route(request, env);
      if (cacheKey && response.ok && !response.headers.has('warning')) {
        ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
      }
      return response;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'model_catalog.error',
          name: error instanceof Error ? error.name : 'unknown',
        }),
      );
      return errorResponse('catalog_unavailable', 503);
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: CatalogEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await env.MODEL_SYNC_QUEUE.send({ kind: 'refresh-featured' } satisfies CatalogSyncMessage);
    await enqueueTopModels(env);
    await enqueueCatalogueSync(env);
  },
  async queue(batch: MessageBatch<unknown>, env: CatalogEnv): Promise<void> {
    for (const message of batch.messages) {
      try {
        const body = message.body as CatalogSyncMessage;
        if (body.kind === 'refresh-featured') await refreshFeatured(env);
        if (body.kind === 'hydrate-model') await hydrateModel(env, body.repoId);
        if (body.kind === 'sync-page') await syncCataloguePage(env, body.page);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'model_catalog.queue_error',
            name: error instanceof Error ? error.name : 'unknown',
          }),
        );
        message.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<CatalogEnv>;
