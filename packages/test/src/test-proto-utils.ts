import * as fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
import Long from 'long'; // eslint-disable-line import/no-named-as-default
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
  const sample = `{
    "events": [
      {
        "eventId": "16",
        "eventTime": "2022-07-06T00:33:18.000Z",
        "eventType": "WorkflowExecutionCompleted",
        "version": "0",
        "taskId": "1057236",
        "workflowExecutionCompletedEventAttributes": {
          "result": { "payloads": [{ "metadata": { "encoding": "YmluYXJ5L251bGw=" }, "data": null }] },
          "workflowTaskCompletedEventId": "15",
          "newExecutionRunId": ""
        }
      }
    ]
  }`;

  const histJSON = JSON.parse(sample);
  const hist = historyFromJSON(histJSON);
  t.deepEqual(hist.events?.[0].eventId, new Long(16));
});
