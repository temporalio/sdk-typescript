/**
 * Worker-side Activities for the E2E tests. They run on the worker (never
 * bundled) and record their real executions per Workflow, so a test can tell an
 * Activity that ran from one that was replayed.
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

export async function echoId(id: string): Promise<string> {
  return id;
}
