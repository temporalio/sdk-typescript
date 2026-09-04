import test from 'ava';
import { CancelledFailure, defaultPayloadConverter, WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { setActivator } from '../global-attributes';
import { CancellationScope } from '../cancellation-scope';
import { Activator } from '../internals';
import type { WorkflowCreateOptionsInternal, WorkflowInfo } from '../interfaces';
import { startSystemNexusOperation } from '../nexus';
import { workflowService } from '../nexus/system/generated/services';

const targetSeq = 1;
const unrelatedSeq = 2;

function makeActivator(): Activator {
  return new Activator({
    info: {
      namespace: 'default',
      workflowId: 'parent-workflow',
    } as WorkflowInfo,
    randomnessSeed: [1],
    now: 0,
    showStackTraceSources: false,
    sourceMap: {} as WorkflowCreateOptionsInternal['sourceMap'],
    registeredActivityNames: new Set(),
    getTimeOfDay: () => 0n,
    stackTracesEnabled: false,
  });
}

function seedChildWorkflowCompletions(activator: Activator): {
  resolved?: string;
  rejected?: Error;
} {
  const observed: { resolved?: string; rejected?: Error } = {};
  activator.completions.childWorkflowStart.set(targetSeq, {
    resolve(runId) {
      observed.resolved = runId;
    },
    reject(error) {
      observed.rejected = error;
    },
  });
  activator.completions.childWorkflowComplete.set(targetSeq, {
    resolve() {},
    reject() {},
  });
  activator.completions.childWorkflowComplete.set(unrelatedSeq, {
    resolve() {},
    reject() {},
  });
  return observed;
}

test('successful child Workflow start retains its completion', (t) => {
  const activator = makeActivator();
  const observed = seedChildWorkflowCompletions(activator);

  activator.resolveChildWorkflowExecutionStart({
    seq: targetSeq,
    succeeded: { runId: 'child-run-id' },
  });

  t.is(observed.resolved, 'child-run-id');
  t.is(observed.rejected, undefined);
  t.false(activator.completions.childWorkflowStart.has(targetSeq));
  t.true(activator.completions.childWorkflowComplete.has(targetSeq));
  t.true(activator.completions.childWorkflowComplete.has(unrelatedSeq));
});

test('failed child Workflow start removes its completion', (t) => {
  const activator = makeActivator();
  const observed = seedChildWorkflowCompletions(activator);

  activator.resolveChildWorkflowExecutionStart({
    seq: targetSeq,
    failed: {
      cause: 1,
      workflowId: 'child-workflow',
      workflowType: 'childWorkflow',
    },
  });

  t.true(observed.rejected instanceof WorkflowExecutionAlreadyStartedError);
  t.is(observed.resolved, undefined);
  t.false(activator.completions.childWorkflowStart.has(targetSeq));
  t.false(activator.completions.childWorkflowComplete.has(targetSeq));
  t.true(activator.completions.childWorkflowComplete.has(unrelatedSeq));
});

test('cancelled child Workflow start removes its completion', (t) => {
  const activator = makeActivator();
  const observed = seedChildWorkflowCompletions(activator);

  activator.resolveChildWorkflowExecutionStart({
    seq: targetSeq,
    cancelled: {
      failure: {
        message: 'cancelled',
        canceledFailureInfo: {},
      },
    },
  });

  t.true(observed.rejected instanceof CancelledFailure);
  t.is(observed.resolved, undefined);
  t.false(activator.completions.childWorkflowStart.has(targetSeq));
  t.false(activator.completions.childWorkflowComplete.has(targetSeq));
  t.true(activator.completions.childWorkflowComplete.has(unrelatedSeq));
});

test('System Nexus uses generated target context and specific then generic interception', (t) => {
  const activator = makeActivator();
  const contexts: unknown[] = [];
  const calls: string[] = [];
  const targetContext = { type: 'workflow' as const, namespace: 'target-ns', workflowId: 'target-id' };
  // Unit tests run outside the workflow isolate, whose injected AsyncLocalStorage
  // normally provides this wrapper.
  activator.bindCurrentRandom = ((fn: () => unknown) => fn) as typeof activator.bindCurrentRandom;
  const originalCurrentScope = CancellationScope.current;
  CancellationScope.current = (() => activator.rootScope) as typeof CancellationScope.current;
  activator.payloadConverter = {
    ...defaultPayloadConverter,
    toPayload(value, context) {
      contexts.push(context);
      return defaultPayloadConverter.toPayload(value, context);
    },
    fromPayload(payload, context) {
      return defaultPayloadConverter.fromPayload(payload, context);
    },
  };
  activator.interceptors.outbound.push({
    signalWithStartWorkflow(request, next) {
      calls.push('specific');
      return next({ ...request, id: 'intercepted-id' });
    },
    startSystemNexusOperation(input, next) {
      calls.push('generic');
      return next(input);
    },
  });
  setActivator(activator);
  try {
    void startSystemNexusOperation({
      service: 'temporal.api.workflowservice.v1.WorkflowService',
      operation: 'SignalWithStartWorkflowExecution',
      input: { workflow: 'workflow', id: 'target-id', taskQueue: 'queue', signal: 'signal', args: ['argument'] },
      inputType: workflowService.operations.signalWithStartWorkflow.inputType!,
      serializationContext: () => targetContext,
      specificInterceptor: 'signalWithStartWorkflow',
    });

    const command = activator.concludeActivation().commands[0]?.scheduleNexusOperation;
    t.deepEqual(calls, ['specific', 'generic']);
    t.is(command?.seq, 1);
    t.is(command?.endpoint, '__temporal_system');
    const envelope = command?.input;
    if (envelope == null) throw new Error('System Nexus command did not include an input envelope');
    t.deepEqual(envelope.metadata?.__temporal_system_payload, new Uint8Array([116, 114, 117, 101]));
    t.is((defaultPayloadConverter.fromPayload(envelope) as { workflowId?: string }).workflowId, 'intercepted-id');
    t.true(contexts.every((context) => context === targetContext));

    t.true(contexts.every((context) => context === targetContext));
  } finally {
    CancellationScope.current = originalCurrentScope;
    setActivator(undefined);
  }
});
