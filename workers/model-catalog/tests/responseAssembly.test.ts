import { describe, expect, it } from 'vitest';

import { createCatalogResponse, isVerifiedGgufModel } from '../src/modelScope';
import type { CatalogModel } from '../src/types';

describe('catalog response assembly', () => {
  it('keeps pending catalogue records in the response', () => {
    const pending = {
      source: 'modelscope-gguf',
      id: 'demo/pending-model',
      repoId: 'demo/pending-model',
      name: 'Pending GGUF',
      description: '',
      tags: ['gguf'],
      sizes: ['small'],
      capability: ['chat'],
      metadataStatus: 'pending',
      parameterCount: 1,
    } as CatalogModel;

    expect(isVerifiedGgufModel(pending)).toBe(false);

    const response = createCatalogResponse([pending], 1);
    expect(response.models).toEqual([pending]);
    expect(response.totalCount).toBe(response.models.length);
  });
});