import { historyFromJSON } from '@temporalio/common/lib/proto-utils';
import proto from '@temporalio/proto';
import test from 'ava';
import * as fs from 'fs';
import Long from 'long';
import path from 'path';

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
