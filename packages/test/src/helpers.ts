import path from 'path';
import StackUtils from 'stack-utils';
import ava, { TestFn } from 'ava';
import { inWorkflowContext } from '@temporalio/workflow';
import { Payload, PayloadCodec } from '@temporalio/common';
import { Worker as RealWorker, WorkerOptions } from '@temporalio/worker';
import * as worker from '@temporalio/worker';

export function u8(s: string): Uint8Array {
  // TextEncoder requires lib "dom"
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  return new TextEncoder().encode(s);
}

export function isSet(env: string | undefined): boolean {
  if (env === undefined) return false;
  env = env.toLocaleLowerCase();
  return env === '1' || env === 't' || env === 'true';
}

export const RUN_INTEGRATION_TESTS = inWorkflowContext() || isSet(process.env.RUN_INTEGRATION_TESTS);
export const REUSE_V8_CONTEXT = inWorkflowContext() || isSet(process.env.REUSE_V8_CONTEXT);

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const normalizedStack =
    cleanedStack &&
    cleanedStack
      .replace(/:\d+:\d+/g, '')
      .replace(/^\s*/gms, '    at ')
      .replace(/\[as fn\] /, '');

  return normalizedStack ? `${firstLine}\n${normalizedStack}` : firstLine;
}

function noopTest() {
  // eslint: this function body is empty and it's okay.
}

noopTest.before = () => undefined;
noopTest.after = () => undefined;
(noopTest.after as any).always = () => undefined;
noopTest.beforeEach = () => undefined;
noopTest.afterEach = () => undefined;

/**
 * (Mostly complete) helper to allow mixing workflow and non-workflow code in the same test file.
 */
export const test: TestFn<unknown> = inWorkflowContext() ? (noopTest as any) : ava;

export const bundlerOptions = {
  // This is a bit ugly but it does the trick, when a test that includes workflow code tries to import a forbidden
  // workflow module, add it to this list:
  ignoreModules: [
    '@temporalio/common/lib/internal-non-workflow',
    '@temporalio/client',
    '@temporalio/testing',
    '@temporalio/worker',
    'ava',
    'crypto',
    'module',
    'path',
    'stack-utils',
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

// Hack around Worker not being available in workflow context
if (inWorkflowContext()) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  worker.Worker = class {}; // eslint-disable-line import/namespace
}

export class Worker extends worker.Worker {
  static async create(options: WorkerOptions): Promise<worker.Worker> {
    return RealWorker.create({ ...options, reuseV8Context: REUSE_V8_CONTEXT });
  }
}
