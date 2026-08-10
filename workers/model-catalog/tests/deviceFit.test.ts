import { describe, expect, it } from 'vitest';

import { computeDeviceFit } from '../src/deviceFit';
import type { CatalogModel } from '../src/types';

function model(sizeBytes: number, parameterCount = 8): CatalogModel {
  return {
    source: 'modelscope-gguf',
    id: 'demo/model',
    repoId: 'demo/model',
    name: 'Demo model',
    description: '',
    tags: ['gguf'],
    sizes: ['desktop'],
    capability: ['chat'],
    parameterCount,
    supportsMultiGpu: true,
    recommendedTag: 'Q4_K_M',
    files: [
      {
        path: 'model-Q4_K_M.gguf',
        sizeBytes,
        isRecommended: true,
        kind: 'model',
      },
    ],
  };
}

const GB = 1_000_000_000;

describe('device fit', () => {
  it('marks a small model recommended on both profiles', () => {
    expect(computeDeviceFit(model(8 * GB))).toEqual({
      base: 'recommended',
      pro: 'recommended',
    });
  });

  it('distinguishes base runnable models from pro recommended models', () => {
    expect(computeDeviceFit(model(10 * GB))).toEqual({
      base: 'runnable',
      pro: 'recommended',
    });
  });

  it('does not classify models above the 64 GiB base runnable budget', () => {
    expect(computeDeviceFit(model(12 * GB))).toMatchObject({
      base: 'unsupported',
    });
  });

  it('uses the worse result when one GPU is overloaded', () => {
    const measured = model(8 * GB);
    measured.measuredPeakVramBytes = 10 * GB;
    measured.measuredPeakVramPerGpuBytes = 6 * GB;
    expect(computeDeviceFit(measured).base).toBe('runnable');
  });

  it('uses single-GPU thresholds when multi-GPU splitting is unavailable', () => {
    const singleGpu = model(6 * GB);
    singleGpu.source = 'curated';
    singleGpu.tags = [];
    singleGpu.supportsMultiGpu = false;
    expect(computeDeviceFit(singleGpu)).toEqual({
      base: 'unsupported',
      pro: 'recommended',
    });
  });

  it('uses the two-GPU thresholds for GGUF without explicit evidence', () => {
    const gguf = model(10 * GB);
    delete gguf.supportsMultiGpu;
    expect(computeDeviceFit(gguf)).toEqual({
      base: 'runnable',
      pro: 'recommended',
    });
  });

  it('downgrades by measured system memory', () => {
    const measured = model(8 * GB);
    measured.measuredPeakSystemMemoryBytes = 50 * GB;
    expect(computeDeviceFit(measured)).toEqual({
      base: 'runnable',
      pro: 'runnable',
    });
  });

  it('includes all shards in the loaded model estimate', () => {
    const split = model(4.5 * GB);
    split.files = [1, 2].map((part) => ({
      path: `model-Q4_K_M-0000${part}-of-00002.gguf`,
      sizeBytes: 4.5 * GB,
      isRecommended: part === 1,
      kind: 'model' as const,
    }));
    expect(computeDeviceFit(split).base).toBe('runnable');
  });

  it('returns unknown when neither files nor parameter count is available', () => {
    const unknown = model(0);
    delete unknown.files;
    delete unknown.parameterCount;
    expect(computeDeviceFit(unknown)).toEqual({ base: 'unknown', pro: 'unknown' });
  });
});
