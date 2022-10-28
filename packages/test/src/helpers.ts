import path from 'path';
import StackUtils from 'stack-utils';
import { inWorkflowContext } from '@temporalio/workflow';
import ava from 'ava';
import { Payload, PayloadCodec } from '@temporalio/common';

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

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function cleanOptionalStackTrace(stackTrace: string | undefined | null): string | undefined {
  return stackTrace ? cleanStackTrace(stackTrace) : undefined;
}

/**
 * Relativize paths and remove line and column numbers from stack trace
 */
export function cleanStackTrace(stack: string): string {
  const su = new StackUtils({ cwd: path.join(__dirname, '../..') });
  const cleaned = su.clean(stack).trimEnd();
  return stack.split('\n')[0] + '\n' + (cleaned && cleaned.replace(/:\d+:\d+/g, '').replace(/^/gms, '    at '));
}

/**
 * (Incomplete) helper to allow mixing workflow and non-workflow code in the same test file.
 */
export const test = inWorkflowContext() ? () => undefined : ava;

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
