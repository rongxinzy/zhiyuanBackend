import type { CatalogDeviceProfile, CatalogFit, CatalogSize, CatalogTask } from './types';
import type { ParameterSortOrder } from './sort';

export type CatalogCursor = {
  version: 2;
  scope: string;
  sortOrder: ParameterSortOrder;
  parameterCountKnown: 0 | 1;
  parameterCount?: number;
  publishedAtKnown: 0 | 1;
  publishedAt?: string;
  repoId: string;
};

const MAX_CURSOR_BYTES = 4096;

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function buildCursorScope(input: {
  query: string;
  task: CatalogTask;
  size: CatalogSize;
  tags: string[];
  sortOrder: ParameterSortOrder;
  device?: CatalogDeviceProfile;
  fit?: CatalogFit;
}): string {
  return [
    input.query.trim().toLowerCase(),
    input.task,
    input.size,
    [...input.tags].sort().join(','),
    input.sortOrder,
    input.device ?? 'all',
    input.fit ?? 'all',
  ].join('|');
}

export function encodeCatalogCursor(cursor: CatalogCursor): string {
  const payload = JSON.stringify(cursor);
  if (new TextEncoder().encode(payload).byteLength > MAX_CURSOR_BYTES) {
    throw new Error('cursor_too_large');
  }
  return base64UrlEncode(payload);
}

export function decodeCatalogCursor(value: string | null): CatalogCursor | null {
  if (!value || value.length > MAX_CURSOR_BYTES) return null;
  const decoded = base64UrlDecode(value);
  if (!decoded || new TextEncoder().encode(decoded).byteLength > MAX_CURSOR_BYTES) return null;
  try {
    const parsed = JSON.parse(decoded) as Partial<CatalogCursor>;
    if (
      parsed.version !== 2 ||
      typeof parsed.scope !== 'string' ||
      (parsed.sortOrder !== 'asc' && parsed.sortOrder !== 'desc') ||
      (parsed.parameterCountKnown !== 0 && parsed.parameterCountKnown !== 1) ||
      (parsed.publishedAtKnown !== 0 && parsed.publishedAtKnown !== 1) ||
      typeof parsed.repoId !== 'string' ||
      parsed.repoId.length === 0 ||
      parsed.repoId.length > 512
    ) {
      return null;
    }
    if (
      parsed.parameterCountKnown === 1 &&
      (typeof parsed.parameterCount !== 'number' || !Number.isFinite(parsed.parameterCount))
    ) {
      return null;
    }
    if (parsed.parameterCountKnown === 0 && parsed.parameterCount !== undefined) return null;
    if (
      parsed.publishedAtKnown === 1 &&
      (typeof parsed.publishedAt !== 'string' ||
        !Number.isFinite(Date.parse(parsed.publishedAt)) ||
        new Date(parsed.publishedAt).toISOString() !== parsed.publishedAt)
    ) {
      return null;
    }
    if (parsed.publishedAtKnown === 0 && parsed.publishedAt !== undefined) return null;
    return parsed as CatalogCursor;
  } catch {
    return null;
  }
}
