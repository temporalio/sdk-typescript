import asyncRetry from 'async-retry';
import type { WorkflowHandle } from '@temporalio/client';
import { TEMPORAL_RESERVED_PREFIX } from '@temporalio/common/lib/reserved';
import {
  reservedNames,
  wfReadyQuery,
  workflowReservedNameHandler,
  workflowWithDefaultHandlers,
} from './test-integration-workflows-common';
import { helpers, makeTestFunction } from './helpers-integration';

export * from './test-integration-workflows-common';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
});

test('Cannot register activities using reserved prefixes', async (t) => {
  const { createWorker } = helpers(t);

  for (const name of reservedNames) {
    const activityName = name === TEMPORAL_RESERVED_PREFIX ? name + '_test' : name;
    await t.throwsAsync(
      createWorker({
        activities: { [activityName]: () => {} },
      }),
      {
        name: 'TypeError',
        message:
          name === TEMPORAL_RESERVED_PREFIX
            ? `Cannot use activity name: '${activityName}', with reserved prefix: '${name}'`
            : `Cannot use activity name: '${activityName}', which is a reserved name`,
      }
    );
  }
});

test('Cannot register task queues using reserved prefixes', async (t) => {
  const { createWorker } = helpers(t);

  for (const name of reservedNames) {
    const taskQueue = name === TEMPORAL_RESERVED_PREFIX ? name + '_test' : name;

    await t.throwsAsync(
      createWorker({
        taskQueue,
      }),
      {
        name: 'TypeError',
        message:
          name === TEMPORAL_RESERVED_PREFIX
            ? `Cannot use task queue name: '${taskQueue}', with reserved prefix: '${name}'`
            : `Cannot use task queue name: '${taskQueue}', which is a reserved name`,
      }
    );
  }
});

test('Cannot register sinks using reserved prefixes', async (t) => {
  const { createWorker } = helpers(t);

  for (const name of reservedNames) {
    const sinkName = name === TEMPORAL_RESERVED_PREFIX ? name + '_test' : name;
    await t.throwsAsync(
      createWorker({
        sinks: {
          [sinkName]: {
            test: {
              fn: () => {},
            },
          },
        },
      }),
      {
        name: 'TypeError',
        message:
          name === TEMPORAL_RESERVED_PREFIX
            ? `Cannot use sink name: '${sinkName}', with reserved prefix: '${name}'`
            : `Cannot use sink name: '${sinkName}', which is a reserved name`,
      }
    );
  }
});

test('Workflow failure if define signals/updates/queries with reserved prefixes', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    for (const name of reservedNames) {
      const result = await executeWorkflow(workflowReservedNameHandler, {
        args: [name],
      });
      t.deepEqual(result, [
        {
          name: 'TypeError',
          message:
            name === TEMPORAL_RESERVED_PREFIX
              ? `Cannot use signal name: '${name}_signal', with reserved prefix: '${name}'`
              : `Cannot use signal name: '${name}', which is a reserved name`,
        },
        {
          name: 'TypeError',
          message:
            name === TEMPORAL_RESERVED_PREFIX
              ? `Cannot use update name: '${name}_update', with reserved prefix: '${name}'`
              : `Cannot use update name: '${name}', which is a reserved name`,
        },
        {
          name: 'TypeError',
          message:
            name === TEMPORAL_RESERVED_PREFIX
              ? `Cannot use query name: '${name}_query', with reserved prefix: '${name}'`
              : `Cannot use query name: '${name}', which is a reserved name`,
        },
      ]);
    }
  });
});

test('Default handlers fail given reserved prefix', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();

  const assertWftFailure = async (handle: WorkflowHandle, errMsg: string) => {
    await asyncRetry(
      async () => {
        const history = await handle.fetchHistory();
        const wftFailedEvent = history.events?.findLast((ev) => ev.workflowTaskFailedEventAttributes);
        if (wftFailedEvent === undefined) {
          throw new Error('No WFT failed event found');
        }
        const { failure } = wftFailedEvent.workflowTaskFailedEventAttributes ?? {};
        if (!failure) {
          return t.fail('Expected failure in workflowTaskFailedEventAttributes');
        }
        t.is(failure.message, errMsg);
      },
      { minTimeout: 300, factor: 1, retries: 10 }
    );
  };

  await worker.runUntil(async () => {
    // Reserved query
    let handle = await startWorkflow(workflowWithDefaultHandlers);
    await asyncRetry(async () => {
      if (!(await handle.query(wfReadyQuery))) {
        throw new Error('Workflow not ready yet');
      }
    });
    const queryName = `${TEMPORAL_RESERVED_PREFIX}_query`;
    await t.throwsAsync(
      handle.query(queryName),
      {
        // TypeError transforms to a QueryNotRegisteredError on the way back from server
        name: 'QueryNotRegisteredError',
        message: `Cannot use query name: '${queryName}', with reserved prefix: '${TEMPORAL_RESERVED_PREFIX}'`,
      },
      `Query ${queryName} should fail`
    );
    await handle.terminate();

    // Reserved signal
    handle = await startWorkflow(workflowWithDefaultHandlers);
    await asyncRetry(async () => {
      if (!(await handle.query(wfReadyQuery))) {
        throw new Error('Workflow not ready yet');
      }
    });
    const signalName = `${TEMPORAL_RESERVED_PREFIX}_signal`;
    await handle.signal(signalName);
    await assertWftFailure(
      handle,
      `Cannot use signal name: '${signalName}', with reserved prefix: '${TEMPORAL_RESERVED_PREFIX}'`
    );
    await handle.terminate();

    // Reserved update
    handle = await startWorkflow(workflowWithDefaultHandlers);
    await asyncRetry(async () => {
      if (!(await handle.query(wfReadyQuery))) {
        throw new Error('Workflow not ready yet');
      }
    });
    const updateName = `${TEMPORAL_RESERVED_PREFIX}_update`;
    handle.executeUpdate(updateName).catch(() => {
      // Expect failure. The error caught here is a WorkflowNotFound because
      // the workflow will have already failed, so the update cannot go through.
      // We assert on the expected failure below.
    });
    await assertWftFailure(
      handle,
      `Cannot use update name: '${updateName}', with reserved prefix: '${TEMPORAL_RESERVED_PREFIX}'`
    );
    await handle.terminate();
  });
});
