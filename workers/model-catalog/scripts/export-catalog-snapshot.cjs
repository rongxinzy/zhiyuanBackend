const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const output = process.argv[2];
if (!output) throw new Error('Usage: node export-catalog-snapshot.cjs <snapshot.json>');
const config = path.resolve(__dirname, '../wrangler.jsonc');
const query = `
  SELECT model_json, parameter_count, published_at, featured, featured_rank
  FROM models
  WHERE source = 'modelscope-gguf' AND metadata_status = 'verified'
  ORDER BY parameter_count_known DESC, parameter_count ASC, published_at DESC, repo_id ASC
`;
const [result] = JSON.parse(execFileSync('wrangler', [
  'd1', 'execute', 'zhiyuan-model-catalog', '--remote', '--config', config,
  '--command', query, '--json',
], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 }));
if (!result.success) throw new Error('Could not export the verified D1 catalog');

const repoPattern = /^[a-z0-9_-][a-z0-9_.-]*\/[a-z0-9_-][a-z0-9_.-]*$/i;
const supportedCapabilities = new Set(['chat', 'reasoning', 'embedding', 'code', 'vision']);
function exportModel(row) {
  const model = JSON.parse(row.model_json);
  if (!repoPattern.test(model.repoId) || !model.runtime?.ggufFilesVerified) return null;
  const capabilities = (model.capabilities ?? [model.capability].flat())
    .filter(value => supportedCapabilities.has(value));
  const files = (model.files ?? []).filter(file =>
    typeof file.path === 'string' &&
    file.path.toLowerCase().endsWith('.gguf') &&
    file.path.split('/').every(part => part && part !== '.' && part !== '..' && !/[\\:*?"<>|]/.test(part)) &&
    /^[a-f0-9]{40}$/i.test(file.revision ?? '') &&
    /^[a-f0-9]{64}$/i.test(file.sha256 ?? '') &&
    Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0,
  ).map(file => ({
    path: file.path,
    revision: file.revision,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    quantization: file.quantization,
    isRecommended: Boolean(file.isRecommended),
    kind: file.kind === 'mmproj' ? 'mmproj' : 'model',
    downloadUrl: `https://www.modelscope.cn/models/${model.repoId}/resolve/${file.revision}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
  }));
  const recommended = files.find(file => file.isRecommended && file.kind === 'model');
  if (!recommended) return null;
  return {
    id: model.repoId,
    repoId: model.repoId,
    source: 'modelscope-gguf',
    name: model.name || model.repoId,
    description: model.description || '',
    tags: Array.isArray(model.tags) ? model.tags : [],
    sizes: Array.isArray(model.sizes) ? model.sizes : [],
    capability: capabilities[0] ?? 'chat',
    capabilities: capabilities.length ? capabilities : ['chat'],
    recommendedTag: recommended.quantization ?? model.recommendedTag ?? 'GGUF',
    filePath: recommended.path,
    parameterCount: row.parameter_count ?? undefined,
    publishedAt: row.published_at ?? undefined,
    isFeatured: row.featured === 1,
    featuredRank: row.featured_rank ?? undefined,
    downloads: model.downloads,
    license: model.license,
    licenseStatus: model.licenseStatus,
    detailUrl: `https://www.modelscope.cn/models/${model.repoId}`,
    mmprojFilePath: files.find(file => file.path === model.mmprojFilePath)?.path,
    runtime: { ...model.runtime, revision: recommended.revision },
    metadataStatus: 'verified',
    installed: false,
    files,
  };
}

const models = result.results.map(exportModel).filter(Boolean);
if (!models.length) throw new Error('The export did not contain verified, revision-pinned models');
const now = new Date();
fs.writeFileSync(output, JSON.stringify({
  revision: Math.floor(now.getTime() / 1000),
  updatedAt: now.toISOString(),
  models,
}));
console.log(`Exported ${models.length} verified models`);
