export type CatalogTask = 'all' | 'chat' | 'reasoning' | 'embedding' | 'code' | 'vision';
export type CatalogSize = 'all' | 'small' | 'desktop' | 'workstation' | 'large';
export type CatalogDeviceProfile = 'base' | 'pro';
export type CatalogSearchType = CatalogDeviceProfile | 'other';
export type CatalogFitStatus = 'recommended' | 'runnable' | 'unsupported' | 'unknown';
export type CatalogFit = 'all' | 'recommended' | 'runnable';
export type CatalogDeviceFit = Record<CatalogDeviceProfile, CatalogFitStatus>;

export type CatalogEvidence = {
  source: string;
  kind: 'modelscope' | 'benchmark' | 'runtime' | 'community' | 'license';
  label: string;
  value?: string | number;
  observedAt?: string;
  confidence?: 'A' | 'B' | 'C' | 'D';
};

export type CatalogFile = {
  path: string;
  sizeBytes?: number;
  sha256?: string;
  quantization?: string;
  isRecommended?: boolean;
  downloadUrl?: string;
  revision?: string;
  kind?: 'model' | 'mmproj';
};

export type CatalogRuntimeEvidence = {
  format: 'gguf';
  status: 'documented' | 'candidate' | 'verified' | 'unsupported';
  architecture?: string;
  ggufFilesVerified: boolean;
  sha256Verified: boolean;
  chatTemplate?: 'documented' | 'unknown';
  toolCalling?: 'documented' | 'unknown';
  mmproj?: 'available' | 'not-required' | 'unknown';
  source: 'modelscope-file-api' | 'local-runtime';
  observedAt: string;
  revision?: string;
  reasons: string[];
};

export type CatalogScore = {
  stars: number;
  value: number;
  confidence: 'A' | 'B' | 'C' | 'D';
  taskQuality: number;
  deviceFit: number;
  runtimeCompatibility: number;
  trust: number;
  community: number;
  reasons: string[];
  scoreVersion: string;
};

export type CatalogFitResult = {
  status: 'excellent' | 'good' | 'limited' | 'unsupported' | 'unknown';
  estimatedVramMiB?: number;
  estimatedSystemMemoryMiB?: number;
  recommendedContext?: number;
  reason?: string;
};

export type CatalogModel = {
  source: 'modelscope-gguf' | 'curated';
  id: string;
  repoId: string;
  name: string;
  description: string;
  tags: string[];
  sizes: CatalogSize[];
  recommendedTag?: string;
  capability: CatalogTask[];
  filePath?: string;
  downloads?: number;
  detailUrl?: string;
  parameterCount?: number;
  /** ModelScope's authoritative repository creation time, normalized to ISO 8601 UTC. */
  publishedAt?: string;
  deviceFit?: CatalogDeviceFit;
  supportsMultiGpu?: boolean;
  multiGpuEvidence?: string;
  measuredPeakVramBytes?: number;
  measuredPeakVramPerGpuBytes?: number;
  measuredPeakSystemMemoryBytes?: number;
  requiresCpuOffload?: boolean;
  installed?: boolean;
  installedPath?: string;
  isFeatured?: boolean;
  featuredRank?: number;
  score?: CatalogScore;
  fit?: CatalogFitResult;
  files?: CatalogFile[];
  license?: string;
  licenseStatus?: 'permissive' | 'restricted' | 'unknown';
  lastModifiedAt?: string;
  qualityScore?: number;
  trustScore?: number;
  communityScore?: number;
  runtimeCompatibility?: number;
  evidence?: CatalogEvidence[];
  publisherVerified?: boolean;
  mmprojFilePath?: string;
  runtime?: CatalogRuntimeEvidence;
  metadataStatus?: 'verified' | 'pending' | 'unavailable';
};

export type CatalogSearchResponse = {
  models: CatalogModel[];
  totalCount?: number;
  hasMore?: boolean;
  nextCursor?: string;
  nextPageNumber?: number;
  warning?: string;
  source: 'cloud-catalog' | 'd1' | 'modelscope' | 'curated';
  catalogUpdatedAt?: string;
  scoreVersion: string;
};

export type ModelScopeFile = {
  Name?: string;
  name?: string;
  Path?: string;
  path?: string;
  Size?: number;
  size?: number;
  Sha256?: string;
  sha256?: string;
  Revision?: string;
  revision?: string;
  rfilename?: string;
  Rfilename?: string;
  FilePath?: string;
  filePath?: string;
};

export type ModelScopeModel = Record<string, unknown> & {
  name?: string;
  id?: string;
  model_id?: string;
  owner?: string;
  repo_id?: string;
  description?: string;
  display_name?: string;
  readme?: string;
  tags?: unknown;
  task?: unknown;
  pipeline_tag?: string;
  tasks?: unknown;
  downloads?: number;
  download_count?: number;
  likes?: number;
  params?: number;
  file_size?: number;
  siblings?: ModelScopeFile[];
  files?: ModelScopeFile[];
  license?: string;
  last_modified?: string;
  created_at?: string;
};

export type ModelScopePage = {
  data?: unknown;
  models?: unknown;
  items?: unknown;
  total?: number;
  total_count?: number;
  pagination?: { total?: number };
};
