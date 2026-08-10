import { describe, expect, it, vi } from 'vitest';

import {
  buildRepoFilesUrl,
  buildSearchUrl,
  extractLegacyMultiGpuEvidence,
  getModelScopeDetail,
  isVerifiedGgufModel,
  ModelScopeHttpError,
  recommendedFile,
  searchModelScope,
  shardGroups,
} from '../src/modelScope';
import { parseTokens } from '../src/tokenPool';
import type { CatalogFile } from '../src/types';

const SHA = 'a'.repeat(64);

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

describe('ModelScope GGUF adapter', () => {
  it('recognizes explicit multi-GPU inference evidence from model cards', () => {
    expect(
      extractLegacyMultiGpuEvidence({
        Data: { ReadMeContent: 'Run with llama-cli -sm row across multiple GPUs.' },
      }),
    ).toBe('llama.cpp split mode');
    expect(
      extractLegacyMultiGpuEvidence({
        Data: { ReadMeContent: 'vllm serve model --tensor-parallel-size 2' },
      }),
    ).toBe('tensor/pipeline parallel inference');
  });

  it('does not infer multi-GPU support from ordinary model metadata', () => {
    expect(
      extractLegacyMultiGpuEvidence({
        Data: {
          Frameworks: ['Pytorch'],
          Libraries: ['gguf'],
          ModelInfos: { gguf: { architecture: 'qwen3' } },
        },
      }),
    ).toBeUndefined();
  });

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

describe('split-GGUF recommendation', () => {
  const part = (path: string, sizeBytes: number): CatalogFile => {
    const base = path.split('/').at(-1) ?? path;
    const quantMatch = base.match(
      /(?:^|[-_.])(q[234568](?:_[0-9]+)?(?:_[kmst](?:_?[sml])?)?|iq[1-4]_[a-z0-9]+|f16|f32)(?:[-_.]|$)/i,
    );
    return {
      path,
      sizeBytes,
      sha256: SHA,
      quantization: quantMatch?.[1]?.toUpperCase(),
      isRecommended: false,
      kind: 'model',
      downloadUrl: `https://modelscope.cn/models/x/${path}`,
    };
  };

  it('picks a standalone quantization when one exists', () => {
    const files = [
      part('Model-Q2_K.gguf', 3_000_000_000),
      part('Model-Q4_K_M.gguf', 4_000_000_000),
      part('Model-Q5_K_M.gguf', 5_000_000_000),
    ];
    expect(recommendedFile(files)?.path).toBe('Model-Q4_K_M.gguf');
  });

  it('prefers a standalone file over split parts in the same repo', () => {
    const files = [
      part('Model-UD-TQ1_0.gguf', 55_800_000_000),
      part('BF16/Model-BF16-00001-of-00010.gguf', 47_000_000_000),
      part('BF16/Model-BF16-00002-of-00010.gguf', 48_000_000_000),
    ];
    expect(recommendedFile(files)?.path).toBe('Model-UD-TQ1_0.gguf');
  });

  it('recommends the first part of the preferred shard group when split-only', () => {
    const files = [
      part('BF16/Model-BF16-00001-of-00002.gguf', 47_000_000_000),
      part('BF16/Model-BF16-00002-of-00002.gguf', 48_000_000_000),
      part('Q4_K_M/Model-Q4_K_M-00001-of-00004.gguf', 49_000_000_000),
      part('Q4_K_M/Model-Q4_K_M-00002-of-00004.gguf', 49_000_000_000),
      part('Q4_K_M/Model-Q4_K_M-00003-of-00004.gguf', 49_000_000_000),
      part('Q4_K_M/Model-Q4_K_M-00004-of-00004.gguf', 49_000_000_000),
    ];
    expect(recommendedFile(files)?.path).toBe('Q4_K_M/Model-Q4_K_M-00001-of-00004.gguf');
  });

  it('groups root-level shards by their stripped base name', () => {
    const files = [
      part('qwq-32b-fp16-00001-of-00017.gguf', 3_900_000_000),
      part('qwq-32b-fp16-00002-of-00017.gguf', 3_900_000_000),
    ];
    expect(shardGroups(files).size).toBe(1);
    expect([...shardGroups(files).keys()][0]).toBe('qwq-32b-fp16');
    expect(recommendedFile(files)?.path).toBe('qwq-32b-fp16-00001-of-00017.gguf');
  });

  it('excludes mmproj files from recommendation', () => {
    const files = [
      part('mmproj-model-f16.gguf', 1_400_000_000),
      part('Model-Q4_K_M.gguf', 4_000_000_000),
    ];
    files[0] = { ...files[0], kind: 'mmproj' };
    expect(recommendedFile(files)?.path).toBe('Model-Q4_K_M.gguf');
  });
});
