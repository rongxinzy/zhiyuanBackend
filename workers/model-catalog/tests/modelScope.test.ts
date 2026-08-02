import { describe, expect, it, vi } from 'vitest';

import {
  buildRepoFilesUrl,
  buildSearchUrl,
  getModelScopeDetail,
  isVerifiedGgufModel,
  ModelScopeHttpError,
  searchModelScope,
} from '../src/modelScope';
import { parseTokens } from '../src/tokenPool';

const SHA = 'a'.repeat(64);

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

describe('ModelScope GGUF adapter', () => {
  it('parses a named Worker-side token bundle without accepting malformed entries', () => {
    expect(
      parseTokens(
        JSON.stringify({
          tokens: [
            { id: 'pool-primary', token: 'secret-a' },
            { id: 'pool-primary', token: 'ignored-duplicate-id' },
            { id: 'empty', token: '' },
            'secret-b',
          ],
        }),
      ),
    ).toEqual([
      { id: 'pool-primary', token: 'secret-a' },
      { id: 'token-4', token: 'secret-b' },
    ]);
  });

  it('builds the official filtered search and recursive file-list URLs', () => {
    expect(buildSearchUrl('Qwen3', 2, 12)).toContain('filter.library=gguf');
    expect(buildSearchUrl('Qwen3', 2, 12)).toContain('filter.task=text-generation');
    expect(buildRepoFilesUrl('Qwen', 'Qwen3-8B-GGUF')).toContain(
      '/api/v1/models/Qwen/Qwen3-8B-GGUF/repo/files',
    );
    expect(buildRepoFilesUrl('Qwen', 'Qwen3-8B-GGUF')).toContain('Recursive=true');
  });

  it('admits only generative repositories with a verifiable single-file GGUF', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/openapi/v1/models?')) {
        return jsonResponse({
          success: true,
          data: {
            models: [
              {
                id: 'Qwen/Qwen3-8B-GGUF',
                display_name: 'Qwen3 8B',
                downloads: 20,
                params: 8_000_000_000,
                tasks: ['text-generation'],
                tags: ['library:gguf', 'task:text-generation', 'model_type:qwen3'],
              },
              {
                id: 'BAAI/bge-large-zh-v1.5-GGUF',
                tasks: ['sentence-embedding'],
                tags: ['library:gguf', 'task:feature-extraction'],
              },
            ],
            total_count: 593,
          },
        });
      }
      if (url.includes('/openapi/v1/models/Qwen/Qwen3-8B-GGUF')) {
        return jsonResponse({
          success: true,
          data: {
            id: 'Qwen/Qwen3-8B-GGUF',
            display_name: 'Qwen3 8B',
            downloads: 20,
            params: 8_000_000_000,
            tasks: ['text-generation'],
            tags: ['library:gguf', 'task:text-generation', 'model_type:qwen3'],
            readme: 'Use llama.cpp as an AI coding assistant for code generation. Vision models are listed elsewhere.',
          },
        });
      }
      return jsonResponse({
        Success: true,
        Data: {
          Files: [
            {
              Path: 'Qwen3-8B-Q4_K_M.gguf',
              Size: 5_027_783_488,
              Sha256: SHA,
              Revision: 'c38f9307f3d23c914614557de83d66c0104f942c',
            },
          ],
        },
      });
    });

    const result = await searchModelScope('pool-token', 'Qwen3', 1, 20, fetcher);

    expect(result.total).toBe(593);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      repoId: 'Qwen/Qwen3-8B-GGUF',
      metadataStatus: 'verified',
      filePath: 'Qwen3-8B-Q4_K_M.gguf',
      parameterCount: 8,
      publisherVerified: false,
    });
    expect(isVerifiedGgufModel(result.models[0])).toBe(true);
    expect(result.models[0].files?.[0]).toMatchObject({
      sha256: SHA,
      isRecommended: true,
      kind: 'model',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.models[0].runtime?.status).toBe('documented');
    expect(result.models[0].capability).toContain('code');
    expect(result.models[0].capability).not.toContain('vision');
  });

  it('hydrates detail data, README runtime evidence, and immutable file metadata', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/openapi/v1/models/')) {
        return jsonResponse({
          success: true,
          data: {
            id: 'Qwen/Qwen3-8B-GGUF',
            display_name: 'Qwen3 8B',
            tasks: ['text-generation'],
            tags: ['library:gguf', 'task:text-generation', 'model_type:qwen3'],
            readme: 'Run with llama.cpp using --jinja. Agent capabilities include tool calling.',
          },
        });
      }
      return jsonResponse({
        Success: true,
        Data: {
          Files: [
            {
              Path: 'Qwen3-8B-Q4_K_M.gguf',
              Size: 5_027_783_488,
              Sha256: SHA,
              Revision: 'commit-sha',
            },
          ],
        },
      });
    });

    const model = await getModelScopeDetail('pool-token', 'Qwen', 'Qwen3-8B-GGUF', fetcher);

    expect(model?.runtime).toMatchObject({
      status: 'documented',
      architecture: 'qwen3',
      ggufFilesVerified: true,
      sha256Verified: true,
      chatTemplate: 'documented',
      toolCalling: 'documented',
      revision: 'commit-sha',
    });
    expect(model?.runtime?.reasons.join(' ')).toContain('端侧加载探针');
    expect(model?.runtimeCompatibility).toBeLessThan(80);
  });

  it('drops repositories whose file listing has no checksum-backed GGUF', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes('/openapi/v1/models?')) {
        return jsonResponse({
          success: true,
          data: {
            models: [
              {
                id: 'owner/name-GGUF',
                tasks: ['text-generation'],
                tags: ['library:gguf', 'task:text-generation'],
              },
            ],
            total_count: 1,
          },
        });
      }
      return jsonResponse({
        Success: true,
        Data: { Files: [{ Path: 'model-Q4_K_M.gguf', Size: 1234 }] },
      });
    });

    await expect(searchModelScope(undefined, '', 1, 20, fetcher)).resolves.toMatchObject({
      models: [],
      total: 1,
    });
  });

  it('preserves Retry-After for token-pool cooldown decisions', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({}, { status: 429, headers: { 'retry-after': '37' } }),
    );

    await expect(searchModelScope('pool-token', '', 1, 20, fetcher)).rejects.toMatchObject({
      name: ModelScopeHttpError.name,
      status: 429,
      retryAfterSeconds: 37,
    });
  });
});
