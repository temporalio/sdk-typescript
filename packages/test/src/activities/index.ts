/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Context } from '@temporalio/activity';
import { Connection } from '@temporalio/client';
import { fakeProgress as fakeProgressInner } from './fake-progress';
import { cancellableFetch as cancellableFetchInner } from './cancellable-fetch';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function throwAnError(message: string): Promise<void> {
  throw new Error(message);
}

export async function waitForCancellation(): Promise<void> {
  await Context.current().cancelled;
}

async function signalSchedulingWorkflow(signalName: string) {
  const { info } = Context.current();
  const connection = new Connection();
  await connection.service.signalWorkflowExecution({
    namespace: info.workflowNamespace,
    workflowExecution: Context.current().info.workflowExecution,
    signalName,
  });
}

export async function fakeProgress(sleepIntervalMs = 1000): Promise<void> {
  await signalSchedulingWorkflow('activityStarted');
  await fakeProgressInner(sleepIntervalMs);
}

export async function cancellableFetch(url: string, signalWorkflowOnCheckpoint = false): Promise<Uint8Array> {
  if (signalWorkflowOnCheckpoint) {
    await signalSchedulingWorkflow('activityStarted');
  }
  return await cancellableFetchInner(url);
}

export async function progressiveSleep(): Promise<void> {
  await sleep(100);
  Context.current().heartbeat(1);
  await sleep(100);
  Context.current().heartbeat(2);
  await sleep(100);
  Context.current().heartbeat(3);
}
