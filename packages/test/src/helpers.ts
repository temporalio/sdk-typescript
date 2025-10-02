import * as fs from 'fs/promises';
import * as net from 'net';
import path from 'path';
import * as grpc from '@grpc/grpc-js';
import asyncRetry from 'async-retry';
import ava, { TestFn, ExecutionContext } from 'ava';
import StackUtils from 'stack-utils';
import { v4 as uuid4 } from 'uuid';
import { Client, Connection } from '@temporalio/client';
import { Payload, PayloadCodec } from '@temporalio/common';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import * as iface from '@temporalio/proto';
import {
  ExistingServerTestWorkflowEnvironmentOptions,
  LocalTestWorkflowEnvironmentOptions,
  TestWorkflowEnvironment as RealTestWorkflowEnvironment,
  TimeSkippingTestWorkflowEnvironmentOptions,
} from '@temporalio/testing';
import * as worker from '@temporalio/worker';
import { Worker as RealWorker, WorkerOptions } from '@temporalio/worker';
import { inWorkflowContext } from '@temporalio/workflow';

export function u8(s: string): Uint8Array {
  // TextEncoder requires lib "dom"
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  return new TextEncoder().encode(s);
}

function isSet(env: string | undefined, def: boolean): boolean {
  if (env === undefined) return def;
  env = env.toLocaleLowerCase();
  return env === '1' || env === 't' || env === 'true';
}

export const RUN_INTEGRATION_TESTS = inWorkflowContext() || isSet(process.env.RUN_INTEGRATION_TESTS, true);
export const REUSE_V8_CONTEXT = inWorkflowContext() || isSet(process.env.REUSE_V8_CONTEXT, true);
export const RUN_TIME_SKIPPING_TESTS =
  inWorkflowContext() || !(process.platform === 'linux' && process.arch === 'arm64');

export const TESTS_CLI_VERSION = inWorkflowContext() ? '' : process.env.TESTS_CLI_VERSION;

export const TESTS_TIME_SKIPPING_SERVER_VERSION = inWorkflowContext()
  ? ''
  : process.env.TESTS_TIME_SKIPPING_SERVER_VERSION;

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number = 100
): Promise<void> {
  const endTime = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) {
      return;
    } else if (Date.now() >= endTime) {
      throw new Error('timed out waiting for condition');
    } else {
      await sleep(intervalMs);
    }
  }
}

export function cleanOptionalStackTrace(stackTrace: string | undefined | null): string | undefined {
  return stackTrace ? cleanStackTrace(stackTrace) : undefined;
}

/**
 * Relativize paths and remove line and column numbers from stack trace
 */
