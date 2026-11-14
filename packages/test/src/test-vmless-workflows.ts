import { Worker as NodeWorker } from 'node:worker_threads';
import test from 'ava';
import Long from 'long';
import { defaultPayloadConverter, toPayloads, TypedSearchAttributes } from '@temporalio/common';
import { msToTs } from '@temporalio/common/time';
import { coresdk } from '@temporalio/proto';
import { bundleWorkflowCode, DefaultLogger, Worker, type BundleOptions } from '@temporalio/worker';
import { parseWorkflowCode, ThreadedVMWorkflowCreator, type WorkflowCreator } from '@temporalio/worker/internal';
import { createThreadedVmlessWorkflowCreator, type Workflow } from '@temporalio/worker/internal/vmless';
import type { WorkflowCreateOptionsInternal } from '@temporalio/workflow/internal/vmless';
import { SdkFlags } from '@temporalio/workflow/internal';

function options(runId: string, now: number): WorkflowCreateOptionsInternal {
  return {
    info: {
      workflowType: 'vmlessOwnership',
      runId,
      workflowId: runId,
      namespace: 'default',
      firstExecutionRunId: runId,
      originalExecutionRunId: runId,
      attempt: 1,
      taskTimeoutMs: 1000,
      taskQueue: 'test',
      searchAttributes: {},
      typedSearchAttributes: new TypedSearchAttributes(),
      historyLength: 3,
      historySize: 300,
      continueAsNewSuggested: false,
      targetWorkerDeploymentVersionChanged: false,
      unsafe: { isReplaying: false, isReplayingHistoryEvents: false } as any,
      startTime: new Date(now),
      runStartTime: new Date(now),
    },
    randomnessSeed: [1, 2, 3],
    now,
    showStackTraceSources: false,
    sourceMap: { version: 3, sources: [], names: [], mappings: '', file: 'test' },
    registeredActivityNames: new Set(),
    stackTracesEnabled: false,
    // Injected in the thread; functions cannot be structured-cloned.
    getTimeOfDay: undefined as any,
  };
}

