import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import anyTest from 'ava';
import type { TestFn } from 'ava';
import {
  DetectingFetcher,
  ENV_LAMBDA_EXTENSION_PORT,
  LambdaExtensionFetcher,
  newDefaultFetcher,
  probe,
  SDKFetcher,
} from '../fetch';
import { classifyFailure, FetchTimeoutError, InvalidResponseError, LambdaExtensionStatusError } from '../telemetry';

interface Request {
  path: string;
  token: string | undefined;
}

/** A fake Lambda extension that responds with `respond`'s status and body, recording requests. */
class FakeExtension {
  readonly requests: Request[] = [];
  respond: (secretId: string) => [number, string] = () => [404, 'not found'];
  private readonly server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    this.requests.push({ path: req.url!, token: req.headers['x-aws-parameters-secrets-token'] as string | undefined });
    const [status, body] = this.respond(url.searchParams.get('secretId') ?? '');
    res.writeHead(status).end(body);
  });

  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, 'localhost', resolve));
    return (this.server.address() as AddressInfo).port;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

interface Context {
  extension: FakeExtension;
  port: number;
}

const test = anyTest as TestFn<Context>;

test.beforeEach(async (t) => {
  const extension = new FakeExtension();
  t.context = { extension, port: await extension.start() };
});

test.afterEach.always(async (t) => {
  await t.context.extension.close();
});

/**
 * A port with nothing listening on it. Tests using it are serial, so that other tests' fake
 * extensions can't start listening on it.
 */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test.serial('Lambda extension fetcher', async (t) => {
  const { extension, port } = t.context;
  extension.respond = (id) =>
    id === 'binary/secret'
      ? [200, JSON.stringify({ SecretBinary: Buffer.from([1, 2, 3]).toString('base64'), VersionId: 'v2' })]
      : [200, JSON.stringify({ SecretString: 'value', VersionId: 'v1' })];
  const prevToken = process.env['AWS_SESSION_TOKEN'];
  process.env['AWS_SESSION_TOKEN'] = 'token';
  try {
    const fetcher = new LambdaExtensionFetcher(port);
    t.is(fetcher.path, 'extension');
    t.deepEqual(await fetcher.fetch('string'), { value: Buffer.from('value'), versionId: 'v1' });
    t.deepEqual(await fetcher.fetch('binary/secret'), { value: Buffer.from([1, 2, 3]), versionId: 'v2' });
  } finally {
    if (prevToken === undefined) delete process.env['AWS_SESSION_TOKEN'];
    else process.env['AWS_SESSION_TOKEN'] = prevToken;
  }
  t.deepEqual(extension.requests, [
    { path: '/secretsmanager/get?secretId=string', token: 'token' },
    { path: '/secretsmanager/get?secretId=binary%2Fsecret', token: 'token' },
  ]);
});

for (const [name, status, body, check] of [
  ['client error', 400, 'bad', (err: unknown) => err instanceof LambdaExtensionStatusError && err.status === 400],
  ['server error', 500, 'oops', (err: unknown) => err instanceof LambdaExtensionStatusError && err.status === 500],
  ['invalid JSON', 200, 'not json', (err: unknown) => err instanceof InvalidResponseError],
  ['not an object', 200, '"string"', (err: unknown) => err instanceof InvalidResponseError],
  ['wrong field type', 200, '{"SecretString": 1}', (err: unknown) => err instanceof InvalidResponseError],
  ['no value', 200, '{"VersionId": "v1"}', (err: unknown) => err instanceof InvalidResponseError],
] as const) {
  test(`Lambda extension fetcher error: ${name}`, async (t) => {
    t.context.extension.respond = () => [status, body];
    const err = await t.throwsAsync(new LambdaExtensionFetcher(t.context.port).fetch('id'));
    t.true(check(err), String(err));
  });
}

test.serial('Lambda extension fetcher connection refused', async (t) => {
  const err = await t.throwsAsync(new LambdaExtensionFetcher(await closedPort()).fetch('id'));
  t.false(err instanceof FetchTimeoutError);
  t.is(classifyFailure(err), 'other');
});

function fakeClient(send: (input: { SecretId?: string }, signal?: AbortSignal) => Promise<unknown>) {
  return {
    send: (command: GetSecretValueCommand, options?: { abortSignal?: AbortSignal }) => {
      if (!(command instanceof GetSecretValueCommand)) {
        throw new Error('unexpected command');
      }
      return send(command.input, options?.abortSignal);
    },
  } as unknown as SecretsManagerClient;
}