export function cleanStackTrace(ostack: string): string {
  // For some reason, a code snippet with carret on error location is sometime prepended before the actual stacktrace.
  // If there is such a snippet, get rid of it.
  const stack = ostack.replace(/^.*\n[ ]*\^[ ]*\n+/gms, '');

  const su = new StackUtils({ cwd: path.join(__dirname, '../..') });
  const firstLine = stack.split('\n')[0];
  const cleanedStack = su.clean(stack).trimEnd();
  let normalizedStack =
    cleanedStack &&
    cleanedStack
      .replace(/:\d+:\d+/g, '')
      .replace(/^\s*/gms, '    at ')
      .replace(/\[as fn\] /, '')
      // Avoid https://github.com/nodejs/node/issues/42417
      .replace(/at null\./g, 'at ')
      .replace(/\\/g, '/');

  // FIXME: Find a better way to handle package vendoring; this will come back again.
  normalizedStack = normalizedStack
    .replaceAll(/\([^() ]*\/node_modules\//g, '(')
    .replaceAll(/\([^() ]*\/nexus-sdk-typescript\/src/g, '(nexus-rpc/src');

  return normalizedStack ? `${firstLine}\n${normalizedStack}` : firstLine;
}

/**
 * Compare stack traces using $CLASS keyword to match any inconsistent identifiers
 *
 * As of Node 24.6.0 type names are now present on source mapped stack traces which leads
 * to different stack traces depending on Node version.
 * See [f33e0fcc83954f728fcfd2ef6ae59435bc4af059](https://github.com/nodejs/node/commit/f33e0fcc83954f728fcfd2ef6ae59435bc4af059)
 */
export function compareStackTrace(t: ExecutionContext, actual: string, expected: string): void {
  const escapedTrace = expected
    .replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
    .replace(/-/g, '\\x2d')
    .replaceAll('\\$CLASS', '(?:[A-Za-z]+)');
  t.regex(actual, RegExp(`^${escapedTrace}$`));
}

function noopTest(): void {
  // eslint: this function body is empty and it's okay.
}

noopTest.serial = () => undefined;
noopTest.macro = () => undefined;
noopTest.before = () => undefined;
noopTest.after = () => undefined;
(noopTest.after as any).always = () => undefined;
noopTest.beforeEach = () => undefined;
noopTest.afterEach = () => undefined;
noopTest.skip = () => noopTest;

/**
 * (Mostly complete) helper to allow mixing workflow and non-workflow code in the same test file.
 */
export const test: TestFn<unknown> = inWorkflowContext() ? (noopTest as any) : ava;

export const testTimeSkipping = RUN_TIME_SKIPPING_TESTS ? test : noopTest;

export const bundlerOptions = {
  // This is a bit ugly but it does the trick, when a test that includes workflow code tries to import a forbidden
  // workflow module, add it to this list:
  ignoreModules: [
    '@temporalio/common/lib/internal-non-workflow',
    '@temporalio/activity',
    '@temporalio/client',
    '@temporalio/testing',
    '@temporalio/nexus',
    '@temporalio/worker',
    'ava',
    'crypto',
    'module',
    'path',
    'stack-utils',
    '@grpc/grpc-js',
    'async-retry',
    'uuid',
    'net',
    'fs/promises',
    'timers',
    'timers/promises',
    require.resolve('./activities'),
    require.resolve('./mock-native-worker'),
  ],
};

/**
 * A PayloadCodec used for testing purposes, skews the bytes in the payload data by 1
 */
export class ByteSkewerPayloadCodec implements PayloadCodec {
  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => ({
      ...payload,
      data: payload.data?.map((byte) => byte + 1),
    }));
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => ({
      ...payload,
      data: payload.data?.map((byte) => byte - 1),
    }));
  }
}

// Hack around Worker and TestWorkflowEnvironment not being available in workflow context
if (inWorkflowContext()) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  worker.Worker = class {}; // eslint-disable-line import/namespace

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  RealTestWorkflowEnvironment = class {}; // eslint-disable-line import/namespace
}

export class Worker extends worker.Worker {
  static async create(options: WorkerOptions): Promise<worker.Worker> {
    return RealWorker.create({ ...options, reuseV8Context: REUSE_V8_CONTEXT });
  }
}

// A custom version of TestWorkflowEnvironment for our own testing use, that
// allow specifying the version of the CLI and Time Skipping Server binaries to
// through environment variables.
export class TestWorkflowEnvironment extends RealTestWorkflowEnvironment {
  static async createLocal(opts?: LocalTestWorkflowEnvironmentOptions): Promise<TestWorkflowEnvironment> {
    return RealTestWorkflowEnvironment.createLocal({
      ...opts,
      ...(TESTS_CLI_VERSION
        ? {
            server: {
              ...opts?.server,
              executable: {
                ...opts?.server?.executable,
                type: 'cached-download',
                version: TESTS_CLI_VERSION,
              },
            },
          }
        : undefined),
    });
  }

  static async createTimeSkipping(opts?: TimeSkippingTestWorkflowEnvironmentOptions): Promise<TestWorkflowEnvironment> {
    return RealTestWorkflowEnvironment.createTimeSkipping({
      ...opts,
      ...(TESTS_TIME_SKIPPING_SERVER_VERSION
        ? {
            server: {
              ...opts?.server,
              executable: {
                ...opts?.server?.executable,
                type: 'cached-download',
                version: TESTS_TIME_SKIPPING_SERVER_VERSION,
              },
            },
          }
        : undefined),
    });
  }

  static async createFromExistingServer(
    opts?: ExistingServerTestWorkflowEnvironmentOptions
  ): Promise<TestWorkflowEnvironment> {
    return RealTestWorkflowEnvironment.createFromExistingServer(opts);
  }
}

