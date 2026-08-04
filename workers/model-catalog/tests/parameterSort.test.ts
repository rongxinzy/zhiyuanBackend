import { describe, expect, it } from 'vitest';

import { sortModelsByParameterCount } from '../src/sort';
import type { CatalogModel } from '../src/types';

describe('catalog parameter sorting', () => {
  it('sorts models from smallest to largest parameter count', () => {
    const models = [
      { name: 'Qwen 0.5B', repoId: 'demo/qwen-0.5b', parameterCount: 0.5, downloads: 10 },
      { name: 'Qwen 7B', repoId: 'demo/qwen-7b', parameterCount: 7, downloads: 100 },
      { name: 'Qwen 3B', repoId: 'demo/qwen-3b', parameterCount: 3, downloads: 50 },
      { name: 'Unknown', repoId: 'demo/unknown', downloads: 999 },
    ] as CatalogModel[];

    const sorted = sortModelsByParameterCount(models, 'asc');
    const descending = sortModelsByParameterCount(models, 'desc');
    console.table(sorted.map(({ name, parameterCount, repoId }) => ({ name, parameterCount, repoId })));

    expect(sorted.map((model) => model.name)).toEqual([
      'Qwen 0.5B',
      'Qwen 3B',
      'Qwen 7B',
      'Unknown',
    ]);
    expect(sorted.at(-1)?.parameterCount).toBeUndefined();
    expect(descending.map((model) => model.name)).toEqual([
      'Qwen 7B',
      'Qwen 3B',
      'Qwen 0.5B',
      'Unknown',
    ]);
  });
});