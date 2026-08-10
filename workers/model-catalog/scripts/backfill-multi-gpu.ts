import { computeDeviceFit } from '../src/deviceFit.ts';
import type { CatalogModel } from '../src/types.ts';

type StoredRow = { id: string; repo_id: string; model_json: string };
type D1Result<T> = { results?: T[] };
type D1Response<T> = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: D1Result<T>[];
};
type Param = string | number | null;
type Statement = { sql: string; params: Param[] };
type Match = { row: StoredRow; model: CatalogModel };

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const DATABASE_ID = '50f6b300-7c67-41c6-8431-7aa2bfd88a7f';
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;
const LIMIT = positiveInt(process.env.MULTI_GPU_LIMIT, 0);
const DRY_RUN = process.env.MULTI_GPU_DRY_RUN === '1';
const WRITE_BATCH_SIZE = 50;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function d1<T>(body: Record<string, unknown>): Promise<T[]> {
  const response = await fetch(D1_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
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

async function readModels(): Promise<StoredRow[]> {
  const limit = LIMIT > 0 ? ` LIMIT ${LIMIT}` : '';
  return d1<StoredRow>({
    sql: `SELECT id, repo_id, model_json FROM models
      WHERE source = 'modelscope-gguf'
        AND json_extract(model_json, '$.supportsMultiGpu') IS NOT 1
      ORDER BY repo_id${limit}`,
    params: [],
  });
}

function findMatches(rows: StoredRow[]): Match[] {
  return rows.flatMap((row) => {
    try {
      return [{ row, model: JSON.parse(row.model_json) as CatalogModel }];
    } catch {
      return [];
    }
  });
}

function updateStatement(match: Match): Statement {
  const model = {
    ...match.model,
    supportsMultiGpu: true,
    multiGpuEvidence: 'GGUF 默认按双卡推理计算',
  } as CatalogModel;
  const deviceFit = computeDeviceFit(model);
  return {
    sql: `UPDATE models
      SET model_json = ?, device_fit_base = ?, device_fit_pro = ?, updated_at = ?
      WHERE id = ?`,
    params: [
      JSON.stringify({ ...model, deviceFit }),
      deviceFit.base,
      deviceFit.pro,
      new Date().toISOString(),
      match.row.id,
    ],
  };
}

async function main(): Promise<void> {
  const rows = await readModels();
  let matchedTotal = 0;
  let writtenTotal = 0;
  for (let offset = 0; offset < rows.length; offset += 100) {
    const matches = findMatches(rows.slice(offset, offset + 100));
    matchedTotal += matches.length;
    console.log(`[multi-gpu] batch=${Math.min(offset + 100, rows.length)}/${rows.length}, matched=${matches.length}`);
    if (!DRY_RUN) {
      const statements = matches.map(updateStatement);
      for (let batchOffset = 0; batchOffset < statements.length; batchOffset += WRITE_BATCH_SIZE) {
        const batch = statements.slice(batchOffset, batchOffset + WRITE_BATCH_SIZE);
        await d1<unknown>({ batch });
        writtenTotal += batch.length;
        console.log(`[multi-gpu] written_total=${writtenTotal}`);
      }
    }
  }
  console.log(`[multi-gpu] candidates=${rows.length}, matched=${matchedTotal}, updated=${DRY_RUN ? 0 : writtenTotal}, dry_run=${DRY_RUN}`);
}

main().catch((error) => {
  console.error('[multi-gpu] failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
