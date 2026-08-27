import type {
  CatalogFile,
  CatalogModel,
  CatalogSearchResponse,
  CatalogSize,
  CatalogTask,
  ModelScopeFile,
  ModelScopeModel,
  ModelScopePage,
} from './types';

export const MODEL_SCOPE_ENDPOINT = 'https://modelscope.cn';
export const SCORE_VERSION = '2026-08-01-v2';

const MODEL_SCOPE_FILES_ENDPOINT = 'https://www.modelscope.cn';
const GGUF_PATTERN = /\.gguf$/i;
const GGUF_SHARD_PATTERN = /-\d{5}-of-\d{5}\.gguf$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const QUANT_PATTERN =
  /(?:^|[-_.])(q[234568](?:_[0-9]+)?(?:_[kmst](?:_?[sml])?)?|iq[1-4]_[a-z0-9]+|f16|f32)(?:[-_.]|$)/i;
const NON_GENERATIVE_GGUF_PATTERN =
  /(?:^|[/\s._-])(?:embedding|embed|bge|e5|gte|rerank(?:er)?|sentence[-_ ]transformers?|clip|siglip|colbert|vector(?:izer)?|text[-_ ]embedding|flux|comfyui|stable[-_ ]diffusion|sdxl|controlnet|diffusion|vae|image[-_ ]generation|image[-_ ]to[-_ ]image|lora|adapter)(?=$|[/\s._-])/i;
const MODEL_SCOPE_FETCH_CONCURRENCY = 4;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = asNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeTags(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return list(value)
    .map(asString)
    .filter((tag): tag is string => Boolean(tag));
}

