import { computeDeviceFit } from '../src/deviceFit.ts';
import type { CatalogModel } from '../src/types.ts';

type StoredRow = { id: string; model_json: string; parameter_count?: number | null };
type D1Result<T> = { results?: T[] };
type D1Response<T> = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: D1Result<T>[];
};
type Param = string | number | null;
type Statement = { sql: string; params: Param[] };

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const DATABASE_ID = '50f6b300-7c67-41c6-8431-7aa2bfd88a7f';
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;
const LIMIT = positiveInt(process.env.DEVICE_FIT_LIMIT, 0);
const DRY_RUN = process.env.DEVICE_FIT_DRY_RUN === '1';

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
    sql: `SELECT id, model_json, parameter_count FROM models ORDER BY repo_id${limit}`,
    params: [],
  });
}

function updateStatement(row: StoredRow): Statement | undefined {
  const model = JSON.parse(row.model_json) as CatalogModel;
  const parameterCount =
    typeof row.parameter_count === 'number' && Number.isFinite(row.parameter_count)
      ? row.parameter_count
      : model.parameterCount;
  const normalized = parameterCount === undefined ? model : { ...model, parameterCount };
  const deviceFit = computeDeviceFit(normalized);
  return {
    sql: `UPDATE models
      SET model_json = ?, device_fit_base = ?, device_fit_pro = ?, updated_at = ?
      WHERE id = ?`,
    params: [JSON.stringify({ ...normalized, deviceFit }), deviceFit.base, deviceFit.pro, new Date().toISOString(), row.id],
  };
}

async function main(): Promise<void> {
  const rows = await readModels();
  const statements = rows.flatMap((row) => {
    try {
      const statement = updateStatement(row);
      return statement ? [statement] : [];
    } catch {
      return [];
    }
  });
  if (!DRY_RUN) {
    for (let offset = 0; offset < statements.length; offset += 100) {
      await d1<unknown>({ batch: statements.slice(offset, offset + 100) });
    }
  }
  console.log(`[device-fit] models=${rows.length}, updated=${DRY_RUN ? 0 : statements.length}, dry_run=${DRY_RUN}`);
}

main().catch((error) => {
  console.error('[device-fit] failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