test('SDK fetcher', async (t) => {
  const inputs: unknown[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const fetcher = new SDKFetcher(
    fakeClient(async (input, signal) => {
      inputs.push(input);
      signals.push(signal);
      return input.SecretId === 'binary'
        ? { SecretBinary: new Uint8Array([1, 2]), VersionId: 'v2' }
        : { SecretString: 'value', VersionId: 'v1' };
    })
  );
  t.is(fetcher.path, 'sdk');
  t.deepEqual(await fetcher.fetch('string'), { value: Buffer.from('value'), versionId: 'v1' });
  t.deepEqual(await fetcher.fetch('binary'), { value: Buffer.from([1, 2]), versionId: 'v2' });
  t.deepEqual(inputs, [{ SecretId: 'string' }, { SecretId: 'binary' }]);
  t.true(signals.every((signal) => signal instanceof AbortSignal));
});

test('SDK fetcher errors', async (t) => {
  const notFound = Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
  const fetcher = new SDKFetcher(fakeClient(async () => Promise.reject(notFound)));
  t.is(await t.throwsAsync(fetcher.fetch('id')), notFound);

  const empty = new SDKFetcher(fakeClient(async () => ({ VersionId: 'v1' })));
  await t.throwsAsync(empty.fetch('id'), { instanceOf: InvalidResponseError, message: 'secret has no value' });
});

for (const [name, reason] of [
  ['ResourceNotFoundException', 'resource_not_found'],
  ['AccessDeniedException', 'access_denied'],
  ['DecryptionFailure', 'decryption_failure'],
  ['InvalidRequestException', 'invalid_request'],
  ['InvalidParameterException', 'invalid_request'],
  ['ThrottlingException', 'throttling'],
  ['InternalServiceError', 'internal_service_error'],
  ['SomethingElse', 'other'],
  ['toString', 'other'],
] as const) {
  test(`classify AWS error ${name}`, (t) => {
    t.is(classifyFailure(Object.assign(new Error(), { name })), reason);
  });
}

test('classify other errors', (t) => {
  t.is(classifyFailure(new InvalidResponseError('bad')), 'invalid_response');
  t.is(classifyFailure(new FetchTimeoutError('slow')), 'timeout');
  t.is(classifyFailure(new LambdaExtensionStatusError(403, '')), 'client_error');
  t.is(classifyFailure(new LambdaExtensionStatusError(503, '')), 'server_error');
  t.is(classifyFailure(new LambdaExtensionStatusError(302, '')), 'other');
  t.is(classifyFailure('string'), 'other');
});

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const set = (vals: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  set(env);
  try {
    fn();
  } finally {
    set(prev);
  }
}

test.serial('default fetcher selection', (t) => {
  withEnv({ [ENV_LAMBDA_EXTENSION_PORT]: '1234', AWS_LAMBDA_FUNCTION_NAME: undefined }, () => {
    t.true(newDefaultFetcher() instanceof LambdaExtensionFetcher);
  });
  withEnv({ [ENV_LAMBDA_EXTENSION_PORT]: '', AWS_LAMBDA_FUNCTION_NAME: 'fn' }, () => {
    t.true(newDefaultFetcher() instanceof SDKFetcher);
  });
  withEnv({ [ENV_LAMBDA_EXTENSION_PORT]: undefined, AWS_LAMBDA_FUNCTION_NAME: undefined }, () => {
    t.true(newDefaultFetcher() instanceof SDKFetcher);
  });
  withEnv({ [ENV_LAMBDA_EXTENSION_PORT]: undefined, AWS_LAMBDA_FUNCTION_NAME: 'fn' }, () => {
    t.true(newDefaultFetcher() instanceof DetectingFetcher);
  });
});

test.serial('probe', async (t) => {
  t.true(await probe(t.context.port));
  t.false(await probe(await closedPort()));
});

test('detecting fetcher uses a detected Lambda extension', async (t) => {
  t.context.extension.respond = () => [200, JSON.stringify({ SecretString: 'value', VersionId: 'v1' })];
  const fetcher = new DetectingFetcher(t.context.port);
  t.deepEqual(await fetcher.fetch('id'), { value: Buffer.from('value'), versionId: 'v1' });
  t.is(fetcher.path, 'extension');
  t.is(t.context.extension.requests.length, 1);
});
