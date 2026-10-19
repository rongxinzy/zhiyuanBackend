import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import worker from '../src/index.ts';

type Target = { platform: string; arch: string; variant: string };

class FakeReleases {
  readonly reads: string[] = [];
  private readonly objects: Record<string, string>;

  constructor(objects: Record<string, string>) {
    this.objects = objects;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    this.reads.push(key);
    const value = this.objects[key];
    return value === undefined ? null : ({ text: async () => value } as unknown as R2ObjectBody);
  }
}

function environment(objects: Record<string, string>): { env: Env; releases: FakeReleases } {
  const releases = new FakeReleases(objects);
  return { env: { RELEASES: releases } as unknown as Env, releases };
}

function signedManifest(target: Target): Record<string, unknown> {
  return {
    schemaVersion: 1,
    keyId: 'production-2026',
    algorithm: 'ed25519',
    payload: Buffer.from(JSON.stringify({ artifact: target })).toString('base64url'),
    signature: 'signature',
  };
}

async function fetchUpdate(url: string, env: Env, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(url, init), env, {} as ExecutionContext);
}

describe('update Worker dual protocol', () => {
  const target: Target = { platform: 'win32', arch: 'x64', variant: 'lite' };

  it('keeps the legacy endpoint on channels/stable.json until a stable pointer exists', async () => {
    const manifest = signedManifest(target);
    const { env, releases } = environment({
      'channels/stable.json': JSON.stringify({ schemaVersion: 1, manifests: [manifest] }),
    });

    const response = await fetchUpdate('https://updates.example/v1/updates/latest?channel=stable&platform=win32&arch=x64&variant=lite', env);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), manifest);
    assert.deepEqual(releases.reads, ['channels/stable-pointer.json', 'channels/stable.json']);
  });

  it('switches legacy responses and generic metadata together through the pointer generation', async () => {
    const manifest = signedManifest(target);
    const { env, releases } = environment({
      'channels/stable-pointer.json': JSON.stringify({ schemaVersion: 1, generation: '2026.8.6-build.1' }),
      'generations/2026.8.6-build.1/legacy/stable.json': JSON.stringify({ schemaVersion: 1, manifests: [manifest] }),
      'generations/2026.8.6-build.1/electron/win32-x64-lite/latest.yml': 'version: 2026.8.6\npath: setup.exe\n',
    });

    const legacy = await fetchUpdate('https://updates.example/v1/updates/latest?channel=stable&platform=win32&arch=x64&variant=lite', env);
    const metadata = await fetchUpdate('https://updates.example/v2/electron/stable/win32/x64/lite/latest.yml', env);

    assert.equal(legacy.status, 200);
    assert.deepEqual(await legacy.json(), manifest);
    assert.equal(metadata.status, 200);
    assert.equal(await metadata.text(), 'version: 2026.8.6\npath: setup.exe\n');
    assert.match(metadata.headers.get('content-type') ?? '', /^application\/yaml/);
    assert.deepEqual(releases.reads, [
      'channels/stable-pointer.json',
      'generations/2026.8.6-build.1/legacy/stable.json',
      'channels/stable-pointer.json',
      'generations/2026.8.6-build.1/electron/win32-x64-lite/latest.yml',
    ]);
  });

  it('redirects explicit versioned artifacts so old blockmaps stay on their old release', async () => {
    const { env } = environment({});
    const response = await fetchUpdate(
      'https://updates.example/v2/electron/releases/2026.8.5-build.4/win32/x64/lite/%E7%9F%A5%E8%BF%9C%20Setup.exe.blockmap',
      env,
    );

    assert.equal(response.status, 307);
    assert.equal(
      response.headers.get('location'),
      'https://downloads.rongxzyai.com/releases/2026.8.5-build.4/win32-x64-lite/%E7%9F%A5%E8%BF%9C%20Setup.exe.blockmap',
    );
  });

  it('rejects unsafe generation, traversal, and double-encoded artifact paths', async () => {
    const unsafePointer = environment({
      'channels/stable-pointer.json': JSON.stringify({ schemaVersion: 1, generation: '../previous' }),
      'channels/stable.json': JSON.stringify({ schemaVersion: 1, manifests: [signedManifest(target)] }),
    });
    const originalConsoleError = console.error;
    let legacy: Response;
    try {
      console.error = () => undefined;
      legacy = await fetchUpdate('https://updates.example/v1/updates/latest?channel=stable&platform=win32&arch=x64&variant=lite', unsafePointer.env);
    } finally {
      console.error = originalConsoleError;
    }
    const traversal = await fetchUpdate('https://updates.example/v2/electron/releases/2026.8.6/win32/x64/lite/%2E%2E%2Fsecret.exe', unsafePointer.env);
    const doubleEncoded = await fetchUpdate('https://updates.example/v2/electron/releases/2026.8.6/win32/x64/lite/%252e%252e.exe', unsafePointer.env);

    assert.equal(legacy.status, 503);
    assert.equal(traversal.status, 400);
    assert.equal(doubleEncoded.status, 400);
    assert.deepEqual(unsafePointer.releases.reads, ['channels/stable-pointer.json']);
  });

  it('serves the DebUpdater feed and permits a HEAD redirect for its package', async () => {
    const { env } = environment({
      'channels/stable-pointer.json': JSON.stringify({ schemaVersion: 1, generation: '2026.8.6-build.1' }),
      'generations/2026.8.6-build.1/electron/linux-x64-deb/latest-linux.yml': 'version: 2026.8.6\npath: zhiyuan.deb\n',
    });
    const metadata = await fetchUpdate('https://updates.example/v2/electron/stable/linux/x64/deb/latest-linux.yml', env);
    const artifact = await fetchUpdate(
      'https://updates.example/v2/electron/releases/2026.8.6/linux/x64/deb/zhiyuan.deb',
      env,
      { method: 'HEAD' },
    );

    assert.equal(metadata.status, 200);
    assert.equal(await metadata.text(), 'version: 2026.8.6\npath: zhiyuan.deb\n');
    assert.equal(artifact.status, 307);
    assert.equal(
      artifact.headers.get('location'),
      'https://downloads.rongxzyai.com/releases/2026.8.6/linux-x64-deb/zhiyuan.deb',
    );
  });

  it('does not expose v2 metadata before a stable pointer and accepts GET only', async () => {
    const { env } = environment({
      'channels/stable.json': JSON.stringify({ schemaVersion: 1, manifests: [signedManifest(target)] }),
    });

    const metadata = await fetchUpdate('https://updates.example/v2/electron/stable/win32/x64/lite/latest.yml', env);
    const head = await fetchUpdate('https://updates.example/v1/updates/latest?channel=stable&platform=win32&arch=x64&variant=lite', env, { method: 'HEAD' });

    assert.equal(metadata.status, 503);
    assert.deepEqual(await metadata.json(), { error: 'metadata_unavailable' });
    assert.equal(head.status, 404);
  });

  it('serves each Windows inference edition from the beta pointer independently of stable', async () => {
    const editions = ['lite', 'cpu', 'cuda'].map(variant => signedManifest({ platform: 'win32', arch: 'x64', variant }));
    const { env, releases } = environment({
      'channels/stable-pointer.json': JSON.stringify({ schemaVersion: 1, generation: '2026.10.15-build.1' }),
      'channels/beta-pointer.json': JSON.stringify({ schemaVersion: 1, generation: '2026.10.19-build.1' }),
      'generations/2026.10.19-build.1/legacy/beta.json': JSON.stringify({ schemaVersion: 1, manifests: editions }),
      'generations/2026.10.19-build.1/electron/win32-x64-cuda/latest.yml': 'version: 2026.10.19-build.1\n',
    });

    for (const [index, variant] of ['lite', 'cpu', 'cuda'].entries()) {
      const response = await fetchUpdate(`https://updates.example/v1/updates/latest?channel=beta&platform=win32&arch=x64&variant=${variant}`, env);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), editions[index]);
    }
    const metadata = await fetchUpdate('https://updates.example/v2/electron/beta/win32/x64/cuda/latest.yml', env);
    assert.equal(metadata.status, 200);
    assert.equal(await metadata.text(), 'version: 2026.10.19-build.1\n');
    assert.ok(!releases.reads.includes('channels/stable-pointer.json'));
  });

  it('accepts Linux and macOS edition variants and still rejects unknown channels', async () => {
    const { env } = environment({
      'channels/stable-pointer.json': JSON.stringify({ schemaVersion: 1, generation: '2026.10.19-build.1' }),
      'generations/2026.10.19-build.1/legacy/stable.json': JSON.stringify({
        schemaVersion: 1,
        manifests: [signedManifest({ platform: 'linux', arch: 'x64', variant: 'appimage-cuda' })],
      }),
      'generations/2026.10.19-build.1/electron/darwin-x64-cpu/latest-mac.yml': 'version: 2026.10.19-build.1\n',
    });

    const linux = await fetchUpdate('https://updates.example/v1/updates/latest?channel=stable&platform=linux&arch=x64&variant=appimage-cuda', env);
    const mac = await fetchUpdate('https://updates.example/v2/electron/stable/darwin/x64/cpu/latest-mac.yml', env);
    const redirect = await fetchUpdate('https://updates.example/v2/electron/releases/2026.10.19-build.1/linux/x64/deb-cuda/zhiyuan.deb', env);
    const unknown = await fetchUpdate('https://updates.example/v1/updates/latest?channel=nightly&platform=win32&arch=x64&variant=cpu', env);

    assert.equal(linux.status, 200);
    assert.equal(mac.status, 200);
    assert.equal(redirect.status, 307);
    assert.equal(
      redirect.headers.get('location'),
      'https://downloads.rongxzyai.com/releases/2026.10.19-build.1/linux-x64-deb-cuda/zhiyuan.deb',
    );
    assert.equal(unknown.status, 400);
  });
});
