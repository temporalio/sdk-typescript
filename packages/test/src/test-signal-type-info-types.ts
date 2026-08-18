/**
 * Compile-time coverage for Signal definition and string reference TypeInfo.
 *
 * Assertions live inside never-called `_assertion` functions. Positive calls fail the build if they stop compiling,
 * while `@ts-expect-error` calls fail the build if an invalid call becomes legal.
 */
import test from 'ava';
import type { Client } from '@temporalio/client';
import type { SignalTypeInfo } from '@temporalio/common';
import type { SignalDefinition } from '@temporalio/workflow';

interface Order {
  id: string;
}

declare const client: Client;
declare const order: Order;
declare const noArgSignal: SignalDefinition<[]>;
declare const orderSignal: SignalDefinition<[Order]>;
declare const orderSignalOrName: SignalDefinition<[Order]> | string;
declare const orderSignalTypeInfo: SignalTypeInfo;
declare const workflow: () => Promise<string>;

test('Signal-with-Start accepts TypeInfo according to the Signal reference form', (t) => {
  function _assertion() {
    void client.workflow.signalWithStart(workflow, {
      workflowId: 'workflow-id',
      taskQueue: 'task-queue',
      signal: orderSignal,
      signalArgs: [order],
    });

    void client.workflow.signalWithStart(workflow, {
      workflowId: 'workflow-id',
      taskQueue: 'task-queue',
      signal: 'order',
      signalArgs: [order],
      signalTypeInfo: orderSignalTypeInfo,
    });

    void client.workflow.signalWithStart<typeof workflow, [Order]>(workflow, {
      workflowId: 'workflow-id',
      taskQueue: 'task-queue',
      signal: orderSignalOrName,
      signalArgs: [order],
    });
  }

  t.pass();
});

test('Signal-with-Start permits omitted arguments for zero-argument Signals', (t) => {
  function _assertion() {
    void client.workflow.signalWithStart(workflow, {
      workflowId: 'workflow-id',
      taskQueue: 'task-queue',
      signal: noArgSignal,
    });

    void client.workflow.signalWithStart(workflow, {
      workflowId: 'workflow-id',
      taskQueue: 'task-queue',
      signal: 'no-arg-signal',
      signalTypeInfo: orderSignalTypeInfo,
    });
  }

  t.pass();
});

test('Signal-with-Start requires arguments for Signals with inputs', (t) => {
  function _assertion() {
    // @ts-expect-error Signals with inputs require signalArgs.
    void client.workflow.signalWithStart<typeof workflow, [Order]>(workflow, {
      workflowId: 'workflow-id',
      taskQueue: 'task-queue',
      signal: orderSignal,
    });
  }

  t.pass();
});

test('Signal-with-Start rejects call-site TypeInfo with a Signal definition', (t) => {
  function _assertion() {
    // @ts-expect-error TypeInfo must be defined on a referenced Signal definition.
    void client.workflow.signalWithStart(workflow, {
      workflowId: 'workflow-id',
      taskQueue: 'task-queue',
      signal: orderSignal,
      signalArgs: [order],
      signalTypeInfo: orderSignalTypeInfo,
    });

    // @ts-expect-error TypeInfo must be defined on a referenced Signal definition.
    void client.workflow.signalWithStart(workflow, {
      workflowId: 'workflow-id',
      taskQueue: 'task-queue',
      signal: noArgSignal,
      signalTypeInfo: orderSignalTypeInfo,
    });

    // @ts-expect-error Call-site TypeInfo requires a Signal name, not a definition-or-name union.
    void client.workflow.signalWithStart<typeof workflow, [Order]>(workflow, {
      workflowId: 'workflow-id',
      taskQueue: 'task-queue',
      signal: orderSignalOrName,
      signalArgs: [order],
      signalTypeInfo: orderSignalTypeInfo,
    });
  }

  t.pass();
});
