import type { CatalogModel } from './types';

export type LegacySearchResponse = {
  Success: true;
  Code: 200;
  Data: {
    Models: Array<Record<string, unknown>>;
    Total: number;
    TotalCount: number;
    PageNumber: number;
    PageSize: number;
    HasNextPage: boolean;
  };
};

function legacyFiles(model: CatalogModel): Array<Record<string, unknown>> {
  return (model.files ?? [])
    .filter((file) => file.kind !== 'mmproj' && file.path.toLowerCase().endsWith('.gguf'))
    .map((file) => ({
      name: file.path,
      file_name: file.path,
      path: file.path,
      size: file.sizeBytes ?? 0,
      file_size: file.sizeBytes ?? 0,
      sha256: file.sha256 ?? '',
      download_url: file.downloadUrl,
      quantization: file.quantization,
    }));
}

export function toLegacySearchModel(model: CatalogModel): Record<string, unknown> {
  const parameterCount = model.parameterCount;
  return {
    id: model.id,
    model_id: model.repoId,
    repo_id: model.repoId,
    name: model.name,
    display_name: model.name,
    description: model.description,
    tags: model.tags,
    task: model.capability,
    downloads: model.downloads,
    params: typeof parameterCount === 'number' ? Math.round(parameterCount * 1_000_000_000) : undefined,
    parameter_count: parameterCount,
    ModelInfos: {
      gguf: {
        gguf_file_list: legacyFiles(model),
      },
    },
  };
}

export function createLegacySearchResponse(
  models: CatalogModel[],
  total: number,
  pageNumber: number,
  pageSize: number,
): LegacySearchResponse {
  return {
    Success: true,
    Code: 200,
    Data: {
      Models: models.map(toLegacySearchModel),
      Total: total,
      TotalCount: total,
      PageNumber: pageNumber,
      PageSize: pageSize,
      HasNextPage: pageNumber * pageSize < total,
    },
  };
}