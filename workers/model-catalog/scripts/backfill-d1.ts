/**
 * Local full-catalogue backfill for the model-catalog D1 library.
 *
 * Pulls every page of the ModelScope GGUF listing from the local machine and
 * upserts the summary records into D1 via `wrangler d1 execute`. This bypasses
 * the Worker CPU/quota limits entirely — the Worker-side sync stays as the
 * incremental path (hydrate-model queue + cron), while this script seeds the
 * library once (and can re-run safely: upserts are idempotent).
 *
 * Listing-only on purpose: per-model file metadata (files/sha256) is filled in
 * on demand by the catalogue (install resolution, hydrate-model queue), so the
 * backfill costs one upstream request per page instead of ~50.
 *
 * Usage (from zhiyuanBackend):
 *   node_modules/.bin/esbuild workers/model-catalog/scripts/backfill-d1.ts \
 *     --bundle --platform=node --format=esm --outfile=/tmp/backfill.mjs
 *   node /tmp/backfill.mjs
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

import { searchModelScope } from '../src/modelScope.ts';
import { computeDeviceFit } from '../src/deviceFit.ts';

const PAGE_SIZE = 50;
// ModelScope caps search paging at ~60-70 pages (HTTP 403 beyond) regardless
// of filters or sort; 60 pages × 50 is the full reachable catalogue.
const MAX_PAGES = 60;
const PAGE_SLEEP_MS = 2_000;
const BATCH_SIZE = 25;
// ModelScope bursts are IP-level (~60 requests per window, then 403 for a
// while). Pace the run in segments: after every PAGES_PER_RUN pages, cool down
// before the window trips, instead of relying on retry loops.
const PAGES_PER_RUN = 40;
const RUN_COOLDOWN_MS = 15 * 60_000;
// Multiple ModelScope tokens: rotate per page so a burst-limit on one token
// does not stall the backfill — a 403 simply switches to the next token.
const MODELSCOPE_TOKENS = (process.env.MODELSCOPE_TOKEN ?? '')
  .split(',')
  .map(token => token.trim())
  .filter(Boolean);
const PROGRESS_FILE = process.env.BACKFILL_PROGRESS_FILE ?? '/tmp/backfill-progress.json';
const WRANGLER = process.env.BACKFILL_WRANGLER ?? 'node_modules/.bin/wrangler';
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: process.env.WRANGLER_HOME ?? '/tmp/wrangler-home',
  WRANGLER_CACHE_DIR: process.env.WRANGLER_CACHE_DIR ?? '/tmp/wrangler-cache',
  WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? '/tmp/wrangler.log',
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function readProgress(): number {
  try {
    return Number(readFileSync(PROGRESS_FILE, 'utf8')) || 1;
  } catch {
    return 1;
  }
}

function writeProgress(page: number): void {
  writeFileSync(PROGRESS_FILE, String(page), 'utf8');
}

function runD1(sql: string): void {
  try {
    const out = execFileSync(WRANGLER, ['d1', 'execute', 'zhiyuan-model-catalog', '--remote', '--command', sql], {
      env: ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    const summary = out.toString();
    const written = /rows_written[\":\s]+(\d+)/.exec(summary)?.[1] ?? '?';
    console.error(`[backfill] D1 写入 rows_written=${written}`);
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
    console.error('[backfill] D1 写入失败,SQL 长度:', sql.length, '\n', stderr.slice(-800));
    throw error;
  }
}

export function buildInsertSql(models: Awaited<ReturnType<typeof searchModelScope>>['models']): string {
  const now = new Date().toISOString();
  const rows = models
    .map(model => {
      const id = sqlEscape(model.id);
      const repoId = sqlEscape(model.repoId);
      const name = sqlEscape(model.name);
      const description = sqlEscape(model.description ?? '');
      const tagsJson = sqlEscape(JSON.stringify(model.tags ?? []));
      const sizesJson = sqlEscape(JSON.stringify(model.sizes ?? []));
      const capabilityJson = sqlEscape(JSON.stringify(model.capabilities ?? [model.capability]));
      const deviceFit = computeDeviceFit(model);
      const modelJson = sqlEscape(JSON.stringify({ ...model, deviceFit }));
      const downloads = model.downloads ?? 0;
      const quality = model.qualityScore ?? null;
      const trust = model.trustScore ?? null;
      const community = model.communityScore ?? null;
      const featured = model.isFeatured ? 1 : 0;
      const featuredRank = model.featuredRank ?? null;
      return `('${id}','${repoId}','${sqlEscape(model.source)}','${name}','${description}','${tagsJson}','${sizesJson}','${capabilityJson}','${modelJson}',${downloads},${quality},${trust},${community},${featured},${featuredRank},'${now}','${deviceFit.base}','${deviceFit.pro}')`;
    })
    .join(',\n');
  return `INSERT INTO models(id, repo_id, source, name, description, tags_json, sizes_json, capability_json, model_json, downloads, quality_score, trust_score, community_score, featured, featured_rank, updated_at, device_fit_base, device_fit_pro)
VALUES ${rows}
ON CONFLICT(id) DO UPDATE SET
  repo_id = excluded.repo_id,
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
  device_fit_base = excluded.device_fit_base,
  device_fit_pro = excluded.device_fit_pro,
  updated_at = excluded.updated_at;`;
}

async function main(): Promise<void> {
  const startPage = readProgress();
  let page = startPage;
  let pagesInRun = 0;
  let total = 0;
  let upserted = 0;
  const buffer: Awaited<ReturnType<typeof searchModelScope>>['models'] = [];

  for (; page <= MAX_PAGES; page += 1) {
    let result;
    // Rotate tokens per page; on 403/429 try the next token before waiting.
    for (let attempt = 0; attempt < Math.max(1, MODELSCOPE_TOKENS.length) * 2; attempt += 1) {
      const token =
        MODELSCOPE_TOKENS.length > 0
          ? MODELSCOPE_TOKENS[(page + attempt) % MODELSCOPE_TOKENS.length]
          : undefined;
      try {
        result = await searchModelScope(token, '', page, PAGE_SIZE, 'all', fetch, false);
        break;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 403 || status === 429) {
          if (MODELSCOPE_TOKENS.length > 1) {
            console.error(`[backfill] 第 ${page} 页 token ${(page + attempt) % MODELSCOPE_TOKENS.length + 1} 被限流,切换到下一个`);
            continue;
          }
          // Single token: ModelScope blocks bursts (~60 requests per window);
          // short retries just burn the window, back off a full cooldown.
          const retryAfter = (error as { retryAfterSeconds?: number }).retryAfterSeconds;
          const waitMs = Math.max(10 * 60_000, (retryAfter ?? 600) * 1000);
          console.error(`[backfill] 第 ${page} 页被限流(HTTP ${status}),等待 ${Math.round(waitMs / 60_000)} 分钟`);
          await sleep(waitMs);
          continue;
        }
        if (attempt >= 6) throw error;
        console.error(`[backfill] 第 ${page} 页第 ${attempt} 次失败:`, String(error).slice(0, 120));
        await sleep(2000 * attempt);
      }
    }
    if (!result) {
      console.error(`[backfill] 第 ${page} 页重试耗尽,暂停 10 分钟后再续`);
      await sleep(10 * 60_000);
      continue;
    }
    writeProgress(page);
    pagesInRun += 1;
    if (pagesInRun % PAGES_PER_RUN === 0 && page < MAX_PAGES) {
      console.error(`[backfill] 已连续跑 ${PAGES_PER_RUN} 页,主动冷却 ${RUN_COOLDOWN_MS / 60_000} 分钟`);
      await sleep(RUN_COOLDOWN_MS);
    }
    total = result.total ?? total;
    if (result.models.length === 0) break;
    buffer.push(...result.models);
    upserted += result.models.length;

    if (buffer.length >= BATCH_SIZE) {
      const batch = buffer.splice(0, BATCH_SIZE);
      runD1(buildInsertSql(batch));
      console.log(
        `[backfill] 页 ${page}/${Math.ceil(total / PAGE_SIZE)} 已入库 ${upserted}/${total}`,
      );
    }
    await sleep(PAGE_SLEEP_MS);
  }
  if (buffer.length > 0) {
    runD1(buildInsertSql(buffer));
    console.log(`[backfill] 收尾批次 ${buffer.length} 条,累计 ${upserted}`);
  }
  writeProgress(page);
  console.log(`[backfill] 完成。共处理 ${upserted} 个模型,上游总数 ${total}`);
}

main().catch(error => {
  console.error('[backfill] 失败:', error);
  process.exit(1);
});
