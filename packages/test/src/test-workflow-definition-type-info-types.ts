/**
 * Compile-time coverage for Workflow function and string overloads.
 *
 * Assertions live in never-called functions. Positive calls fail the build if they stop compiling, while
 * `@ts-expect-error` calls fail the build if an invalid call becomes legal.
 */
import test from 'ava';
import type { Client } from '@temporalio/client';
import { WithStartWorkflowOperation } from '@temporalio/client';
import type { PayloadTypeInfo } from '@temporalio/common';

declare const client: Client;
declare const workflow: (input: string) => Promise<string>;
declare const typeInfo: PayloadTypeInfo;

test('string Workflow references accept call-site TypeInfo', (t) => {
  function _assertion() {
    const options = {
      workflowId: 'workflow-id',
      taskQueue: 'task-queue',
      args: ['input'] as [string],
      typeInfo,
    };

    void client.workflow.start<typeof workflow>('workflow', options);
    void client.workflow.execute<typeof workflow>('workflow', options);
    void client.workflow.signalWithStart<typeof workflow, []>('workflow', {
      ...options,
      signal: 'signal',
      signalArgs: [],
    });
    void new WithStartWorkflowOperation<typeof workflow>('workflow', {
      ...options,
      workflowIdConflictPolicy: 'FAIL',
    });
  }

  t.pass();
});

test('Workflow function references reject call-site TypeInfo', (t) => {
  function _assertion() {
    const options = {
      workflowId: 'workflow-id',
      taskQueue: 'task-queue',
      args: ['input'] as [string],
      typeInfo,
    };

    // @ts-expect-error TypeInfo must be defined on a referenced Workflow function.
    void client.workflow.start(workflow, options);
    // @ts-expect-error TypeInfo must be defined on a referenced Workflow function.
    void client.workflow.execute(workflow, options);
    // @ts-expect-error TypeInfo must be defined on a referenced Workflow function.
    void client.workflow.signalWithStart(workflow, {
      ...options,
      signal: 'signal',
      signalArgs: [],
    });
    // @ts-expect-error TypeInfo must be defined on a referenced Workflow function.
    void new WithStartWorkflowOperation(workflow, {
      ...options,
      workflowIdConflictPolicy: 'FAIL',
    });
  }

  t.pass();
});
