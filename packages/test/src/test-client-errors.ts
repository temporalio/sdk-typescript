import type { TestFn } from 'ava';
import anyTest from 'ava';
import type {
  Next,
  TerminateWorkflowExecutionResponse,
  WorkflowClientInterceptor,
  WorkflowTerminateInput,
} from '@temporalio/client';
import { ApplicationFailure, Client, NamespaceNotFoundError, ValueError } from '@temporalio/client';
import { TestWorkflowEnvironment } from './helpers';

interface Context {
  testEnv: TestWorkflowEnvironment;
}

const test = anyTest as TestFn<Context>;

const unserializableObject = {
  toJSON() {
    throw new TypeError('Unserializable Object');
  },
};

test.before(async (t) => {
  t.context = {
    testEnv: await TestWorkflowEnvironment.createLocal(),
  };
});

test.after.always(async (t) => {
  await t.context.testEnv?.teardown();
});

test('WorkflowClient - namespace not found', async (t) => {
  const { connection } = t.context.testEnv;
  const client = new Client({ connection, namespace: 'non-existent' });
  await t.throwsAsync(
    client.workflow.start('test', {
      workflowId: 'test',
      taskQueue: 'test',
    }),
    {
      instanceOf: NamespaceNotFoundError,
      message: "Namespace not found: 'non-existent'",
    }
  );
});

test('WorkflowClient - listWorkflows - namespace not found', async (t) => {
  const { connection } = t.context.testEnv;
  const client = new Client({ connection, namespace: 'non-existent' });
  await t.throwsAsync(client.workflow.list()[Symbol.asyncIterator]().next(), {
    instanceOf: NamespaceNotFoundError,
    message: "Namespace not found: 'non-existent'",
  });
});

test('WorkflowClient - start - invalid input payload', async (t) => {
  const { connection } = t.context.testEnv;
  const client = new Client({ connection });
  await t.throwsAsync(
    client.workflow.start('test', {
      workflowId: 'test',
      taskQueue: 'test',
      args: [unserializableObject],
    }),
    {
      instanceOf: ValueError,
      message: 'Unable to convert [object Object] to payload',
    }
  );
});

test('WorkflowClient - signalWithStart - invalid input payload', async (t) => {
  const { connection } = t.context.testEnv;
  const client = new Client({ connection });
  await t.throwsAsync(
    client.workflow.signalWithStart('test', {
      workflowId: 'test',
      taskQueue: 'test',
      args: [unserializableObject],
      signal: 'testSignal',
    }),
    {
      instanceOf: ValueError,
      message: 'Unable to convert [object Object] to payload',
    }
  );
});

test('WorkflowClient - signalWorkflow - invalid input payload', async (t) => {
  const { connection } = t.context.testEnv;
  const client = new Client({ connection });
  await t.throwsAsync(client.workflow.getHandle('existant').signal<any[]>('test', [unserializableObject]), {
    instanceOf: ValueError,
    message: 'Unable to convert [object Object] to payload',
  });
});

test('WorkflowClient - queryWorkflow - invalid input payload', async (t) => {
  const { connection } = t.context.testEnv;
  const client = new Client({ connection });
  await t.throwsAsync(client.workflow.getHandle('existant').query<any, any[]>('test', [unserializableObject]), {
    instanceOf: ValueError,
    message: 'Unable to convert [object Object] to payload',
  });
});

test('WorkflowClient - terminateWorkflow - invalid details payload', async (t) => {
  const { connection } = t.context.testEnv;
  const client = new Client({
    connection,
    interceptors: {
      workflow: [
        {
          async terminate(
            input: WorkflowTerminateInput,
            next: Next<WorkflowClientInterceptor, 'terminate'>
          ): Promise<TerminateWorkflowExecutionResponse> {
            return next({
              ...input,
              details: [unserializableObject],
            });
          },
        },
      ],
    },
  });
  await t.throwsAsync(client.workflow.getHandle('existant').terminate('reason'), {
    instanceOf: ValueError,
    message: 'Unable to convert [object Object] to payload',
  });
});

test('ScheduleClient - namespace not found', async (t) => {
  const { connection } = t.context.testEnv;
  const client = new Client({ connection, namespace: 'non-existent' });
  await t.throwsAsync(
    client.schedule.create({
      scheduleId: 'test',
      spec: {
        calendars: [{ hour: { start: 2, end: 7, step: 1 } }],
      },
      action: {
        type: 'startWorkflow',
        workflowType: 'test',
        taskQueue: 'test',
      },
    }),
    {
      instanceOf: NamespaceNotFoundError,
      message: "Namespace not found: 'non-existent'",
    }
  );
});

test('ScheduleClient - listSchedule - namespace not found', async (t) => {
  const { connection } = t.context.testEnv;
  const client = new Client({ connection, namespace: 'non-existent' });
  await t.throwsAsync(client.schedule.list()[Symbol.asyncIterator]().next(), {
    instanceOf: NamespaceNotFoundError,
    message: "Namespace not found: 'non-existent'",
  });
});

test('AsyncCompletionClient - namespace not found', async (t) => {
  const { connection } = t.context.testEnv;
  const client = new Client({ connection, namespace: 'non-existent' });
  await t.throwsAsync(client.activity.complete(new Uint8Array([1]), 'result'), {
    instanceOf: NamespaceNotFoundError,
    message: "Namespace not found: 'non-existent'",
  });
});

test('AsyncCompletionClient - complete - invalid payload', async (t) => {
  const { connection } = t.context.testEnv;
  const client = new Client({ connection });
  await t.throwsAsync(client.activity.complete(new Uint8Array([1]), unserializableObject), {
    instanceOf: ValueError,
    message: 'Unable to convert [object Object] to payload',
  });
});

test('AsyncCompletionClient - fail - invalid payload', async (t) => {
  const { connection } = t.context.testEnv;
  const client = new Client({ connection });
  await t.throwsAsync(
    client.activity.fail(
      new Uint8Array([1]),
      ApplicationFailure.create({ type: 'test', details: [unserializableObject] })
    ),
    {
      instanceOf: ValueError,
      message: 'Unable to convert [object Object] to payload',
    }
  );
});

test('AsyncCompletionClient - reportCancellation - invalid payload', async (t) => {
  const { connection } = t.context.testEnv;
  const client = new Client({ connection });
  await t.throwsAsync(client.activity.reportCancellation(new Uint8Array([1]), unserializableObject), {
    instanceOf: ValueError,
    message: 'Unable to convert [object Object] to payload',
  });
});

test('AsyncCompletionClient - heartbeat - invalid payload', async (t) => {
  const { connection } = t.context.testEnv;
  const client = new Client({ connection });
  await t.throwsAsync(client.activity.heartbeat(new Uint8Array([1]), unserializableObject), {
    instanceOf: ValueError,
    message: 'Unable to convert [object Object] to payload',
  });
});
