const CHANNELS = new Set(['stable']);
const PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const ARCHITECTURES = new Set(['x64', 'arm64']);
const VARIANTS = new Set(['lite', 'full', 'default', 'deb', 'appimage']);
const MANIFEST_KEY = 'channels/stable.json';

type Artifact = {
  platform: string;
  arch: string;
  variant: string;
};

type SignedManifest = {
  schemaVersion: number;
  keyId: string;
  algorithm: string;
  payload: string;
  signature: string;
};

type ManifestCollection = {
  schemaVersion: number;
  manifests: SignedManifest[];
};

const json = (body: Record<string, string>, status: number): Response =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });

function isSignedManifest(value: unknown): value is SignedManifest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SignedManifest>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.keyId === 'string' &&
    typeof candidate.algorithm === 'string' &&
    typeof candidate.payload === 'string' &&
    typeof candidate.signature === 'string'
  );
}

function decodePayload(encoded: string): Artifact | null {
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const value: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), char => char.charCodeAt(0))));
    if (!value || typeof value !== 'object') return null;
    const artifact = (value as { artifact?: unknown }).artifact;
    if (!artifact || typeof artifact !== 'object') return null;
    const candidate = artifact as Partial<Artifact>;
    if (
      typeof candidate.platform !== 'string' ||
      typeof candidate.arch !== 'string' ||
      typeof candidate.variant !== 'string'
    ) {
      return null;
    }
    return candidate as Artifact;
  } catch {
    return null;
  }
}

function selectManifest(
  value: unknown,
  target: Artifact,
): SignedManifest | null {
  const manifests = isSignedManifest(value)
    ? [value]
    : value && typeof value === 'object' && (value as Partial<ManifestCollection>).schemaVersion === 1 && Array.isArray((value as Partial<ManifestCollection>).manifests)
      ? (value as ManifestCollection).manifests
      : [];

  for (const manifest of manifests) {
    if (!isSignedManifest(manifest)) continue;
    const artifact = decodePayload(manifest.payload);
    if (
      artifact?.platform === target.platform &&
      artifact.arch === target.arch &&
      artifact.variant === target.variant
    ) {
      return manifest;
    }
  }
  return null;
}

async function responseEtag(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const encoded = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `"${encoded}"`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/v1/updates/latest') {
      return json({ error: 'not_found' }, 404);
    }

    const target: Artifact = {
      platform: url.searchParams.get('platform') ?? '',
      arch: url.searchParams.get('arch') ?? '',
      variant: url.searchParams.get('variant') ?? '',
    };
    const channel = url.searchParams.get('channel') ?? '';
    if (
      !CHANNELS.has(channel) ||
      !PLATFORMS.has(target.platform) ||
      !ARCHITECTURES.has(target.arch) ||
      !VARIANTS.has(target.variant)
    ) {
      return json({ error: 'invalid_request' }, 400);
    }

    try {
      const object = await env.RELEASES.get(MANIFEST_KEY);
      if (!object) return json({ error: 'manifest_unavailable' }, 503);

      const collection: unknown = JSON.parse(await object.text());
      const manifest = selectManifest(collection, target);
      if (!manifest) return json({ error: 'artifact_not_found' }, 404);

      const body = JSON.stringify(manifest);
      const etag = await responseEtag(body);
      if (request.headers.get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-store' } });
      }
      return new Response(body, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          etag,
          'cache-control': 'no-store',
        },
      });
    } catch (error) {
      console.error(JSON.stringify({ event: 'update.manifest_error', error: error instanceof Error ? error.name : 'unknown' }));
      return json({ error: 'manifest_unavailable' }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
