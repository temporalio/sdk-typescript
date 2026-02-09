import * as fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
import Long from 'long';
import { historyFromJSON } from '@temporalio/common/lib/proto-utils';
import proto from '@temporalio/proto'; // eslint-disable-line import/default

const EventType = proto.temporal.api.enums.v1.EventType;
const ContinueAsNewInitiator = proto.temporal.api.enums.v1.ContinueAsNewInitiator;
const TaskQueueKind = proto.temporal.api.enums.v1.TaskQueueKind;

test('cancel-fake-progress-replay', async (t) => {
  const histJSON = JSON.parse(
    await fs.promises.readFile(path.resolve(__dirname, '../history_files/cancel_fake_progress_history.json'), 'utf8')
  );
  const hist = historyFromJSON(histJSON);
  t.deepEqual(hist.events?.[15].eventId, new Long(16));
  t.is(hist.events?.[15].eventType, EventType.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED);
  t.is(
    hist.events?.[0].workflowExecutionStartedEventAttributes?.initiator,
    ContinueAsNewInitiator.CONTINUE_AS_NEW_INITIATOR_UNSPECIFIED
  );
  t.is(hist.events?.[0].workflowExecutionStartedEventAttributes?.taskQueue?.kind, TaskQueueKind.TASK_QUEUE_KIND_NORMAL);
});

test('null payload data doesnt crash', async (t) => {
  const historyJson = {
    events: [
      {
        eventId: '16',
        eventTime: '2022-07-06T00:33:18.000Z',
        eventType: 'WorkflowExecutionCompleted',
        version: '0',
        taskId: '1057236',
        workflowExecutionCompletedEventAttributes: {
          result: { payloads: [{ metadata: { encoding: 'YmluYXJ5L251bGw=' }, data: null }] },
          workflowTaskCompletedEventId: '15',
          newExecutionRunId: '',
        },
      },
    ],
  };

  // This would throw an error if payload data was still null
  const history = historyFromJSON(historyJson);

  // Make sure that other history properties were not corrupted
  t.is(
    Buffer.from(
      history.events?.[0].workflowExecutionCompletedEventAttributes?.result?.payloads?.[0].metadata!
        .encoding as Uint8Array
    ).toString(),
    'binary/null'
  );
});
