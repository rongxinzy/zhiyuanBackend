import {
  getModelScopeLegacyFiles,
  normalizeStoredModelWithFiles,
} from '../src/modelScope.ts';
import type { CatalogModel, ModelScopeFile } from '../src/types.ts';

type StoredRow = { id: string; repo_id: string; model_json: string };
type D1Result<T> = { results?: T[] };
type D1Response<T> = { success?: boolean; errors?: Array<{ message?: string }>; result?: D1Result<T>[] };
type Param = string | number | null;
type Statement = { sql: string; params: Param[] };

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const DATABASE_ID = '50f6b300-7c67-41c6-8431-7aa2bfd88a7f';
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;
const MODEL_SCOPE_TOKEN = process.env.MODELSCOPE_TOKEN || undefined;
const LIMIT = positiveInt(process.env.REFRESH_LIMIT, 0);
const CONCURRENCY = Math.max(1, Math.min(8, positiveInt(process.env.REFRESH_CONCURRENCY, 4)));
const WRITE_BATCH_SIZE = 25;
const DRY_RUN = process.env.REFRESH_DRY_RUN === '1';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLegacyFiles(owner: string, repo: string): Promise<ModelScopeFile[]> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fetcher: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) });
      return await getModelScopeLegacyFiles(MODEL_SCOPE_TOKEN, owner, repo, fetcher);
    } catch (error) {
      const status = (error as { status?: number }).status;
      const timedOut = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
      if (!timedOut && status !== 403 && status !== 429) throw error;
      await wait(Math.min(30_000, 2_000 * 2 ** attempt));
    }
  }
  return [];
}
function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function d1<T>(body: Record<string, unknown>): Promise<T[]> {
  const response = await fetch(D1_URL, {
    signal: AbortSignal.timeout(30_000),
    method: 'POST',
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as D1Response<T>;
  if (!response.ok || payload.success === false) {
    const message = payload.errors?.map((error) => error.message).filter(Boolean).join('; ');
    throw new Error(`D1 request failed (${response.status}): ${message || 'unknown error'}`);
  }
  return payload.result?.flatMap((result) => result.results ?? []) ?? [];
}

async function readPendingModels(): Promise<StoredRow[]> {
  const limit = LIMIT > 0 ? ` LIMIT ${LIMIT}` : '';
  return d1<StoredRow>({
    sql: `SELECT id, repo_id, model_json FROM models
      WHERE (json_extract(model_json, '$.metadataStatus') <> 'verified'
         OR json_extract(model_json, '$.metadataStatus') IS NULL)
        AND COALESCE(json_array_length(json_extract(model_json, '$.files')), 0) = 0
      ORDER BY repo_id${limit}`,
    params: [],
  });
}

function ownerRepo(repoId: string): [string, string] | null {
  const separator = repoId.indexOf('/');
  if (separator <= 0 || separator === repoId.length - 1) return null;
  return [repoId.slice(0, separator), repoId.slice(separator + 1)];
}

function refreshStatements(model: CatalogModel, files: ModelScopeFile[]): Statement[] {
  const updatedAt = new Date().toISOString();
  const updateParams: Param[] = [
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
    updatedAt,
    model.id,
  ];
  const statements: Statement[] = [
    {
      sql: `UPDATE models SET
        repo_id = ?, source = ?, name = ?, description = ?, tags_json = ?, sizes_json = ?,
        capability_json = ?, model_json = ?, downloads = ?, quality_score = ?, trust_score = ?,
        community_score = ?, featured = ?, featured_rank = ?, updated_at = ?
        WHERE id = ?`,
      params: updateParams,
    },
    { sql: 'DELETE FROM model_files WHERE model_id = ?', params: [model.id] },
  ];
  for (let offset = 0; offset < files.length; offset += 10) {
    const chunk = files.slice(offset, offset + 10);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
    statements.push({
      sql: `INSERT INTO model_files(model_id, path, size_bytes, sha256, quantization, is_recommended, download_url)
        VALUES ${values}
        ON CONFLICT(model_id, path) DO UPDATE SET
          size_bytes = excluded.size_bytes,
          sha256 = excluded.sha256,
          quantization = excluded.quantization,
          is_recommended = excluded.is_recommended,
          download_url = excluded.download_url`,
      params: chunk.flatMap((file): Param[] => [
        model.id,
        file.path,
        file.sizeBytes ?? null,
        file.sha256 ?? null,
        file.quantization ?? null,
        file.isRecommended ? 1 : 0,
        file.downloadUrl ?? null,
      ]),
    });
  }  return statements;
}
async function mapChunk(rows: StoredRow[]): Promise<{ statements?: Statement[]; reason?: string }[]> {
  const output = new Array<{ statements?: Statement[]; reason?: string }>(rows.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor++;
      const row = rows[index];
      try {
        const stored = JSON.parse(row.model_json) as CatalogModel;
        const parts = ownerRepo(row.repo_id);
        if (!parts) {
          output[index] = { reason: 'invalid_repo_id' };
          continue;
        }
        const files = await readLegacyFiles(parts[0], parts[1]);
        if (!files.length) {
          output[index] = { reason: 'no_gguf_files' };
          continue;
        }
        const model = normalizeStoredModelWithFiles(stored, files);
        output[index] = model
          ? { statements: refreshStatements(model, model.files ?? []) }
          : { reason: 'normalization_rejected' };
      } catch (error) {
        output[index] = { reason: error instanceof Error ? error.message : String(error) };
      }
    }
  });
  await Promise.all(workers);
  return output;
}
async function main(): Promise<void> {
  const rows = await readPendingModels();
  console.log(`[refresh] pending=${rows.length}, concurrency=${CONCURRENCY}, dry_run=${DRY_RUN}`);
  let refreshed = 0;
  let skipped = 0;
  for (let offset = 0; offset < rows.length; offset += 100) {
    const results = await mapChunk(rows.slice(offset, offset + 100));
    const refreshedResults = results.filter((result) => result.statements);
    if (!DRY_RUN) {
      let batch: Statement[] = [];
      let parameterCount = 0;
      const flush = async (): Promise<void> => {
        if (batch.length) await d1<unknown>({ batch });
        batch = [];
        parameterCount = 0;
      };
      for (const result of refreshedResults) {
        const modelStatements = result.statements ?? [];
        const modelParameterCount = modelStatements.reduce((sum, statement) => sum + statement.params.length, 0);
        if (batch.length && parameterCount + modelParameterCount > 800) await flush();
        batch.push(...modelStatements);
        parameterCount += modelParameterCount;
      }
      await flush();
    }
    refreshed += refreshedResults.length;
    skipped += results.length - refreshedResults.length;
    const reasons = results.filter((result) => result.reason).reduce<Record<string, number>>((counts, result) => {
      const reason = result.reason ?? 'unknown';
      counts[reason] = (counts[reason] ?? 0) + 1;
      return counts;
    }, {});
    console.log(`[refresh] processed=${Math.min(offset + 100, rows.length)}/${rows.length}, refreshed=${refreshed}, skipped=${skipped}, reasons=${JSON.stringify(reasons)}`);  }
  console.log(`[refresh] done refreshed=${refreshed}, skipped=${skipped}, dry_run=${DRY_RUN}`);
}
main().catch((error) => {
  console.error('[refresh] failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
