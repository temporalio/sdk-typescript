/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Context } from '@temporalio/activity';
import { Connection, LOCAL_DOCKER_TARGET, WorkflowClient } from '@temporalio/client';
import { fakeProgress as fakeProgressInner } from './fake-progress';
import { cancellableFetch as cancellableFetchInner } from './cancellable-fetch';
import { ApplicationFailure, QueryDefinition } from '@temporalio/common';

export { throwSpecificError } from './failure-tester';
import { ProtoActivityInput, ProtoActivityResult } from '../../protos/root';

// TODO: Get rid of this by providing client via activity context
function getTestConnection(): Connection {
  const address = process.env.TEMPORAL_TESTING_SERVER_URL || LOCAL_DOCKER_TARGET;
  return new Connection({ address });
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

async function signalSchedulingWorkflow(signalName: string) {
  const { info } = Context.current();
  const connection = getTestConnection();
  await connection.service.signalWorkflowExecution({
    namespace: info.workflowNamespace,
    workflowExecution: Context.current().info.workflowExecution,
    signalName,
  });
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

export async function queryOwnWf<R, A extends any[]>(queryDef: QueryDefinition<R, A>, ...args: A): Promise<void> {
  const ctx = Context.current();
  const we = ctx.info.workflowExecution;
  const client = new WorkflowClient(getTestConnection().service, { namespace: ctx.info.workflowNamespace });
  try {
    await client.getHandle(we.workflowId, we.runId).query(queryDef, ...args);
  } catch (e) {
    console.log(`Workflow ${JSON.stringify(we)} query err`, e);
  }
}

export async function protoActivity(args: ProtoActivityInput): Promise<ProtoActivityResult> {
  return ProtoActivityResult.create({ sentence: `${args.name} is ${args.age} years old.` });
}
