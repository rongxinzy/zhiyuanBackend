/**
 * Rebuild catalogue parameter counts in B units without using ModelScope's
 * ambiguous `params` field. The operation is idempotent and updates both the
 * indexed D1 columns and model_json so later metadata refreshes preserve the
 * corrected value.
 *
 * Required environment variables:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN
 *
 * Optional environment variables:
 *   PARAMETER_COUNT_LIMIT    limit rows processed (0 = all)
 *   PARAMETER_COUNT_DRY_RUN  set to 1 to skip D1 writes
 */
type Scalar = string | number | null;
type D1Row = {
  id: string;
  repo_id: string;
  name: string;
  source: string;
  sizes_json: string;
  model_json: string;
};
type D1Result<T> = { results?: T[] };
type D1Response<T> = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: D1Result<T>[];
};
type Statement = { sql: string; params: Scalar[] };
type ParameterCountSource = 'explicit' | 'sizes' | 'name';
type ResolvedCount = { value: number; source: ParameterCountSource };

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const DATABASE_ID = '50f6b300-7c67-41c6-8431-7aa2bfd88a7f';
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;
const LIMIT = positiveInt(process.env.PARAMETER_COUNT_LIMIT, 0);
const DRY_RUN = process.env.PARAMETER_COUNT_DRY_RUN === '1';
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

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function countFromSizes(value: string): number | undefined {
  try {
    const sizes = JSON.parse(value) as unknown;
    if (!Array.isArray(sizes)) return undefined;
    for (const size of sizes) {
      const match = typeof size === 'string' && size.match(/^\s*(\d+(?:\.\d+)?)\s*b\s*$/i);
      if (!match) continue;
      const count = Number(match[1]);
      if (Number.isFinite(count) && count > 0) return count;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function countFromText(value: string): number | undefined {
  const match = value.match(/(?:^|[-_.])(\d+(?:\.\d+)?)b(?:[-_.]|$)/i);
  if (!match) return undefined;
  const count = Number(match[1]);
  return Number.isFinite(count) && count > 0 ? count : undefined;
}

function resolveCount(row: D1Row): ResolvedCount | undefined {
  try {
    const stored = JSON.parse(row.model_json) as {
      parameterCount?: unknown;
      parameterCountSource?: unknown;
      filePath?: unknown;
    };
    const explicit = positiveNumber(stored.parameterCount);
    if (stored.parameterCountSource === 'explicit' && explicit !== undefined) {
      return { value: explicit, source: 'explicit' };
    }
    // Curated records predate source markers but are manually maintained.
    if (row.source === 'curated' && explicit !== undefined) {
      return { value: explicit, source: 'explicit' };
    }
    const fromSizes = countFromSizes(row.sizes_json);
    if (fromSizes !== undefined) return { value: fromSizes, source: 'sizes' };
    const filePath = typeof stored.filePath === 'string' ? stored.filePath : '';
    const fromName = countFromText(`${row.repo_id} ${row.name} ${filePath}`);
    return fromName === undefined ? undefined : { value: fromName, source: 'name' };
  } catch {
    return undefined;
  }
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

async function readModels(): Promise<D1Row[]> {
  const limit = LIMIT > 0 ? ` LIMIT ${LIMIT}` : '';
  return d1<D1Row>({
    sql: `SELECT id, repo_id, name, source, sizes_json, model_json FROM models
      ORDER BY repo_id${limit}`,
    params: [],
  });
}

function statementFor(row: D1Row, resolved: ResolvedCount | undefined, updatedAt: string): Statement {
  if (!resolved) {
    return {
      sql: `UPDATE models SET parameter_count = NULL, parameter_count_known = 0,
        model_json = CASE WHEN json_valid(model_json) = 1
          THEN json_remove(model_json, '$.parameterCount', '$.parameterCountSource')
          ELSE model_json END,
        updated_at = ? WHERE id = ?`,
      params: [updatedAt, row.id],
    };
  }
  return {
    sql: `UPDATE models SET parameter_count = ?, parameter_count_known = 1,
      model_json = CASE WHEN json_valid(model_json) = 1
        THEN json_set(json_set(model_json, '$.parameterCount', ?), '$.parameterCountSource', ?)
        ELSE model_json END,
      updated_at = ? WHERE id = ?`,
    params: [resolved.value, resolved.value, resolved.source, updatedAt, row.id],
  };
}

async function main(): Promise<void> {
  const rows = await readModels();
  const resolved = rows.map((row) => resolveCount(row));
  const known = resolved.filter((value): value is ResolvedCount => Boolean(value));
  const bySource = known.reduce<Record<ParameterCountSource, number>>(
    (counts, value) => ({ ...counts, [value.source]: counts[value.source] + 1 }),
    { explicit: 0, sizes: 0, name: 0 },
  );
  console.log(
    `[parameter-count] rows=${rows.length}, known=${known.length}, unknown=${rows.length - known.length}, sources=${JSON.stringify(bySource)}, dry_run=${DRY_RUN}`,
  );
  if (DRY_RUN || !rows.length) return;

  const updatedAt = new Date().toISOString();
  for (let offset = 0; offset < rows.length; offset += WRITE_BATCH_SIZE) {
    const chunk = rows.slice(offset, offset + WRITE_BATCH_SIZE);
    await d1<unknown>({
      batch: chunk.map((row, index) => statementFor(row, resolved[offset + index], updatedAt)),
    });
    console.log(`[parameter-count] written=${Math.min(offset + chunk.length, rows.length)}/${rows.length}`);
  }
}

main().catch((error) => {
  console.error('[parameter-count] failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
