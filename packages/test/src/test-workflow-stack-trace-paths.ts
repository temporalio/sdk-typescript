import path from 'node:path';
import test from 'ava';
import Long from 'long';
import { TypedSearchAttributes } from '@temporalio/common';
import { msToTs } from '@temporalio/common/time';
import { coresdk } from '@temporalio/proto';
import { bundleWorkflowCode } from '@temporalio/worker';
import { parseWorkflowCode, type VMWorkflow, VMWorkflowCreator } from '@temporalio/worker/internal';
import { createUnsafeRandomSource } from '@temporalio/workflow/internal';
import { isBun } from './helpers';

// Bun does not apply the bundle's source map to Workflow stack traces.
(isBun ? test.skip : test)('Workflow stack traces report source paths without percent-encoding', async (t) => {
  const workflowsPath = require.resolve('./workflows/throw-async');
  const bundle = parseWorkflowCode((await bundleWorkflowCode({ workflowsPath })).code);
  // Move the Workflow's source into a directory whose name needs URL encoding.
  const sourceIndex = bundle.sourceMap.sources.findIndex((source) => source?.endsWith('/workflows/throw-async.ts'));
  const originalSource = bundle.sourceMap.sources[sourceIndex];
  if (!originalSource) return t.fail('throw-async.ts is not a source of the bundle');
  const renamedSource = path.join(path.dirname(originalSource), 'zz space dir é', 'throw-async.ts');
  bundle.sourceMap.sources[sourceIndex] = renamedSource;

  const creator = await VMWorkflowCreator.create(bundle, 4000, new Set());
  t.teardown(() => creator.destroy());
  const runId = 'stack-trace-source-paths';
  const workflow = (await creator.createWorkflow({
    info: {
      workflowType: 'throwAsync',
      runId,
      workflowId: `${runId}-workflow-id`,
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
      unsafe: {
        isReplaying: false,
        isReplayingHistoryEvents: false,
        now: Date.now,
        random: createUnsafeRandomSource(Math.random),
      },
      startTime: new Date(),
      runStartTime: new Date(),
    },
    randomnessSeed: Long.fromInt(1337).toBytes(),
    now: Date.now(),
    showStackTraceSources: true,
  })) as VMWorkflow;
  t.teardown(() => workflow.dispose());

  const completion = await workflow.activate(
    coresdk.workflow_activation.WorkflowActivation.fromObject({
      runId,
      timestamp: msToTs(Date.now()),
      jobs: [
        {
          initializeWorkflow: {
            workflowId: `${runId}-workflow-id`,
            workflowType: 'throwAsync',
            originalExecutionRunId: runId,
          },
        },
      ],
    })
  );

  const stackTrace = completion.successful?.commands?.[0]?.failWorkflowExecution?.failure?.stackTrace;
  t.true(stackTrace?.includes(`at throwAsync (${renamedSource}:`), stackTrace ?? 'no stack trace');
});
