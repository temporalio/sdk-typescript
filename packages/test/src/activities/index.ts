/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Context } from '@temporalio/activity';
import { Connection, LOCAL_TARGET, WorkflowClient, WorkflowHandle } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { QueryDefinition } from '@temporalio/internal-workflow-common';
import { ProtoActivityInput, ProtoActivityResult } from '../../protos/root';
import { cancellableFetch as cancellableFetchInner } from './cancellable-fetch';
import { fakeProgress as fakeProgressInner } from './fake-progress';

export { throwSpecificError } from './failure-tester';

// TODO: Get rid of this by providing client via activity context
async function getTestConnection(): Promise<Connection> {
  // TODO: reuse connection
  const address = process.env.TEMPORAL_TESTING_SERVER_URL || LOCAL_TARGET;
  return await Connection.connect({ address });
}

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

export async function waitForCancellation(): Promise<void> {
  await Context.current().cancelled;
}

async function withSchedulingWorkflowHandle<R>(fn: (handle: WorkflowHandle) => Promise<R>): Promise<R> {
  const { info } = Context.current();
  const { workflowExecution } = info;
  const connection = await getTestConnection();
  const client = new WorkflowClient({ connection, namespace: info.workflowNamespace });
  const handle = client.getHandle(workflowExecution.workflowId, workflowExecution.runId);
  try {
    return await fn(handle);
  } finally {
    await connection.close();
  }
}

async function signalSchedulingWorkflow(signalName: string) {
  await withSchedulingWorkflowHandle(async (handle) => handle.signal(signalName));
}

export async function queryOwnWf<R, A extends any[]>(queryDef: QueryDefinition<R, A>, ...args: A): Promise<R> {
  return await withSchedulingWorkflowHandle(async (handle) => handle.query(queryDef, ...args));
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
