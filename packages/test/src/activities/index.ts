/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { activityInfo, Context } from '@temporalio/activity';
import { ApplicationFailure, ApplicationFailureCategory } from '@temporalio/common';
import type { ProtoActivityInput } from '../../protos/root';
import { ProtoActivityResult } from '../../protos/root';
import { cancellableFetch as cancellableFetchInner } from './cancellable-fetch';
import { fakeProgress as fakeProgressInner } from './fake-progress';
import { signalSchedulingWorkflow } from './helpers';

export { queryOwnWf, signalSchedulingWorkflow } from './helpers';
export { throwSpecificError } from './failure-tester';

/**
 * Used in order to check Activity interceptor,
 * message should be injected by interceptor according to received header.
 */
export async function echo(message?: string): Promise<string> {
  if (message === undefined) {
    throw new Error('Expected message argument to be defined');
  }
  return message;
}

export async function httpGet(url: string): Promise<string> {
  return `<html><body>hello from ${url}</body></html>`;
}

/**
 * Just a mock, used in Workflow samples
 */
export async function httpGetJSON(url: string): Promise<any> {
  return { url };
}

/**
 * Just a mock, used in Workflow samples as an example of an activity that creates a side-effect
 */
export async function httpPostJSON(_url: string, _data: any): Promise<void> {}

/**
 * Mock for Workflow samples
 */
export async function setup(): Promise<void> {}

/**
 * Mock for Workflow samples, used to demo cleanup (e.g. after cancellation)
 */
export async function cleanup(_url: string): Promise<void> {}

export async function throwAnError(useApplicationFailure: boolean, message: string): Promise<void> {
  if (useApplicationFailure) {
    throw ApplicationFailure.nonRetryable(message, 'Error', 'details', 123, false);
  } else {
    throw new Error(message);
  }
}

export async function waitForCancellation(throwIfAborted?: boolean): Promise<void> {
  try {
    await Context.current().cancelled;
  } catch (e) {
    if (throwIfAborted) {
      Context.current().cancellationSignal.throwIfAborted();
    } else {
      throw e;
    }
  }
}

export async function fakeProgress(sleepIntervalMs = 1000, numIters = 1000): Promise<void> {
  await signalSchedulingWorkflow('activityStarted');
  await fakeProgressInner(sleepIntervalMs, numIters);
}

export async function cancellableFetch(url: string, signalWorkflowOnCheckpoint = false): Promise<Uint8Array> {
  if (signalWorkflowOnCheckpoint) {
    await signalSchedulingWorkflow('activityStarted');
  }
  return await cancellableFetchInner(url);
}

/**
 * Returns a deterministic `Uint8Array` of the requested size. Used by external-storage
 * tests to produce a payload large enough to be offloaded.
 */
export async function produceLargePayload(sizeBytes: number): Promise<Uint8Array> {
  return new Uint8Array(sizeBytes);
}

/**
 * Returns a `Uint8Array` of the requested size filled with a recognizable byte pattern
 * (`i % 256`). Used by external-storage tests to assert byte-exact round-trips.
 */
export async function producePatternedPayload(sizeBytes: number): Promise<Uint8Array> {
  const buf = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) buf[i] = i % 256;
  return buf;
}

/**
 * Returns the length of the received payload. Used by external-storage tests to exercise
 * offloading of activity *input* arguments (the argument is what gets offloaded/retrieved).
 */
export async function consumeLargePayload(payload: Uint8Array): Promise<number> {
  return payload.length;
}

/**
 * Until heartbeat details have been recovered from a previous attempt, heartbeats a large
 * `Uint8Array` (large enough to be offloaded) and throws to force a retry. Once details are present,
 * returns their length.
 */
export async function heartbeatThenReturnDetailsLength(sizeBytes: number): Promise<number> {
  const details = activityInfo().heartbeatDetails as Uint8Array | undefined;
  if (details === undefined) {
    Context.current().heartbeat(new Uint8Array(sizeBytes));
    throw new Error('retry to read heartbeat details on the next attempt');
  }
  return details.length;
}

export async function progressiveSleep(): Promise<void> {
  const cx = Context.current();
  // Use ms formatted string once to test this is supported
  await cx.sleep('100ms');
  cx.heartbeat(1);
  await cx.sleep(100);
  cx.heartbeat(2);
  await cx.sleep(100);
  cx.heartbeat(3);
}

export async function protoActivity(args: ProtoActivityInput): Promise<ProtoActivityResult> {
  return ProtoActivityResult.create({ sentence: `${args.name} is ${args.age} years old.` });
}

export async function throwMaybeBenign(): Promise<void> {
  if (activityInfo().attempt === 1) {
    throw ApplicationFailure.create({ message: 'not benign' });
  }
  if (activityInfo().attempt === 2) {
    throw ApplicationFailure.create({ message: 'benign', category: ApplicationFailureCategory.BENIGN });
  }
}
