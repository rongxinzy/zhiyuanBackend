import type {
  CatalogDeviceFit,
  CatalogDeviceProfile,
  CatalogFitStatus,
  CatalogModel,
} from './types';

const GB = 1_000_000_000;
const PEAK_MEMORY_FACTOR = 1.3;

type Level = 'recommended' | 'runnable' | 'unsupported' | 'unknown';

type DeviceThreshold = {
  totalRecommendedBytes: number;
  totalRunnableBytes: number;
  perGpuRecommendedBytes: number;
  perGpuRunnableBytes: number;
  singleGpuRecommendedBytes: number;
  singleGpuRunnableBytes: number;
};

const DEVICE_THRESHOLDS: Record<CatalogDeviceProfile, DeviceThreshold> = {
  base: {
    totalRecommendedBytes: 11.2 * GB,
    totalRunnableBytes: 14.4 * GB,
    perGpuRecommendedBytes: 5.6 * GB,
    perGpuRunnableBytes: 7.2 * GB,
    singleGpuRecommendedBytes: 5.6 * GB,
    singleGpuRunnableBytes: 7.2 * GB,
  },
  pro: {
    totalRecommendedBytes: 22.4 * GB,
    totalRunnableBytes: 28.8 * GB,
    perGpuRecommendedBytes: 11.2 * GB,
    perGpuRunnableBytes: 14.4 * GB,
    singleGpuRecommendedBytes: 11.2 * GB,
    singleGpuRunnableBytes: 14.4 * GB,
  },
};

function levelForRange(value: number, recommended: number, runnable: number): Level {
  if (value <= recommended) return 'recommended';
  if (value <= runnable) return 'runnable';
  return 'unsupported';
}

function worseLevel(left: Level, right: Level): Level {
  const rank: Record<Level, number> = {
    recommended: 0,
    runnable: 1,
    unsupported: 2,
    unknown: 3,
  };
  return rank[left] >= rank[right] ? left : right;
}

function selectedWeightBytes(model: CatalogModel): number | undefined {
  const files = (model.files ?? []).filter((file) => file.kind !== 'mmproj');
  const selected = files.find((file) => file.isRecommended);
  if (!selected?.sizeBytes || selected.sizeBytes <= 0) return undefined;

  // A recommended shard represents the complete shard group, not one file.
  const shardMatch = selected.path.match(/^(.*?)-\d{5}-of-\d{5}\.gguf$/i);
  if (!shardMatch) return selected.sizeBytes;
  const prefix = shardMatch[1];
  const shards = files.filter((file) => {
    const match = file.path.match(/^(.*?)-\d{5}-of-\d{5}\.gguf$/i);
    return match?.[1] === prefix;
  });
  return shards.reduce((total, file) => total + (file.sizeBytes ?? 0), 0);
}

function weightBytes(model: CatalogModel): number | undefined {
  const stored = selectedWeightBytes(model);
  if (stored !== undefined) return stored;
  // The documented fallback requires model weight size. Parameter count alone
  // is insufficient because the rule does not define a precision conversion.
  return undefined;
}

function isGgufModel(model: CatalogModel): boolean {
  return Boolean(
    model.source === 'modelscope-gguf' ||
      model.runtime?.format === 'gguf' ||
      model.tags.some((tag) => tag.toLowerCase() === 'gguf'),
  );
}

function peakVramBytes(model: CatalogModel): number | undefined {
  if (
    typeof model.measuredPeakVramBytes === 'number' &&
    Number.isFinite(model.measuredPeakVramBytes) &&
    model.measuredPeakVramBytes >= 0
  ) {
    return model.measuredPeakVramBytes;
  }
  const weights = weightBytes(model);
  return weights === undefined ? undefined : weights * PEAK_MEMORY_FACTOR;
}

function gpuLevel(model: CatalogModel, profile: CatalogDeviceProfile): Level {
  const peakTotal = peakVramBytes(model);
  if (peakTotal === undefined) return 'unknown';

  const threshold = DEVICE_THRESHOLDS[profile];
  // GGUF models in this catalogue use the product's default two-GPU inference
  // path. Other formats still require explicit dual-GPU evidence.
  if (!isGgufModel(model) && model.supportsMultiGpu !== true) {
    return levelForRange(
      peakTotal,
      threshold.singleGpuRecommendedBytes,
      threshold.singleGpuRunnableBytes,
    );
  }

  const peakPerGpu =
    typeof model.measuredPeakVramPerGpuBytes === 'number' &&
    Number.isFinite(model.measuredPeakVramPerGpuBytes) &&
    model.measuredPeakVramPerGpuBytes >= 0
      ? model.measuredPeakVramPerGpuBytes
      : peakTotal / 2;
  const totalLevel = levelForRange(
    peakTotal,
    threshold.totalRecommendedBytes,
    threshold.totalRunnableBytes,
  );
  const perGpuLevel = levelForRange(
    peakPerGpu,
    threshold.perGpuRecommendedBytes,
    threshold.perGpuRunnableBytes,
  );
  return worseLevel(totalLevel, perGpuLevel);
}

function systemMemoryLevel(model: CatalogModel): Level {
  if (
    typeof model.measuredPeakSystemMemoryBytes !== 'number' ||
    !Number.isFinite(model.measuredPeakSystemMemoryBytes) ||
    model.measuredPeakSystemMemoryBytes < 0
  ) {
    return 'recommended';
  }
  const peakSystemMemoryGb = model.measuredPeakSystemMemoryBytes / GB;
  return levelForRange(peakSystemMemoryGb, 45, 55);
}

function finalLevel(model: CatalogModel, profile: CatalogDeviceProfile): CatalogFitStatus {
  const gpu = gpuLevel(model, profile);
  if (gpu === 'unknown') return 'unknown';
  const memory = systemMemoryLevel(model);
  const result = worseLevel(gpu, memory);
  // CPU Offload can make a model technically startable, but it is never a
  // recommended configuration under the product rule.
  if (model.requiresCpuOffload && result === 'recommended') return 'runnable';
  return result;
}

export function computeDeviceFit(model: CatalogModel): CatalogDeviceFit {
  return {
    base: finalLevel(model, 'base'),
    pro: finalLevel(model, 'pro'),
  };
}