// Some of our tests expect "default custom search attributes" to exists, which used to be the case
// in all deployment with support for advanced visibility. However, this might no longer be true in
// some environement (e.g. Temporal CLI). Use the operator service to create them if they're missing.
export async function registerDefaultCustomSearchAttributes(connection: Connection): Promise<void> {
  const client = new Client({ connection }).workflow;
  console.log(`Registering custom search attributes...`);
  const startTime = Date.now();
  try {
    await connection.operatorService.addSearchAttributes({
      namespace: 'default',
      searchAttributes: {
        CustomIntField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_INT,
        CustomBoolField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_BOOL,
        CustomKeywordField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
        CustomTextField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_TEXT,
        CustomDatetimeField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_DATETIME,
        CustomDoubleField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_DOUBLE,
      },
    });
  } catch (err: any) {
    if (err.code !== grpc.status.ALREADY_EXISTS) {
      throw err;
    }
  }
  // The initialization of the custom search attributes is slooooow. Wait for it to finish
  await asyncRetry(
    async () => {
      try {
        // We simply _try_ to schedule a workflow that uses some custom search attributes.
        // The call will fail immediately if the SA are not registered yet. Note that the workflow
        // will actually never execute (ie. no worker is listing to that queue and workflow type
        // doesn't exist). It will just end up being terminated because of a timeout.
        const handle = await client.start('wait-for-default-custom-search-attributes', {
          workflowId: uuid4(),
          taskQueue: 'no_one_cares_pointless_queue',
          workflowExecutionTimeout: 1000,
          searchAttributes: { CustomIntField: [1] },
        });
        await handle.terminate();
      } catch (e: any) {
        // Continue until we see an error that *isn't* about the SA being invalid
        if (!e.cause.details.includes('CustomIntField')) {
          return;
        }
        throw e;
      }
    },
    {
      retries: 60,
      maxTimeout: 1000,
    }
  );
  const timeTaken = Date.now() - startTime;
  console.log(`... Registered (took ${timeTaken / 1000} sec)!`);
}

/**
 * Return a random TCP port number, that is guaranteed to be either available, or to be in use.
 *
 * To get a port that is guaranteed to be available, simply call the function directly.
 *
 * ```ts
 * const port = await getRandomPort();
 * ```
 *
 * To get a port that is guaranteed to be in use, pass a function that will be called with the port
 * number; the port is guaranteed to be in use until the function returns. This may be useful for
 * example to test for proper error handling when a port is already in use.
 *
 * ```ts
 * const port = await getRandomPort(async (port) => {
 *     t.throws(
 *       () => startMyService({ bindAddress: `127.0.0.1:${port}` }),
 *       {
 *         instanceOf: Error,
 *         message: /(Address already in use|socket address)/,
 *       }
 *     );
 *   });
 * });
 * ```
 */
export async function getRandomPort(fn = (_port: number) => Promise.resolve()): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const addr = srv.address();
      if (typeof addr === 'string' || addr === null) {
        throw new Error('Unexpected server address type');
      }
      fn(addr.port)
        .catch((e) => reject(e))
        .finally(() => srv.close((_) => resolve(addr.port)));
    });
  });
}

export async function loadHistory(fname: string): Promise<iface.temporal.api.history.v1.History> {
  const isJson = fname.endsWith('json');
  const fpath = path.resolve(__dirname, `../history_files/${fname}`);
  if (isJson) {
    const hist = await fs.readFile(fpath, 'utf8');
    return JSON.parse(hist);
  } else {
    const hist = await fs.readFile(fpath);
    return iface.temporal.api.history.v1.History.decode(hist);
  }
}

export async function saveHistory(fname: string, history: iface.temporal.api.history.v1.IHistory): Promise<void> {
  const fpath = path.resolve(__dirname, `../history_files/${fname}`);
  await fs.writeFile(fpath, historyToJSON(history));
}

export function approximatelyEqual(
  a: number | null | undefined,
  b: number | null | undefined,
  tolerance = 0.000001
): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return false;
  }
  return Math.abs(a - b) < tolerance;
}
