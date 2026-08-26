import { describe, expect, it } from 'vitest';

import {
  buildCursorScope,
  decodeCatalogCursor,
  encodeCatalogCursor,
} from '../src/catalogCursor';

describe('catalog cursor', () => {
  it('round-trips the complete stable sort position', () => {
    const cursor = {
      version: 2 as const,
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
      publishedAtKnown: 1 as const,
      publishedAt: '2026-08-01T12:30:00.000Z',
      repoId: '模型方/Qwen-3-GGUF',
    };

    expect(decodeCatalogCursor(encodeCatalogCursor(cursor))).toEqual(cursor);
  });

  it('rejects malformed and incomplete cursors', () => {
    expect(decodeCatalogCursor('not-a-cursor')).toBeNull();
    expect(
      decodeCatalogCursor(
        encodeCatalogCursor({
          version: 2,
          scope: 'scope',
          sortOrder: 'asc',
          parameterCountKnown: 1,
          parameterCount: Number.NaN,
          publishedAtKnown: 0,
          repoId: 'demo/model',
        }),
      ),
    ).toBeNull();
    expect(
      decodeCatalogCursor(
        encodeCatalogCursor({
          version: 2,
          scope: 'scope',
          sortOrder: 'asc',
          parameterCountKnown: 0,
          publishedAtKnown: 1,
          publishedAt: 'not-a-date',
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
    expect(buildCursorScope({ ...base, device: 'base', fit: 'recommended' })).not.toBe(
      buildCursorScope({ ...base, device: 'pro', fit: 'runnable' }),
    );
  });
});
