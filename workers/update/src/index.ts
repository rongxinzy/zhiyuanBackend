const CHANNELS = new Set(['stable', 'beta']);
const PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const ARCHITECTURES = new Set(['x64', 'arm64']);
// Legacy variants (default/deb/appimage/full) stay for releases before the
// lite/cpu/cuda inference editions; newer releases publish the edition names.
const VARIANTS = new Set([
  'lite', 'full', 'default', 'deb', 'appimage',
  'cpu', 'cuda', 'deb-cpu', 'deb-cuda', 'appimage-cpu', 'appimage-cuda',
]);
const DOWNLOADS_ORIGIN = 'https://downloads.rongxzyai.com';
const ARTIFACT_EXTENSIONS = new Set(['appimage', 'blockmap', 'deb', 'dmg', 'exe', 'zip']);
const ELECTRON_TARGETS = new Map<string, ReadonlySet<string>>([
  ['win32:x64:lite', new Set(['latest.yml'])],
  ['win32:x64:cpu', new Set(['latest.yml'])],
  ['win32:x64:cuda', new Set(['latest.yml'])],
  ['darwin:arm64:default', new Set(['latest-mac.yml'])],
  ['darwin:arm64:cpu', new Set(['latest-mac.yml'])],
  ['darwin:x64:cpu', new Set(['latest-mac.yml'])],
  ['linux:x64:appimage', new Set(['latest-linux.yml'])],
  ['linux:x64:deb', new Set(['latest-linux.yml'])],
  ['linux:x64:appimage-cpu', new Set(['latest-linux.yml'])],
  ['linux:x64:deb-cpu', new Set(['latest-linux.yml'])],
  ['linux:x64:appimage-cuda', new Set(['latest-linux.yml'])],
  ['linux:x64:deb-cuda', new Set(['latest-linux.yml'])],
]);

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

/** The single switch CI changes after a release generation has passed validation. */
type StablePointer = {
  schemaVersion: 1;
  generation: string;
};

type ActiveRelease = {
  pointer: StablePointer | null;
  legacyManifestKey: string;
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

function isSafeGeneration(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function isSafeReleaseVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value);
}

function isStablePointer(value: unknown): value is StablePointer {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StablePointer>;
  return candidate.schemaVersion === 1 && isSafeGeneration(candidate.generation);
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

function selectManifest(value: unknown, target: Artifact): SignedManifest | null {
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

function isKnownTarget(target: Artifact): boolean {
  return (
    PLATFORMS.has(target.platform) &&
    ARCHITECTURES.has(target.arch) &&
    VARIANTS.has(target.variant)
  );
}

function isElectronTarget(target: Artifact): boolean {
  return ELECTRON_TARGETS.has(`${target.platform}:${target.arch}:${target.variant}`);
}

function isSafeArtifactFilename(value: string): boolean {
  if (!value || value.length > 240 || value === '.' || value === '..') return false;
  if (/[\\/\u0000-\u001f\u007f]/.test(value)) return false;
  const extension = value.split('.').at(-1)?.toLowerCase();
  return extension !== undefined && ARTIFACT_EXTENSIONS.has(extension);
}

function generationKey(pointer: StablePointer, suffix: string): string {
  return `generations/${pointer.generation}/${suffix}`;
}

function parsePathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes('%') ? null : decoded;
  } catch {
    return null;
  }
}

/** Each channel has its own pointer (channels/<channel>-pointer.json) and legacy manifest. */
async function activeRelease(env: Env, channel: string): Promise<ActiveRelease> {
  const pointerObject = await env.RELEASES.get(`channels/${channel}-pointer.json`);
  if (!pointerObject) return { pointer: null, legacyManifestKey: `channels/${channel}.json` };

  const pointer: unknown = JSON.parse(await pointerObject.text());
  if (!isStablePointer(pointer)) throw new Error('invalid_stable_pointer');
  return {
    pointer,
    legacyManifestKey: generationKey(pointer, `legacy/${channel}.json`),
  };
}

async function responseEtag(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const encoded = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `"${encoded}"`;
}

async function respondWithMetadata(request: Request, object: R2ObjectBody): Promise<Response> {
  const body = await object.text();
  const etag = await responseEtag(body);
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-store' } });
  }
  return new Response(body, {
    headers: {
      'content-type': 'application/yaml; charset=utf-8',
      etag,
      'cache-control': 'no-store',
    },
  });
}