function modelSourceText(model: ModelScopeModel): string {
  return [
    ...normalizeTags(model.tasks),
    ...normalizeTags(model.tags),
    model.pipeline_tag,
    model.description,
    model.readme,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function structuredModelSourceText(model: ModelScopeModel): string {
  return [
    ...normalizeTags(model.tasks),
    ...normalizeTags(model.tags),
    model.pipeline_tag,
    model.description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
function hasMmprojFile(model: ModelScopeModel): boolean {
  return list(model.siblings ?? model.files).some((value) => {
    if (!isRecord(value)) return false;
    const path = asString(
      value.path ?? value.Path ?? value.filePath ?? value.FilePath ?? value.name ?? value.Name,
    );
    return Boolean(path && /(?:^|[/_.-])mmproj(?:[/_.-]|$)/i.test(path));
  });
}

/**
 * Capabilities must be backed by ModelScope structured fields, namespaced
 * tags, file evidence, or a strong repository-naming pattern. Bare community
 * tags like "vision"/"code"/"reasoning" are unreliable (plain chat repos such
 * as Qwen1.5 carry them too), and free-text descriptions mention capabilities
 * of unrelated models, so neither is used here.
 */
function inferCapability(model: ModelScopeModel): CatalogTask[] {
  const officialTasks = normalizeTags(model.tasks).map((tag) => tag.toLowerCase());
  const namespacedTags = normalizeTags(model.tags)
    .map((tag) => tag.toLowerCase())
    .filter((tag) => tag.startsWith('task:') || tag.startsWith('custom_tag:'));
  const pipeline = (asString(model.pipeline_tag) ?? '').toLowerCase();
  // Official ModelScope task labels, pipeline tag, and namespaced tags are the
  // only textual signals trusted for capability inference.
  const official = [...officialTasks, pipeline, ...namespacedTags].join(' ');
  const repoName = `${normalizedRepoId(model)} ${asString(model.display_name ?? model.name) ?? ''}`.toLowerCase();
  const capabilities: CatalogTask[] = [];

  if (
    /\b(?:code|coding|code-generation)\b/.test(official) ||
    /\b(?:coder|coding[- ]assistant)\b/.test(repoName)
  ) {
    capabilities.push('code');
  }
  if (/\b(?:reasoning|thinking|math|reasoner)\b/.test(official)) {
    capabilities.push('reasoning');
  }
  if (
    hasMmprojFile(model) ||
    /\b(?:image-text-to-text|multimodal|visual)\b/.test(official) ||
    // VL/VLM suffix in the repo/display name is a strong vision-language
    // signal (Qwen2.5-VL, Qwen2-VL, Qwen3-VL, MiniCPM-V, InternVL...).
    /\b(?:-?vl-?|-?vlm-?|vision-language)\b/.test(repoName)
  ) {
    capabilities.push('vision');
  }
  if (/\b(?:text-generation|chat|conversation|instruct|instruction-following|causal language)\b/.test(official)) {
    capabilities.push('chat');
  }
  const resolved: CatalogTask[] = capabilities.length ? capabilities : ['chat'];
  return [...new Set<CatalogTask>(resolved)];
}

function inferSize(parameterCount?: number, fileSize?: number): CatalogSize[] {
  const gb = fileSize ? fileSize / 1024 ** 3 : undefined;
  const parameters = parameterCount ?? (gb ? gb * 2.2 : undefined);
  if (parameters === undefined) return ['all'];
  if (parameters <= 4) return ['small'];
  if (parameters <= 16) return ['desktop'];
  if (parameters <= 40) return ['workstation'];
  return ['large'];
}

function encodeRepoFilePath(filePath: string): string {
  return filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function fileRecord(file: ModelScopeFile, repoId: string, fallbackRevision = 'master'): CatalogFile | null {
  const filePath = asString(
    file.path ??
      file.Path ??
      file.filePath ??
      file.FilePath ??
      file.name ??
      file.Name ??
      file.rfilename ??
      file.Rfilename,
  );
  if (!filePath || !GGUF_PATTERN.test(filePath)) return null;
  const quantization = filePath.match(QUANT_PATTERN)?.[1]?.toUpperCase();
  const sizeBytes = asNumber(file.size ?? file.Size);
  const sha256 = asString(file.sha256 ?? file.Sha256);
  const revision = asString(file.revision ?? file.Revision) ?? fallbackRevision;
  const kind = /(?:^|[/_.-])mmproj(?:[/_.-]|$)/i.test(filePath) ? 'mmproj' : 'model';
  return {
    path: filePath,
    sizeBytes,
    ...(sha256 && SHA256_PATTERN.test(sha256) ? { sha256: sha256.toLowerCase() } : {}),
    quantization,
    isRecommended: false,
    revision,
    kind,
    downloadUrl: `${MODEL_SCOPE_ENDPOINT}/models/${repoId}/resolve/${encodeURIComponent(revision)}/${encodeRepoFilePath(filePath)}`,
  };
}

export function shardGroupKey(filePath: string): string | null {
  const match = filePath.match(/^(.*?)-?\d{5}-of-\d{5}\.gguf$/i);
  return match ? match[1] : null;
}

export function shardGroups(files: CatalogFile[]): Map<string, CatalogFile[]> {
  const groups = new Map<string, CatalogFile[]>();
  for (const file of files) {
    if (file.kind === 'mmproj') continue;
    if (!GGUF_SHARD_PATTERN.test(file.path)) continue;
    const key = shardGroupKey(file.path);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(file);
    groups.set(key, list);
  }
  return groups;
}

const QUANT_PREFERENCES = ['Q4_K_M', 'Q5_K_M', 'Q5_0', 'Q4_0', 'Q6_K', 'Q8_0'];

export function recommendedFile(files: CatalogFile[]): CatalogFile | undefined {
  const installable = files.filter(
    (file) =>
      file.kind !== 'mmproj' &&
      !GGUF_SHARD_PATTERN.test(file.path) &&
      Boolean(file.sizeBytes && file.sizeBytes > 0 && file.sha256),
  );
  const pickByPreference = (candidates: CatalogFile[]): CatalogFile | undefined => {
    for (const quantization of QUANT_PREFERENCES) {
      const match = candidates.find((file) => file.quantization === quantization);
      if (match) return match;
    }
    return undefined;
  };
  const preferred = pickByPreference(installable);
  if (preferred) return preferred;
  if (installable.length > 0) {
    return installable.sort((left, right) => (left.sizeBytes ?? 0) - (right.sizeBytes ?? 0))[0];
  }
  // Split-only repos (e.g. QwQ-32B: one fp16 quantization sharded into many
  // parts) have no standalone GGUF file. Pick a shard group by quantization
  // preference, then the numerically-first part as the representative file so
  // the repo stays installable — the client downloads every part of the group.
  const groups = [...shardGroups(files).entries()];
  if (groups.length === 0) return undefined;
  // Derive a group's quantization from its stripped base name (the subdirectory
  // for directory-layout shards, the bare base for root-level ones). Reading
  // the raw file path is unreliable: "Q4_K_M/Model-Q4_K_M-00001-of-00004.gguf"
  // would extract "Q4_K" from the directory separator.
  const groupQuantization = (key: string): string | undefined => {
    const base = key.split('/').at(-1) ?? key;
    return base.match(
      /(?:^|[-_.])(q[234568](?:_[0-9]+)?(?:_[kmst](?:_?[sml])?)?|iq[1-4]_[a-z0-9]+|f16|f32)(?:[-_.]|$)/i,
    )?.[1]?.toUpperCase();
  };
  const quantizationRank = (quantization?: string): number => {
    const index = QUANT_PREFERENCES.indexOf((quantization ?? '').toUpperCase());
    return index === -1 ? QUANT_PREFERENCES.length : index;
  };
  groups.sort((left, right) => {
    const rankDelta =
      quantizationRank(groupQuantization(left[0])) -
      quantizationRank(groupQuantization(right[0]));
    if (rankDelta !== 0) return rankDelta;
    const sizeOf = (group: CatalogFile[]) =>
      group.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
    return sizeOf(left[1]) - sizeOf(right[1]);
  });
  const firstPart = groups[0][1].sort((left, right) =>
    left.path.localeCompare(right.path, undefined, { numeric: true }),
  )[0];
  return firstPart;
}

function normalizeFiles(rawFiles: unknown, repoId: string): CatalogFile[] {
  const files = list(rawFiles)
    .map((file) => fileRecord((file ?? {}) as ModelScopeFile, repoId))
    .filter((file): file is CatalogFile => Boolean(file));
  const recommended = recommendedFile(files);
  return files.map((file) => ({ ...file, isRecommended: file.path === recommended?.path }));
}

export function parameterCountFromText(text: string): number | undefined {
  const match = text.match(/(?:^|[-_.])([0-9]+(?:\.[0-9]+)?)b(?:[-_.]|$)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Some imported catalogue records carry a display size such as "7B" instead
 * of parameterCount. Device classes such as "desktop" deliberately do not
 * match this format and retain their existing filtering meaning.
 */
export function parameterCountFromSizes(value: unknown): number | undefined {
  for (const size of list(value)) {
    const match = asString(size)?.match(/^\s*(\d+(?:\.\d+)?)\s*b\s*$/i);
    if (!match) continue;
    const count = Number(match[1]);
    if (Number.isFinite(count) && count > 0) return count;
  }
  return undefined;
}

export function normalizePublishedAt(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function normalizedRepoId(model: ModelScopeModel): string {
  const explicit = asString(model.repo_id ?? model.model_id ?? model.id);
  if (explicit?.includes('/')) return explicit;
  const owner = asString(model.owner);
  return owner && explicit ? `${owner}/${explicit}` : explicit ?? 'unknown/unknown';
}

function architectureFromTags(model: ModelScopeModel): string | undefined {
  const tag = normalizeTags(model.tags).find((value) => value.toLowerCase().startsWith('model_type:'));
  return tag?.slice('model_type:'.length) || undefined;
}

export function normalizeModel(
  model: ModelScopeModel,
  featured = false,
  featuredRank?: number,
  requireVerifiedFiles = true,
): CatalogModel | null {
  const repoId = normalizedRepoId(model);
  if (repoId === 'unknown/unknown') return null;
  const name = asString(model.display_name ?? model.name) ?? repoId.split('/').at(-1) ?? repoId;
  const files = normalizeFiles(model.siblings ?? model.files, repoId);
  const selectedFile = files.find((file) => file.isRecommended);
  const mmprojFile = files.find(
    (file) => file.kind === 'mmproj' && Boolean(file.sizeBytes && file.sha256),
  );
  const searchable = `${repoId} ${name} ${asString(model.description) ?? ''} ${normalizeTags(model.tags).join(' ')}`;
  if (NON_GENERATIVE_GGUF_PATTERN.test(searchable)) return null;
  if (requireVerifiedFiles && !selectedFile) return null;
  if (!requireVerifiedFiles && !/\blibrary:gguf\b/i.test(normalizeTags(model.tags).join(' '))) {
    return null;
  }

  // ModelScope's `params` is not consistently a model parameter total. It can
  // contain repository/file metadata, so only trust an explicit catalog value
  // or a strict B-unit label from supported display fields.
  const explicitParameterCount = positiveNumber(model.parameterCount);
  const sizedParameterCount = parameterCountFromSizes(model.sizes);
  const namedParameterCount = parameterCountFromText(
    `${repoId} ${name} ${selectedFile?.path ?? ''}`,
  );
  const parameterCount = explicitParameterCount ?? sizedParameterCount ?? namedParameterCount;
  const parameterCountSource = explicitParameterCount !== undefined
    ? 'explicit'
    : sizedParameterCount !== undefined
      ? 'sizes'
      : namedParameterCount !== undefined
        ? 'name'
        : undefined;
  const publishedAt = normalizePublishedAt(model.created_at);
  const capability = inferCapability(model);
  const tags = [...new Set([...normalizeTags(model.tags), ...capability, 'gguf'])];
  const downloads = asNumber(model.downloads ?? model.download_count);
  const likes = asNumber(model.likes);
  const qualityScore = Math.min(
    100,
    52 +
      (downloads ? Math.min(22, Math.log10(downloads + 1) * 8) : 0) +
      (selectedFile ? 12 : 0),
  );
  const communityScore = Math.min(
    100,
    42 +
      (downloads ? Math.min(38, Math.log10(downloads + 1) * 10) : 0) +
      (likes ? Math.min(12, Math.log10(likes + 1) * 6) : 0),
  );
  const license = asString(model.license);
  const observedAt = new Date().toISOString();
  const readme = asString(model.readme) ?? '';
  const documentedForRuntime = /llama\.cpp/i.test(readme);
  const sourceText = modelSourceText(model);
  const runtimeStatus = selectedFile ? (documentedForRuntime ? 'documented' : 'candidate') : 'candidate';
  const runtimeCompatibility = selectedFile ? (documentedForRuntime ? 72 : 62) : 35;
  const runtimeReasons = selectedFile
    ? [
        'ModelScope 文件接口已确认单文件 GGUF、大小与 SHA-256。',
        documentedForRuntime
          ? '模型卡明确提供 llama.cpp 使用说明；仍需端侧加载探针最终确认。'
          : '尚无模型卡运行说明，需端侧加载探针确认。',
      ]
    : ['尚未取得可校验的单文件 GGUF 元数据。'];

  return {
    source: 'modelscope-gguf',
    id: repoId,
    repoId,
    name,
    description:
      asString(model.description) ??
      (readme ? readme.replace(/[#*`<>]/g, ' ').replace(/\s+/g, ' ').slice(0, 220) : undefined) ??
      '来自 ModelScope 的 GGUF 大语言模型，可下载到本机进行端侧推理。',
    tags,
    sizes: inferSize(parameterCount, selectedFile?.sizeBytes ?? asNumber(model.file_size)),
    recommendedTag: selectedFile?.quantization,
    capability,
    supportsMultiGpu: true,
    multiGpuEvidence: 'GGUF 默认按双卡推理计算',
    filePath: selectedFile?.path,
    downloads,
    detailUrl: `${MODEL_SCOPE_ENDPOINT}/models/${repoId}`,
    ...(parameterCount === undefined ? {} : { parameterCount }),
    ...(parameterCountSource ? { parameterCountSource } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    isFeatured: featured,
    featuredRank,
    files,
    license,
    licenseStatus: license
      ? /apache|mit|bsd|llama/i.test(license)
        ? 'permissive'
        : 'restricted'
      : 'unknown',
    lastModifiedAt: asString(model.last_modified),
    qualityScore,
    trustScore: license ? 74 : 52,
    communityScore,
    runtimeCompatibility,
    publisherVerified: false,
    mmprojFilePath: mmprojFile?.path,
    metadataStatus: selectedFile ? 'verified' : 'pending',
    runtime: {
      format: 'gguf',
      status: runtimeStatus,
      architecture: architectureFromTags(model),
      ggufFilesVerified: Boolean(selectedFile),
      sha256Verified: Boolean(selectedFile?.sha256),
      chatTemplate: /chat template|chat_template|jinja/i.test(readme) ? 'documented' : 'unknown',
      toolCalling: /tool(?:-| )calling|function(?:-| )calling|agent capabilities/i.test(sourceText)
        ? 'documented'
        : 'unknown',
      mmproj: capability.includes('vision')
        ? mmprojFile
          ? 'available'
          : 'unknown'
        : 'not-required',
      source: 'modelscope-file-api',
      observedAt,
      revision: selectedFile?.revision,
      reasons: runtimeReasons,
    },
    evidence: [
      {
        source: 'ModelScope OpenAPI',
        kind: 'modelscope',
        label: 'GGUF 目录标签与生成任务',
        observedAt,
        confidence: 'B',
      },
      ...(selectedFile
        ? [
            {
              source: 'ModelScope repository files API',
              kind: 'modelscope' as const,
              label: 'GGUF 文件大小与 SHA-256',
              value: selectedFile.path,
              observedAt,
              confidence: 'A' as const,
            },
          ]
        : []),
      ...(documentedForRuntime
        ? [
            {
              source: 'ModelScope model card',
              kind: 'runtime' as const,
              label: '运行框架说明',
              value: 'llama.cpp',
              observedAt,
              confidence: 'B' as const,
            },
          ]
        : []),
      ...(downloads !== undefined
        ? [
            {
              source: 'ModelScope',
              kind: 'community' as const,
              label: '下载量',
              value: downloads,
              observedAt,
              confidence: 'B' as const,
            },
          ]
        : []),
      ...(license
        ? [
            {
              source: 'ModelScope',
              kind: 'license' as const,
              label: '许可证',
              value: license,
              observedAt,
              confidence: 'B' as const,
            },
          ]
        : []),
    ],
  };
}

export function isVerifiedGgufModel(model: CatalogModel): boolean {
  const selectedFile = model.files?.find((file) => file.isRecommended);
  return Boolean(
    model.metadataStatus === 'verified' &&
      selectedFile &&
      selectedFile.kind !== 'mmproj' &&
      selectedFile.path.toLowerCase().endsWith('.gguf') &&
      selectedFile.sizeBytes &&
      selectedFile.sha256 &&
      SHA256_PATTERN.test(selectedFile.sha256),
  );
}

export function extractModels(payload: unknown): { models: ModelScopeModel[]; total?: number } {
  const page = (payload ?? {}) as ModelScopePage;
  const data = isRecord(page.data) ? page.data : undefined;
  const raw = Array.isArray(page)
    ? page
    : data?.models ?? data?.items ?? page.models ?? page.items ?? [];
  const models = list(raw).filter(
    (model): model is ModelScopeModel => Boolean(model && typeof model === 'object'),
  );
  const total = asNumber(
    page.total ??
      page.total_count ??
      page.pagination?.total ??
      (data &&
        asNumber(
          data.total ??
            data.total_count ??
            (isRecord(data.pagination) ? data.pagination.total : undefined),
        )),
  );
  return { models, total };
}

function extractModel(payload: unknown): ModelScopeModel | null {
  if (!isRecord(payload)) return null;
  const data = isRecord(payload.data) ? payload.data : null;
  const candidate = data && asString(data.id ?? data.model_id ?? data.repo_id) ? data : payload;
  return asString(candidate.id ?? candidate.model_id ?? candidate.repo_id)
    ? (candidate as ModelScopeModel)
    : null;
}

function extractFiles(payload: unknown): ModelScopeFile[] {
  if (Array.isArray(payload)) return payload.filter(isRecord) as ModelScopeFile[];
  if (!isRecord(payload)) return [];
  const data = isRecord(payload.Data) ? payload.Data : isRecord(payload.data) ? payload.data : payload;
  const files = data.Files ?? data.files ?? payload.Files ?? payload.files;
  return list(files).filter(isRecord) as ModelScopeFile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3600);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.min(3600, Math.ceil((date - Date.now()) / 1000))) : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new ModelScopeHttpError(response.status, retryAfterSeconds(response));
  }
  const payload = (await response.json()) as unknown;
  if (isRecord(payload)) {
    const success = payload.success ?? payload.Success;
    if (success === false) {
      const code = asNumber(payload.code ?? payload.Code);
      throw new ModelScopeHttpError(code && code >= 400 ? code : 502);
    }
  }
  return payload;
}

function authHeaders(token?: string): Record<string, string> {
  return {
    accept: 'application/json',
    'user-agent': 'ZhiYuan-Model-Catalog/1.0',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export function buildSearchUrl(
  query: string,
  pageNumber: number,
  pageSize: number,
  task: CatalogTask = 'all',
): string {
  const url = new URL(`${MODEL_SCOPE_ENDPOINT}/openapi/v1/models`);
  // snake_case paging params page correctly; camelCase PageNumber is silently
  // ignored (returns the first page repeatedly). filter.library value must be
  // uppercase "GGUF" — lowercase triggered HTTP 403 during probing. ModelScope
  // also rate-limits bursts (403), so callers must keep requests spaced out.
  if (query.trim()) url.searchParams.set('search', query.trim());
  url.searchParams.set('sort', 'downloads');
  url.searchParams.set('filter.library', 'GGUF');
  // Vision-language models use the image-text-to-text pipeline. A hard-coded
  // text-generation filter silently excludes them from upstream results, so
  // the pipeline filter follows the requested task.
  url.searchParams.set(
    'filter.task',
    task === 'vision' ? 'image-text-to-text' : 'text-generation',
  );
  url.searchParams.set('page_number', String(pageNumber));
  url.searchParams.set('page_size', String(pageSize));
  return url.toString();
}

export function buildRepoFilesUrl(owner: string, repo: string, revision = 'master'): string {
  const url = new URL(
    `${MODEL_SCOPE_FILES_ENDPOINT}/api/v1/models/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/repo/files`,
  );
  url.searchParams.set('Revision', revision);
  url.searchParams.set('Recursive', 'true');
  return url.toString();
}

export async function getModelScopeRepoFiles(
  token: string | undefined,
  owner: string,
  repo: string,
  revision = 'master',
  fetcher: typeof fetch = fetch,
): Promise<ModelScopeFile[]> {
  const response = await fetcher(buildRepoFilesUrl(owner, repo, revision), {
    headers: authHeaders(token),
  });
  return extractFiles(await readJson(response));
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function searchModelScope(
  token: string | undefined,
  query: string,
  pageNumber = 1,
  pageSize = 20,
  task: CatalogTask = 'all',
  fetcher: typeof fetch = fetch,
  hydrateDetails = true,
): Promise<{ models: CatalogModel[]; total?: number }> {
  const response = await fetcher(buildSearchUrl(query, pageNumber, pageSize, task), {
    headers: authHeaders(token),
  });
  const extracted = extractModels(await readJson(response));
  const summaries = extracted.models
    .map((model) => ({ raw: model, normalized: normalizeModel(model, false, undefined, false) }))
    .filter(
      (entry): entry is { raw: ModelScopeModel; normalized: CatalogModel } => Boolean(entry.normalized),
    );
  if (!hydrateDetails) {
    // Listing-only sync: return the summary records without per-model detail
    // calls so a full catalogue backfill costs one upstream request per page.
    // Entries stay 'pending' until hydrated on demand (install resolution or
    // the hydrate-model queue).
    return { models: summaries.map((entry) => entry.normalized), total: extracted.total };
  }
  const hydrated = await mapConcurrent(
    summaries,
    MODEL_SCOPE_FETCH_CONCURRENCY,
    async ({ raw, normalized }) => {
      const [owner, repo] = normalized.repoId.split('/');
      if (!owner || !repo) return null;
      try {
        const hydrated = await getModelScopeDetailParts(token, owner, repo, fetcher);
        if (!hydrated) return null;
        return normalizeModel({ ...raw, ...hydrated.model, files: hydrated.files });
      } catch (error) {
        if (error instanceof ModelScopeHttpError && error.status === 404) return null;
        throw error;
      }
    },
  );
  return {
    models: hydrated.filter(
      (model): model is CatalogModel => Boolean(model && isVerifiedGgufModel(model)),
    ),
    total: extracted.total,
  };
}

async function getModelScopeDetailParts(
  token: string | undefined,
  owner: string,
  repo: string,
  fetcher: typeof fetch,
): Promise<{ model: ModelScopeModel; files: ModelScopeFile[] } | null> {
  const [detailPayload, files] = await Promise.all([
    fetcher(
      `${MODEL_SCOPE_ENDPOINT}/openapi/v1/models/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers: authHeaders(token) },
    ).then(readJson),
    getModelScopeRepoFiles(token, owner, repo, 'master', fetcher),
  ]);
  const model = extractModel(detailPayload);
  return model ? { model, files } : null;
}

export async function getModelScopeDetail(
  token: string | undefined,
  owner: string,
  repo: string,
  fetcher: typeof fetch = fetch,
): Promise<CatalogModel | null> {
  const hydrated = await getModelScopeDetailParts(token, owner, repo, fetcher);
  if (!hydrated) return null;
  const normalized = normalizeModel({ ...hydrated.model, files: hydrated.files });
  return normalized && isVerifiedGgufModel(normalized) ? normalized : null;
}

export class ModelScopeHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`ModelScope request failed with status ${status}`);
    this.name = 'ModelScopeHttpError';
  }
}

export function createCatalogResponse(
  models: CatalogModel[],
  totalCount?: number,
  warning?: string,
): CatalogSearchResponse {
  return {
    models,
    ...(totalCount === undefined ? {} : { totalCount }),
    warning,
    source: 'cloud-catalog',
    scoreVersion: SCORE_VERSION,
    catalogUpdatedAt: new Date().toISOString(),
  };
}

export function buildLegacyModelUrl(owner: string, repo: string): string {
  return `${MODEL_SCOPE_ENDPOINT}/api/v1/models/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export function extractLegacyModelFiles(payload: unknown): ModelScopeFile[] {
  if (!isRecord(payload)) return [];
  const data = isRecord(payload.Data) ? payload.Data : isRecord(payload.data) ? payload.data : payload;
  const modelInfos = isRecord(data.ModelInfos) ? data.ModelInfos : isRecord(data.modelInfos) ? data.modelInfos : undefined;
  const gguf = modelInfos && isRecord(modelInfos.gguf) ? modelInfos.gguf : modelInfos && isRecord(modelInfos.GGUF) ? modelInfos.GGUF : undefined;
  const groups = list(gguf?.gguf_file_list ?? gguf?.GgufFileList ?? gguf?.file_list);
  return groups.flatMap((group) => {
    if (!isRecord(group)) return [];
    const files = list(group.file_info ?? group.FileInfo ?? group.files);
    return files
      .filter(isRecord)
      .map((file) => ({
        name: file.name ?? file.Name,
        size: file.size ?? file.Size,
        sha256: file.sha256 ?? file.Sha256,
        revision: data.Revision ?? data.revision,
      }))
      .filter((file) => Boolean(file.name));
  }) as ModelScopeFile[];
}

/**
 * Returns an evidence label only when the model metadata explicitly describes
 * multi-GPU inference. Absence of evidence is intentionally not false: the
 * device-fit rule treats unset support conservatively as single-GPU.
 */
export function extractLegacyMultiGpuEvidence(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const data = isRecord(payload.Data) ? payload.Data : isRecord(payload.data) ? payload.data : payload;
  const readme = asString(data.ReadMeContent ?? data.readme ?? data.Readme ?? data.model_card) ?? '';
  const structured = JSON.stringify({
    backendSupport: data.BackendSupport ?? data.backendSupport,
    modelInfos: data.ModelInfos ?? data.modelInfos,
  });
  const text = `${readme}\n${structured}`;

  const signals: Array<[RegExp, string]> = [
    [/(?:^|[^\w])(?:-sm\s+row|--split-mode(?:[=\s]+)(?:row|layer)|split_mode\s*[:=]\s*(?:row|layer))(?:[^\w]|$)/i, 'llama.cpp split mode'],
    [/(?:tensor[- ]parallel|tensor_parallel|tensor-parallel-size|pipeline[- ]parallel|pipeline_parallel)/i, 'tensor/pipeline parallel inference'],
    [/(?:multi[- ]gpu|multiple GPUs?|multi[- ]device|model parallel)/i, 'explicit multi-GPU inference'],
    [/(?:CUDA_VISIBLE_DEVICES\s*=[^\r\n,]*,[^\r\n]+|device_map\s*[:=]\s*["']?auto)/i, 'multi-device runtime configuration'],
  ];
  for (const [pattern, signal] of signals) {
    if (pattern.test(text)) return signal;
  }
  return undefined;
}

export async function getModelScopeLegacyFiles(
  token: string | undefined,
  owner: string,
  repo: string,
  fetcher: typeof fetch = fetch,
): Promise<ModelScopeFile[]> {
  const response = await fetcher(buildLegacyModelUrl(owner, repo), {
    headers: authHeaders(token),
  });
  return extractLegacyModelFiles(await readJson(response));
}

export function normalizeStoredModelWithFiles(
  stored: CatalogModel,
  rawFiles: ModelScopeFile[],
): CatalogModel | null {
  const { parameterCount, parameterCountSource, ...storedWithoutParameterCount } = stored;
  return normalizeModel(
    {
      ...storedWithoutParameterCount,
      ...(parameterCountSource === 'explicit' && positiveNumber(parameterCount) !== undefined
        ? { parameterCount }
        : {}),
      id: stored.id,
      repo_id: stored.repoId,
      display_name: stored.name,
      created_at: stored.publishedAt,
      files: rawFiles,
    } as ModelScopeModel,
    Boolean(stored.isFeatured),
    stored.featuredRank,
    false,
  );
}
