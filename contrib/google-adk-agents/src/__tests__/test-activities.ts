/**
 * Worker-side Activities for the graph / dynamic / HITL E2E tests. They run on
 * the worker (never bundled) and record their real executions per Workflow, so a
 * test can tell an Activity that ran from one that was fast-forwarded on resume
 * or never approved.
 */

import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';

/** Real executions, keyed by workflow id, in order: `<activity>:<detail>`. */
const executions = new Map<string, string[]>();

function currentWorkflowId(): string {
  return Context.current().info.workflowExecution?.workflowId ?? 'unknown';
}

function record(entry: string): void {
  const workflowId = currentWorkflowId();
  const list = executions.get(workflowId) ?? [];
  list.push(entry);
  executions.set(workflowId, list);
}

/** The recorded executions for `workflowId`, in order. */
export function executionsFor(workflowId: string): string[] {
  return executions.get(workflowId) ?? [];
}

export async function fetchData(query: string): Promise<string> {
  record(`fetchData:${query}`);
  return `data-for-${query}`;
}

export async function summarize(text: string): Promise<string> {
  record(`summarize:${text}`);
  return `${text} summarized`;
}

export async function combineParts(left: string, right: string): Promise<string> {
  return `${left}+${right}`;
}

export async function enrichItem(item: string): Promise<string> {
  record(`enrichItem:${item}`);
  return `enriched-${item}`;
}

export async function enrichNumber(n: number): Promise<string> {
  record(`enrichNumber:${n}`);
  return `enriched-${n}`;
}

export async function approveActivity(): Promise<string> {
  record('approveActivity');
  return 'approved';
}

export async function rejectActivity(): Promise<string> {
  record('rejectActivity');
  return 'rejected';
}

/** Sleeps well past any test deadline, but stops at once when the Activity is cancelled. */
export async function slowActivity(): Promise<string> {
  record('slowActivity');
  const { cancellationSignal } = Context.current();
  await new Promise<void>((resolve) => {
    if (cancellationSignal.aborted) return resolve();
    const timer = setTimeout(resolve, 20_000);
    cancellationSignal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
  return 'too late';
}

/** Fails its first two calls per Workflow (non-retryably, so ADK's node retry is what re-runs it), then succeeds. */
export async function flakyActivity(): Promise<string> {
  const calls = executionsFor(currentWorkflowId()).filter((e) => e === 'flakyActivity');
  record('flakyActivity');
  if (calls.length < 2) {
    throw ApplicationFailure.nonRetryable(`flaky failure #${calls.length + 1}`, 'TestFlakyFailure');
  }
  return `ok-after-${calls.length}`;
}

export async function failingActivity(): Promise<never> {
  record('failingActivity');
  throw ApplicationFailure.nonRetryable('permanent failure', 'TestPermanentFailure');
}

export async function countedFetch(tag: string): Promise<string> {
  record(`countedFetch:${tag}`);
  return `fetched-${tag}`;
}

/** The tool-shaped Activity behind `activityAsTool` in the confirmation tests: receives the model's arguments. */
export async function dangerActivity(args: { target: string }): Promise<string> {
  record(`dangerActivity:${args.target}`);
  return `danger-done:${args.target}`;
}

export async function echoId(id: string): Promise<string> {
  return id;
}
