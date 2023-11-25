import * as wf from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';
import {
  counterWorkflow,
  getValueQuery,
  incrementAndGetValueUpdate,
  incrementSignal,
} from './workflows/update-signal-query-example';

const test = makeTestFunction({
  workflowsPath: require.resolve('./workflows/update-signal-query-example'),
  workflowEnvironmentOpts: {
    // TODO: remove this server config when default test server supports update
    server: {
      executable: {
        type: 'cached-download',
        version: 'latest',
      },
    },
  },
});

/* Example from WorkflowHandle docstring */
test('Update/Signal/Query example in WorkflowHandle docstrings works', async (t) => {
  const { createWorker, startWorkflow, assertWorkflowFailedError } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(counterWorkflow, { args: [2] });
    await wfHandle.signal(incrementSignal, 2);
    const queryResult = await wfHandle.query(getValueQuery);
    t.is(queryResult, 4);
    const updateResult = await wfHandle.executeUpdate(incrementAndGetValueUpdate, { args: [2] });
    t.is(updateResult, 6);
    const secondUpdateHandle = await wfHandle.startUpdate(incrementAndGetValueUpdate, { args: [2] });
    const secondUpdateResult = await secondUpdateHandle.result();
    t.is(secondUpdateResult, 8);
    await wfHandle.cancel();
    await assertWorkflowFailedError(wfHandle.result(), wf.CancelledFailure);
  });
});
