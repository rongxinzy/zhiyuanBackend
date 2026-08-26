/**
 * Fill models.published_at from ModelScope's authoritative detail created_at.
 *
 * Required environment variables:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN
 *
 * Optional environment variables:
 *   PUBLISHED_AT_LIMIT          limit rows fetched from D1 (0 = all)
 *   PUBLISHED_AT_CONCURRENCY    concurrent ModelScope requests (default 2)
 *   PUBLISHED_AT_DRY_RUN        set to 1 to skip D1 writes
 */
type Scalar = string | number | null;
type D1Row = { repo_id: string };
type D1Result<T> = { results?: T[] };
type D1Response<T> = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: D1Result<T>[];
};
type Statement = { sql: string; params: Scalar[] };
type Match = { repoId: string; publishedAt: string };

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const DATABASE_ID = '50f6b300-7c67-41c6-8431-7aa2bfd88a7f';
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;
const LIMIT = positiveInt(process.env.PUBLISHED_AT_LIMIT, 0);
const CONCURRENCY = Math.max(1, Math.min(4, positiveInt(process.env.PUBLISHED_AT_CONCURRENCY, 2)));
const DRY_RUN = process.env.PUBLISHED_AT_DRY_RUN === '1';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function readMissingModels(): Promise<D1Row[]> {
  const limit = LIMIT > 0 ? ` LIMIT ${LIMIT}` : '';
  return d1<D1Row>({
    sql: `SELECT repo_id FROM models
      WHERE published_at IS NULL
      ORDER BY repo_id${limit}`,
    params: [],
  });
}

function retryAfter(response: Response): number {
  const value = Number(response.headers.get('retry-after'));
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 60) : 0;
}

function publishedAtFromDetail(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const root = payload as { data?: unknown };
  const data = root.data && typeof root.data === 'object' ? root.data as { created_at?: unknown } : undefined;
  if (typeof data?.created_at !== 'string') return undefined;
  const timestamp = Date.parse(data.created_at);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

async function readPublishedAt(repoId: string): Promise<Match | undefined> {
  const separator = repoId.indexOf('/');
  if (separator <= 0 || separator === repoId.length - 1) return undefined;
  const owner = encodeURIComponent(repoId.slice(0, separator));
  const repo = encodeURIComponent(repoId.slice(separator + 1));
  const url = `https://modelscope.cn/openapi/v1/models/${owner}/${repo}`;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { accept: 'application/json', 'user-agent': 'ZhiYuan-Model-Catalog/1.0' },
      });
      if (response.status === 403 || response.status === 429 || response.status >= 500) {
        if (attempt === 3) return undefined;
        await sleep(Math.max(1000, retryAfter(response) * 1000, 2000 * 2 ** attempt));
        continue;
      }
      if (!response.ok) return undefined;
      const publishedAt = publishedAtFromDetail(await response.json());
      return publishedAt === undefined ? undefined : { repoId, publishedAt };
    } catch {
      if (attempt === 3) return undefined;
      await sleep(1000 * 2 ** attempt);
    }
  }
  return undefined;
}

async function lookup(rows: D1Row[]): Promise<Match[]> {
  const matches = new Array<Match | undefined>(rows.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor++;
      matches[index] = await readPublishedAt(rows[index].repo_id);
    }
  });
  await Promise.all(workers);
  return matches.filter((match): match is Match => Boolean(match));
}

async function writeMatches(matches: Match[]): Promise<void> {
  const updatedAt = new Date().toISOString();
  for (let offset = 0; offset < matches.length; offset += WRITE_BATCH_SIZE) {
    const chunk = matches.slice(offset, offset + WRITE_BATCH_SIZE);
    const batch: Statement[] = chunk.map((match) => ({
      sql: `UPDATE models
        SET published_at = ?,
            model_json = CASE
              WHEN json_valid(model_json) = 1 THEN json_set(model_json, '$.publishedAt', ?)
              ELSE model_json
            END,
            updated_at = ?
        WHERE repo_id = ? AND published_at IS NULL`,
      params: [match.publishedAt, match.publishedAt, updatedAt, match.repoId],
    }));
    await d1<unknown>({ batch });
    console.log(`[published-at] written=${Math.min(offset + chunk.length, matches.length)}/${matches.length}`);
  }
}

async function main(): Promise<void> {
  const rows = await readMissingModels();
  console.log(`[published-at] missing=${rows.length}, concurrency=${CONCURRENCY}, dry_run=${DRY_RUN}`);
  const matches = await lookup(rows);
  console.log(`[published-at] resolved=${matches.length}, unresolved=${rows.length - matches.length}`);
  if (!DRY_RUN && matches.length > 0) await writeMatches(matches);
  console.log(`[published-at] done updated=${DRY_RUN ? 0 : matches.length}`);
}

main().catch((error) => {
  console.error('[published-at] failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
