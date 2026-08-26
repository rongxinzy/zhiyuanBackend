import type { CatalogModel } from './types';

export type ParameterSortOrder = 'asc' | 'desc';

function compareParameterCount(
  left: CatalogModel,
  right: CatalogModel,
  order: ParameterSortOrder,
): number {
  const leftCount = left.parameterCount;
  const rightCount = right.parameterCount;
  const leftHasCount = typeof leftCount === 'number' && Number.isFinite(leftCount);
  const rightHasCount = typeof rightCount === 'number' && Number.isFinite(rightCount);
  if (leftHasCount && !rightHasCount) return -1;
  if (!leftHasCount && rightHasCount) return 1;
  if (leftHasCount && rightHasCount && leftCount !== rightCount) {
    return order === 'asc' ? leftCount - rightCount : rightCount - leftCount;
  }

  const leftPublishedAt = left.publishedAt;
  const rightPublishedAt = right.publishedAt;
  const leftHasPublishedAt = typeof leftPublishedAt === 'string' && Number.isFinite(Date.parse(leftPublishedAt));
  const rightHasPublishedAt = typeof rightPublishedAt === 'string' && Number.isFinite(Date.parse(rightPublishedAt));
  if (leftHasPublishedAt && !rightHasPublishedAt) return -1;
  if (!leftHasPublishedAt && rightHasPublishedAt) return 1;
  if (leftHasPublishedAt && rightHasPublishedAt && leftPublishedAt !== rightPublishedAt) {
    return rightPublishedAt.localeCompare(leftPublishedAt);
  }

  return left.repoId.localeCompare(right.repoId);
}

export function sortModelsByParameterCount(
  models: CatalogModel[],
  order: ParameterSortOrder = 'asc',
): CatalogModel[] {
  return [...models].sort((left, right) => compareParameterCount(left, right, order));
}
