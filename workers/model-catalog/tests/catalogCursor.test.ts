import { describe, expect, it } from 'vitest';

import {
  buildCursorScope,
  decodeCatalogCursor,
  encodeCatalogCursor,
} from '../src/catalogCursor';

describe('catalog cursor', () => {
  it('round-trips the complete stable sort position', () => {
    const cursor = {
      version: 1 as const,
      scope: buildCursorScope({
        query: 'Qwen 3',
        task: 'chat',
        size: 'desktop',
        tags: ['gguf', 'instruct'],
        sortOrder: 'asc',
      }),
      sortOrder: 'asc' as const,
      parameterCountKnown: 1 as const,
      parameterCount: 7,
      repoId: '模型方/Qwen-3-GGUF',
    };

    expect(decodeCatalogCursor(encodeCatalogCursor(cursor))).toEqual(cursor);
  });

  it('rejects malformed and incomplete cursors', () => {
    expect(decodeCatalogCursor('not-a-cursor')).toBeNull();
    expect(
      decodeCatalogCursor(
        encodeCatalogCursor({
          version: 1,
          scope: 'scope',
          sortOrder: 'asc',
          parameterCountKnown: 1,
          parameterCount: Number.NaN,
          repoId: 'demo/model',
        }),
      ),
    ).toBeNull();
  });

  it('changes the scope when search conditions or sort order change', () => {
    const base = {
      query: 'qwen',
      task: 'all' as const,
      size: 'all' as const,
      tags: [],
      sortOrder: 'asc' as const,
    };
    expect(buildCursorScope(base)).not.toBe(
      buildCursorScope({ ...base, query: 'llama' }),
    );
    expect(buildCursorScope(base)).not.toBe(
      buildCursorScope({ ...base, sortOrder: 'desc' }),
    );
  });
});
