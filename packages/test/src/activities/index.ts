/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { activityInfo, Context } from '@temporalio/activity';
import { ApplicationFailure, ApplicationFailureCategory } from '@temporalio/common';
import { ProtoActivityInput, ProtoActivityResult } from '../../protos/root';
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