async function handleLegacy(request: Request, env: Env, url: URL): Promise<Response> {
  const target: Artifact = {
    platform: url.searchParams.get('platform') ?? '',
    arch: url.searchParams.get('arch') ?? '',
    variant: url.searchParams.get('variant') ?? '',
  };
  const channel = url.searchParams.get('channel') ?? '';
  if (!CHANNELS.has(channel) || !isKnownTarget(target)) {
    return json({ error: 'invalid_request' }, 400);
  }

  try {
    const release = await activeRelease(env, channel);
    const object = await env.RELEASES.get(release.legacyManifestKey);
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
}

async function handleElectronFeed(request: Request, env: Env, url: URL): Promise<Response> {
  const segments = url.pathname.split('/').filter(Boolean);
  // /v2/electron/<channel>/<platform>/<arch>/<variant>/<metadata>
  if (segments.length !== 7) return json({ error: 'not_found' }, 404);

  const [v2, electron, channel, encodedPlatform, encodedArch, encodedVariant, encodedFilename] = segments;
  const platform = parsePathSegment(encodedPlatform);
  const arch = parsePathSegment(encodedArch);
  const variant = parsePathSegment(encodedVariant);
  const filename = parsePathSegment(encodedFilename);
  if (
    v2 !== 'v2' ||
    electron !== 'electron' ||
    !CHANNELS.has(channel) ||
    !platform ||
    !arch ||
    !variant ||
    !filename ||
    !isElectronTarget({ platform, arch, variant })
  ) {
    return json({ error: 'invalid_request' }, 400);
  }

  try {
    const release = await activeRelease(env, channel);
    if (!release.pointer) return json({ error: 'metadata_unavailable' }, 503);

    const target = `${platform}-${arch}-${variant}`;
    const metadataNames = ELECTRON_TARGETS.get(`${platform}:${arch}:${variant}`)!;
    if (metadataNames.has(filename)) {
      const object = await env.RELEASES.get(generationKey(release.pointer, `electron/${target}/${filename}`));
      if (!object) return json({ error: 'metadata_not_found' }, 404);
      return respondWithMetadata(request, object);
    }

    return json({ error: 'metadata_not_found' }, 404);
  } catch (error) {
    console.error(JSON.stringify({ event: 'update.electron_feed_error', error: error instanceof Error ? error.name : 'unknown' }));
    return json({ error: 'metadata_unavailable' }, 503);
  }
}

function handleElectronArtifact(url: URL): Response {
  const segments = url.pathname.split('/').filter(Boolean);
  // /v2/electron/releases/<version>/<platform>/<arch>/<variant>/<artifact>
  if (segments.length !== 8) return json({ error: 'not_found' }, 404);

  const [v2, electron, releases, encodedVersion, encodedPlatform, encodedArch, encodedVariant, encodedFilename] = segments;
  const version = parsePathSegment(encodedVersion);
  const platform = parsePathSegment(encodedPlatform);
  const arch = parsePathSegment(encodedArch);
  const variant = parsePathSegment(encodedVariant);
  const filename = parsePathSegment(encodedFilename);
  if (
    v2 !== 'v2' ||
    electron !== 'electron' ||
    releases !== 'releases' ||
    !version ||
    !platform ||
    !arch ||
    !variant ||
    !filename ||
    !isSafeReleaseVersion(version) ||
    !isElectronTarget({ platform, arch, variant }) ||
    !isSafeArtifactFilename(filename)
  ) {
    return json({ error: 'invalid_request' }, 400);
  }

  const target = `${platform}-${arch}-${variant}`;
  const location = new URL(
    `/releases/${encodeURIComponent(version)}/${encodeURIComponent(target)}/${encodeURIComponent(filename)}`,
    DOWNLOADS_ORIGIN,
  );
  return new Response(null, {
    status: 307,
    headers: {
      location: location.toString(),
      'cache-control': 'no-store',
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/v2/electron/releases/')) {
      return request.method === 'GET' || request.method === 'HEAD'
        ? handleElectronArtifact(url)
        : json({ error: 'not_found' }, 404);
    }
    if (request.method !== 'GET') return json({ error: 'not_found' }, 404);
    if (url.pathname === '/v1/updates/latest') return handleLegacy(request, env, url);
    if (url.pathname.startsWith('/v2/electron/')) return handleElectronFeed(request, env, url);
    return json({ error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<Env>;