test('VM-less bundle keeps module state and continuation ownership per execution', async (t) => {
  const bundle = parseWorkflowCode(
    (
      await bundleWorkflowCode({
        workflowsPath: require.resolve('./workflows/vmless-ownership'),
        workflowExecutionMode: 'vmless',
      })
    ).code
  );
  const worker = new NodeWorker(require.resolve('./vmless-bootstrap'), {
    workerData: { bundle, options: [options('a', 1000), options('b', 2000)] },
  });
  t.teardown(() => worker.terminate());
  const result = await new Promise<any>((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Bootstrap exited with code ${code}`));
    });
  });
  t.true(result.outside);
  t.true(result.initializationFailed);
  t.true(result.outsideAfterFailure);
  for (const [index, runId] of ['a', 'b'].entries()) {
    const value = result.results[index];
    t.is(value.importedRunId, runId);
    t.is(value.runId, runId);
    t.is(value.continuedRunId, runId);
    t.is(value.importedTime, (index + 1) * 1000);
    t.is(value.time, value.importedTime);
    t.deepEqual(value.values, [1]);
    t.true(value.scopeRetained);
    t.is(value.updateId, runId);
  }
  t.is(result.results[0].expected, result.results[1].expected);
  t.is(result.results[0].nextRandom, result.results[1].nextRandom);
});

async function creator(
  mode: 'vm' | 'vmless' = 'vmless',
  overrides: Pick<BundleOptions, 'workflowInterceptorModules' | 'payloadConverterPath' | 'failureConverterPath'> = {}
): Promise<WorkflowCreator> {
  const bundle = parseWorkflowCode(
    (
      await bundleWorkflowCode({
        workflowsPath: require.resolve('./workflows/vmless-execution'),
        workflowExecutionMode: mode,
        logger: new DefaultLogger('ERROR'),
        ...overrides,
      })
    ).code
  );
  const opts = {
    workflowBundle: bundle,
    threadPoolSize: 1,
    isolateExecutionTimeoutMs: 1000,
    reuseV8Context: true,
    registeredActivityNames: new Set(['echo']),
    logger: new DefaultLogger('ERROR'),
  };
  return mode === 'vmless' ? createThreadedVmlessWorkflowCreator(opts) : ThreadedVMWorkflowCreator.create(opts);
}

async function createWorkflow(creator: WorkflowCreator, workflowType: string, runId: string): Promise<Workflow> {
  const opts = options(runId, 1000);
  opts.info = { ...opts.info, workflowType };
  return creator.createWorkflow(opts);
}

async function activate(
  workflow: Workflow,
  ...jobs: coresdk.workflow_activation.IWorkflowActivationJob[]
): Promise<coresdk.workflow_completion.IWorkflowActivationCompletion> {
  return workflow.activate(
    coresdk.workflow_activation.WorkflowActivation.fromObject({
      timestamp: msToTs(1000),
      jobs,
    })
  );
}

function initialize(workflowType: string, runId: string): coresdk.workflow_activation.IWorkflowActivationJob {
  return { initializeWorkflow: { workflowType, workflowId: runId, originalExecutionRunId: runId } };
}

function completedResult(completion: coresdk.workflow_completion.IWorkflowActivationCompletion): unknown {
  const payload = completion.successful?.commands?.find((command) => command.completeWorkflowExecution)
    ?.completeWorkflowExecution?.result;
  return payload ? defaultPayloadConverter.fromPayload(payload) : undefined;
}

test('VM-less activations drain deep promise chains and reconstruct module state after disposal', async (t) => {
  const c = await creator();
  t.teardown(() => c.destroy());
  const a = await createWorkflow(c, 'immediate', 'a');
  const b = await createWorkflow(c, 'immediate', 'b');
  const results = await Promise.all([
    activate(a, initialize('immediate', 'a')),
    activate(b, initialize('immediate', 'b')),
  ]);
  t.deepEqual(results.map(completedResult), ['a:1', 'b:1']);
  await a.dispose();
  await a.dispose();
  const reconstructed = await createWorkflow(c, 'immediate', 'a');
  t.is(completedResult(await activate(reconstructed, initialize('immediate', 'a'))), 'a:1');
});

test('VM-less activation permits more than 1000 condition-drain rounds of valid progress', async (t) => {
  const c = await creator();
  t.teardown(() => c.destroy());
  const workflow = await createWorkflow(c, 'manyConditionRounds', 'conditions');
  const result = await activate(workflow, initialize('manyConditionRounds', 'conditions'));
  t.falsy(result.failed);
  t.is(completedResult(result), 3000);
});

test('VM-less lifecycle handles timers, queries, signals, activities, patches, and sinks', async (t) => {
  const c = await creator();
  t.teardown(() => c.destroy());
  const workflow = await createWorkflow(c, 'lifecycle', 'a');
  const first = await activate(workflow, initialize('lifecycle', 'a'));
  t.true(first.successful?.commands?.some((command) => command.startTimer?.seq === 1));
  t.true((await workflow.getAndResetSinkCalls()).length > 0);
  const query = await activate(workflow, { queryWorkflow: { queryId: 'q', queryType: 'state' } });
  const answer = query.successful?.commands?.[0]?.respondToQuery?.succeeded?.response;
  t.is(answer ? defaultPayloadConverter.fromPayload(answer) : undefined, 'waiting');
  const next = await activate(
    workflow,
    {
      signalWorkflow: {
        signalName: 'unblock',
        input: toPayloads(defaultPayloadConverter, 'ready'),
        originatingEventId: Long.fromInt(5),
      },
    },
    { fireTimer: { seq: 1 } }
  );
  t.true(next.successful?.commands?.some((command) => command.scheduleActivity?.activityType === 'echo'));
  const end = await activate(workflow, {
    resolveActivity: {
      seq: 1,
      result: {
        completed: { result: defaultPayloadConverter.toPayload('echoed') },
      },
    },
  });
  t.is(completedResult(end), 'echoed:1:true');
  t.true(end.successful?.commands?.some((command) => command.setPatchMarker?.patchId === 'vmless-patch'));
});

test('VM-less timers with equal sequence numbers belong to different executions', async (t) => {
  const c = await creator();
  t.teardown(() => c.destroy());
  const a = await createWorkflow(c, 'globalTimer', 'a');
  const b = await createWorkflow(c, 'globalTimer', 'b');
  const starts = await Promise.all([
    activate(a, initialize('globalTimer', 'a')),
    activate(b, initialize('globalTimer', 'b')),
  ]);
  for (const start of starts) t.true(start.successful?.commands?.some((command) => command.startTimer?.seq === 1));
  const cancelled = await activate(a, {
    signalWorkflow: { signalName: 'cancel', originatingEventId: Long.fromInt(5) },
  });
  t.is(completedResult(cancelled), 'a');
  t.true(cancelled.successful?.commands?.some((command) => command.cancelTimer?.seq === 1));
  t.is(completedResult(await activate(b, { fireTimer: { seq: 1 } })), 'b');
});

test('VM-less overlapping updates retain ownership when resumed out of order', async (t) => {
  const c = await creator();
  t.teardown(() => c.destroy());
  const workflows = await Promise.all(['a', 'b'].map((id) => createWorkflow(c, 'lifecycle', id)));
  for (const [index, workflow] of workflows.entries()) {
    const runId = index === 0 ? 'a' : 'b';
    await activate(workflow, initialize('lifecycle', runId));
    const result = await activate(
      workflow,
      ...['first', 'second'].map((id) => ({
        doUpdate: {
          name: 'change',
          id,
          protocolInstanceId: id,
          runValidator: true,
          input: toPayloads(defaultPayloadConverter, id),
        },
      }))
    );
    t.is(result.successful?.commands?.filter((command) => command.startTimer).length, 2);
  }
  for (const [index, seq, id] of [
    [1, 3, 'second'],
    [0, 2, 'first'],
    [1, 2, 'first'],
    [0, 3, 'second'],
  ] as const) {
    const result = await activate(workflows[index]!, { fireTimer: { seq } });
    const response = result.successful?.commands?.find((command) => command.updateResponse?.completed)?.updateResponse;
    t.is(response?.protocolInstanceId, id);
    t.is(
      response?.completed ? defaultPayloadConverter.fromPayload(response.completed) : undefined,
      `${index === 0 ? 'a' : 'b'}:${id}`
    );
  }
});

test('VM-less converters and interceptor modules retain execution ownership, including disposal failures', async (t) => {
  const c = await creator('vmless', {
    workflowInterceptorModules: [require.resolve('./workflows/vmless-interceptors')],
    payloadConverterPath: require.resolve('./payload-converters/vmless-converters'),
    failureConverterPath: require.resolve('./payload-converters/vmless-converters'),
  });
  t.teardown(() => c.destroy());
  for (const runId of ['a', 'b', 'a']) {
    const workflow = await createWorkflow(c, 'immediate', runId);
    t.is(completedResult(await activate(workflow, initialize('immediate', runId))), `${runId}:1|${runId}|1`);
    await workflow.dispose();
    await t.throwsAsync(workflow.getAndResetSinkCalls(), { message: /Workflow not running/ });
  }
  const failure = await createWorkflow(c, 'taskFailure', 'failure');
  t.is(
    (await activate(failure, initialize('taskFailure', 'failure'))).failed?.failure?.message,
    'failure:prototype task failure'
  );
  await failure.dispose();
});

test('VM-less thread is terminated even when creator destruction fails', async (t) => {
  const c = await creator('vmless', {
    workflowInterceptorModules: [require.resolve('./workflows/vmless-interceptors')],
  });
  t.teardown(() => c.destroy());
  await createWorkflow(c, 'immediate', 'destruction-failure');
  await t.throwsAsync(c.destroy(), { message: /deliberate disposal failure/ });
});

test('VM-less failure conversion distinguishes workflow and workflow-task failures', async (t) => {
  const c = await creator();
  t.teardown(() => c.destroy());
  for (const name of ['applicationFailure', 'taskFailure']) {
    const workflow = await createWorkflow(c, name, name);
    const result = await activate(workflow, initialize(name, name));
    if (name === 'applicationFailure') {
      t.is(result.successful?.commands?.[0]?.failWorkflowExecution?.failure?.message, 'prototype failure');
    } else {
      t.is(result.failed?.failure?.message, 'prototype task failure');
    }
  }
});

test('VM-less handled detached rejections do not fail the workflow or thread', async (t) => {
  const c = await creator();
  t.teardown(() => c.destroy());
  const workflow = await createWorkflow(c, 'caughtDetachedRejection', 'handled');
  t.is(completedResult(await activate(workflow, initialize('caughtDetachedRejection', 'handled'))), 'handled');
});

const errorConverters = {
  payloadConverterPath: require.resolve('./payload-converters/vmless-error-converters'),
  failureConverterPath: require.resolve('./payload-converters/vmless-error-converters'),
};

for (const [name, expected] of [
  ['completionConversionFailure', 'payload conversion failed'],
  ['emptyRejectionFailure', 'SDK-owned asynchronous operation rejected with undefined'],
  ['failureConversionFailure', 'failure conversion failed:workflow'],
] as const) {
  test(`VM-less SDK-owned ${name} fails only its workflow task`, async (t) => {
    const c = await creator('vmless', errorConverters);
    t.teardown(() => c.destroy());
    const bad = await createWorkflow(c, name, 'bad');
    const good = await createWorkflow(c, 'immediate', 'good');
    const [failure, completion] = await Promise.all([
      activate(bad, initialize(name, 'bad')),
      activate(good, initialize('immediate', 'good')),
    ]);
    t.is(failure.failed?.failure?.message, expected);
    t.is(completedResult(completion), 'good:1');
  });
}

for (const [kind, mode, expected] of [
  ['signal', 'plain', 'signal handler failed'],
  ['signal', 'first', 'failure conversion failed:first'],
  ['signal', 'cleanup', 'signal cleanup failed'],
  ['update', 'plain', 'update handler failed'],
  ['update', 'complete', 'payload conversion failed'],
  ['update', 'first', 'failure conversion failed:first'],
  ['update', 'validate', 'failure conversion failed:validate'],
  ['update', 'fail-input', 'failure conversion failed:input'],
  ['update', 'cleanup', 'update cleanup failed'],
] as const) {
  test(`VM-less SDK-owned ${kind} ${mode} failure is isolated and cleaned up`, async (t) => {
    const c = await creator('vmless', errorConverters);
    t.teardown(() => c.destroy());
    const bad = await createWorkflow(c, 'ownedHandlerErrors', 'bad');
    const good = await createWorkflow(c, 'globalTimer', 'good');
    await activate(good, initialize('globalTimer', 'good'));
    await activate(bad, initialize('ownedHandlerErrors', 'bad'));
    const input = toPayloads(defaultPayloadConverter, mode);
    const job: coresdk.workflow_activation.IWorkflowActivationJob =
      kind === 'signal'
        ? { signalWorkflow: { signalName: 'fail', input, originatingEventId: Long.fromInt(5) } }
        : { doUpdate: { name: 'change', id: 'update', protocolInstanceId: 'update', runValidator: true, input } };
    const failure = await activate(bad, job);
    t.is(failure.failed?.failure?.message, expected);
    t.is(completedResult(await activate(good, { fireTimer: { seq: 1 } })), 'good');
  });
}

test('VM-less SDK observers preserve the first escaping error', async (t) => {
  const c = await creator('vmless', errorConverters);
  t.teardown(() => c.destroy());
  const workflow = await createWorkflow(c, 'ownedHandlerErrors', 'first-error');
  await activate(workflow, initialize('ownedHandlerErrors', 'first-error'));
  const result = await activate(
    workflow,
    ...['first', 'second'].map((mode, i) => ({
      signalWorkflow: {
        signalName: 'fail',
        input: toPayloads(defaultPayloadConverter, mode),
        originatingEventId: Long.fromInt(i + 5),
      },
    }))
  );
  t.is(result.failed?.failure?.message, 'failure conversion failed:first');
});

test('VM-less task failure reporting survives an always-throwing failure converter', async (t) => {
  const c = await creator('vmless', {
    failureConverterPath: require.resolve('./payload-converters/vmless-broken-failure-converter'),
  });
  t.teardown(() => c.destroy());
  const workflow = await createWorkflow(c, 'failureConversionFailure', 'broken-converter');
  const result = await activate(workflow, initialize('failureConversionFailure', 'broken-converter'));
  t.is(result.failed?.failure?.message, 'failure converter is broken');
  const good = await createWorkflow(c, 'immediate', 'good');
  t.is(completedResult(await activate(good, initialize('immediate', 'good'))), 'good:1');
});

test('VM-less ordinary signal application failure remains a workflow failure', async (t) => {
  const c = await creator('vmless', errorConverters);
  t.teardown(() => c.destroy());
  const workflow = await createWorkflow(c, 'ownedHandlerErrors', 'signal');
  await activate(workflow, initialize('ownedHandlerErrors', 'signal'));
  const result = await activate(workflow, {
    signalWorkflow: {
      signalName: 'fail',
      input: toPayloads(defaultPayloadConverter, 'application'),
      originatingEventId: Long.fromInt(5),
    },
  });
  t.falsy(result.failed);
  t.is(
    result.successful?.commands?.find((command) => command.failWorkflowExecution)?.failWorkflowExecution?.failure
      ?.message,
    'signal application failure'
  );
});

for (const mode of ['reject', 'reject-validation']) {
  test(`VM-less ordinary update ${mode} remains an update rejection`, async (t) => {
    const c = await creator('vmless', errorConverters);
    t.teardown(() => c.destroy());
    const workflow = await createWorkflow(c, 'ownedHandlerErrors', 'update');
    await activate(workflow, initialize('ownedHandlerErrors', 'update'));
    const result = await activate(workflow, {
      doUpdate: {
        name: 'change',
        id: 'update',
        protocolInstanceId: 'update',
        runValidator: true,
        input: toPayloads(defaultPayloadConverter, mode),
      },
    });
    t.falsy(result.failed);
    const response = result.successful?.commands?.find((command) => command.updateResponse?.rejected)?.updateResponse;
    t.is(response?.rejected?.message, mode === 'reject' ? 'update rejected' : 'validation rejected');
  });
}

test('VM-less application-caught activity and cancellation failures remain recoverable', async (t) => {
  const c = await creator('vmless', errorConverters);
  t.teardown(() => c.destroy());
  const activity = await createWorkflow(c, 'caughtActivityFailure', 'activity');
  await activate(activity, initialize('caughtActivityFailure', 'activity'));
  const recovered = await activate(activity, {
    resolveActivity: {
      seq: 1,
      result: {
        failed: {
          failure: {
            message: 'activity failed',
            applicationFailureInfo: { type: 'Error', nonRetryable: true },
          },
        },
      },
    },
  });
  t.is(completedResult(recovered), 'recovered');
  const cancelled = await createWorkflow(c, 'caughtCancellation', 'cancelled');
  t.is(completedResult(await activate(cancelled, initialize('caughtCancellation', 'cancelled'))), 'cancelled');
});

for (const mode of ['vm', 'vmless'] as const) {
  for (const singleBatch of [false, true]) {
    test(`${mode} activation ordering with single-batch flag ${singleBatch}`, async (t) => {
      const c = await creator(mode);
      t.teardown(() => c.destroy());
      const workflow = await createWorkflow(c, 'ordering', 'ordering');
      const activateReplay = (jobs: coresdk.workflow_activation.IWorkflowActivationJob[]) =>
        workflow.activate(
          coresdk.workflow_activation.WorkflowActivation.fromObject({
            timestamp: msToTs(1000),
            isReplaying: true,
            availableInternalFlags: singleBatch ? [SdkFlags.ProcessWorkflowActivationJobsAsSingleBatch.id] : [],
            jobs,
          })
        );
      const first = await activateReplay([initialize('ordering', 'ordering')]);
      t.falsy(first.failed);
      const result = await activateReplay([
        { updateRandomSeed: { randomnessSeed: Long.fromInt(456) } },
        { signalWorkflow: { signalName: 'go', originatingEventId: Long.fromInt(5) } },
        { fireTimer: { seq: 1 } },
        { resolveActivity: { seq: 1, result: { completed: { result: defaultPayloadConverter.toPayload('done') } } } },
      ]);
      t.deepEqual(
        completedResult(result),
        singleBatch
          ? ['signal', 'signal.then', 'timer', 'activity', 'condition']
          : ['signal', 'signal.then', 'condition', 'timer', 'activity']
      );
      await workflow.dispose();
    });
  }
}

test('VM-less Worker rejects unsupported configuration before connecting', async (t) => {
  for (const conflicting of [
    { debugMode: true },
    { reuseV8Context: false },
    { showStackTraceSources: true },
    { workflowThreadPoolSize: 2 },
    { bundlerOptions: { preloadModules: ['example'] } },
  ]) {
    await t.throwsAsync(
      Worker.create({
        taskQueue: 'vmless-invalid',
        workflowExecutionMode: 'vmless',
        ...conflicting,
      }),
      { instanceOf: TypeError, message: /VM-less execution/ }
    );
  }
});

test('VM-less and VM prebuilt bundles reject mismatched execution modes', async (t) => {
  for (const mode of ['vm', 'vmless'] as const) {
    const bundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/success-string'),
      workflowExecutionMode: mode,
      logger: new DefaultLogger('ERROR'),
    });
    await t.throwsAsync(
      Worker.create({
        taskQueue: 'vmless-mismatch',
        workflowExecutionMode: mode === 'vm' ? 'vmless' : 'vm',
        workflowBundle: bundle,
      }),
      { instanceOf: TypeError, message: /bundle execution mode/ }
    );
  }
});
