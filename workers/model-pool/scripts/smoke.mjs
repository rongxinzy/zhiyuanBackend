import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LogicalModel = {
  Free: 'zhiyuan-free',
};

const ApiPath = {
  ChatCompletions: '/v1/chat/completions',
  Health: '/health',
  Models: '/v1/models',
};

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function errorMessage(error) {
  if (!(error instanceof Error)) return String(error);
  const code = typeof error.code === 'string' ? ` (${error.code})` : '';
  if (!(error.cause instanceof Error)) return `${error.name}${code}: ${error.message}`;
  const causeCode = typeof error.cause.code === 'string' ? ` (${error.cause.code})` : '';
  return `${error.name}${code}: ${error.message}; ${error.cause.name}${causeCode}: ${error.cause.message}`;
}

async function request(baseUrl, path, init = {}) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'zhiyuan-model-pool-smoke-'));
  const headerFile = join(temporaryDirectory, 'headers');
  const headers = Object.entries(init.headers ?? {}).map(([name, value]) => `${name}: ${value}`);
  await writeFile(headerFile, `${headers.join('\n')}\n`, { mode: 0o600 });

  try {
    const output = await new Promise((resolveRequest, rejectRequest) => {
      const curl = spawn(
        'curl',
        [
          '--silent',
          '--show-error',
          '--max-time',
          '60',
          '--request',
          init.method ?? 'GET',
          '--header',
          `@${headerFile}`,
          ...(init.body ? ['--data-binary', '@-'] : []),
          '--write-out',
          '\n%{http_code}',
          new URL(path, baseUrl).href,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const stdout = [];
      const stderr = [];
      curl.stdout.on('data', chunk => stdout.push(chunk));
      curl.stderr.on('data', chunk => stderr.push(chunk));
      curl.on('error', rejectRequest);
      curl.on('close', code => {
        if (code === 0) {
          resolveRequest(Buffer.concat(stdout).toString('utf8'));
          return;
        }
        rejectRequest(new Error(Buffer.concat(stderr).toString('utf8').trim() || `curl exited ${code}`));
      });
      curl.stdin.end(init.body);
    });
    const separator = output.lastIndexOf('\n');
    assert(separator !== -1, 'curl response did not include an HTTP status');
    const body = output.slice(0, separator);
    const status = Number.parseInt(output.slice(separator + 1), 10);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function readJson(response, label) {
  const body = await response.text();
  assert(response.ok, `${label} returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function authHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

async function verifyHealth(baseUrl) {
  const response = await request(baseUrl, ApiPath.Health);
  const body = await readJson(response, 'health check');
  assert(body.status === 'ok', 'health check did not report ok');
  console.log(`PASS health (${body.environment})`);
}

async function verifyAnonymousRejection(baseUrl) {
  const response = await request(baseUrl, ApiPath.Models);
  assert(response.status === 401, `anonymous model list returned HTTP ${response.status}, expected 401`);
  console.log('PASS anonymous authentication rejection');
}

async function verifyModels(baseUrl, token) {
  const response = await request(baseUrl, ApiPath.Models, {
    headers: authHeaders(token),
  });
  const body = await readJson(response, 'model list');
  const ids = Array.isArray(body.data) ? body.data.map(model => model?.id) : [];
  assert(ids.includes(LogicalModel.Free), `${LogicalModel.Free} is missing from the model list`);
  console.log(`PASS authenticated model list (${LogicalModel.Free})`);
}

async function verifyChat(baseUrl, token) {
  const response = await request(baseUrl, ApiPath.ChatCompletions, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      model: LogicalModel.Free,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
    }),
  });
  const body = await readJson(response, 'chat completion');
  assert(body.model === LogicalModel.Free, 'chat completion exposed a physical model name');
  assert(Array.isArray(body.choices) && body.choices.length > 0, 'chat completion has no choices');
  assert(Number.isFinite(body.usage?.prompt_tokens), 'chat completion has no prompt token usage');
  assert(Number.isFinite(body.usage?.completion_tokens), 'chat completion has no completion token usage');
  console.log('PASS non-streaming chat and usage');
}

async function verifyToolCalling(baseUrl, token) {
  const response = await request(baseUrl, ApiPath.ChatCompletions, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      model: LogicalModel.Free,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Call the provided tool once with timezone UTC.' }],
      tool_choice: 'required',
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_current_time',
            description: 'Get the current time for a timezone.',
            parameters: {
              type: 'object',
              properties: { timezone: { type: 'string' } },
              required: ['timezone'],
              additionalProperties: false,
            },
          },
        },
      ],
    }),
  });
  const body = await readJson(response, 'tool-call completion');
  const toolCalls = body.choices?.[0]?.message?.tool_calls;
  assert(Array.isArray(toolCalls) && toolCalls.length > 0, 'model did not return a tool call');
  assert(toolCalls[0]?.function?.name === 'get_current_time', 'model called an unexpected tool');
  console.log('PASS required tool calling');
}

async function verifyStreaming(baseUrl, token) {
  const response = await request(baseUrl, ApiPath.ChatCompletions, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      model: LogicalModel.Free,
      max_tokens: 32,
      stream: true,
      messages: [{ role: 'user', content: 'Reply in one short sentence.' }],
    }),
  });
  assert(response.ok, `streaming chat returned HTTP ${response.status}`);
  const body = await response.text();
  const dataLines = body
    .split(/\r?\n/)
    .filter(line => line.startsWith('data: '))
    .map(line => line.slice('data: '.length));
  assert(dataLines.at(-1) === '[DONE]', 'streaming chat did not terminate with [DONE]');
  const events = dataLines.slice(0, -1).map(line => JSON.parse(line));
  assert(events.length > 0, 'streaming chat returned no events');
  assert(events.every(event => event.model === LogicalModel.Free), 'stream exposed a physical model name');
  const usage = events.find(event => event.usage)?.usage;
  assert(Number.isFinite(usage?.prompt_tokens), 'stream has no prompt token usage');
  assert(Number.isFinite(usage?.completion_tokens), 'stream has no completion token usage');
  console.log('PASS streaming chat, logical model rewrite, and usage');
}

async function main() {
  const baseUrl = argumentValue(
    '--base-url',
    'https://zhiyuan-model-pool-staging.windflyme5.workers.dev',
  );
  const tokenFile = resolve(argumentValue('--token-file', 'workers/model-pool/.test-token'));
  const token = (await readFile(tokenFile, 'utf8')).trim();
  assert(token, `token file is empty: ${tokenFile}`);

  await verifyHealth(baseUrl);
  await verifyAnonymousRejection(baseUrl);
  await verifyModels(baseUrl, token);
  await verifyChat(baseUrl, token);
  await verifyToolCalling(baseUrl, token);
  await verifyStreaming(baseUrl, token);
  console.log(`Model Pool smoke passed: ${new URL(baseUrl).origin}`);
}

main().catch(error => {
  console.error(`Model Pool smoke failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
