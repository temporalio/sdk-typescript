import { Connection, WorkflowClient } from '@temporalio/client';
import { Payload, PayloadCodec } from '@temporalio/common';
import { InjectedSinks, Worker } from '@temporalio/worker';
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { createConcatActivity } from './activities/create-concat-activity';
import { RUN_INTEGRATION_TESTS, u8 } from './helpers';
import { defaultOptions } from './mock-native-worker';
import { LogSinks, twoStrings, twoStringsActivity } from './workflows';

class TestEncodeCodec implements PayloadCodec {
  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => {
      payload.data = u8('"encoded"');
      return payload;
    });
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads;
  }
}

class TestDecodeCodec implements PayloadCodec {
  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads;
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => {
      payload.data = u8('"decoded"');
      return payload;
    });
  }
}

if (RUN_INTEGRATION_TESTS) {
  test('Workflow arguments and retvals are encoded', async (t) => {
    const logs: string[] = [];
    const sinks: InjectedSinks<LogSinks> = {
      logger: {
        log: {
          fn(_, message) {
            logs.push(message);
          },
        },
      },
    };

    const dataConverter = { payloadCodec: new TestEncodeCodec() };
    const taskQueue = 'test-workflow-encoded';
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      dataConverter,
      sinks,
    });
    const client = new WorkflowClient(new Connection().service, { dataConverter });
    const runAndShutdown = async () => {
      const result = await client.execute(twoStrings, {
        args: ['arg1', 'arg2'],
        workflowId: uuid4(),
        taskQueue,
      });

      t.is(result, 'encoded'); // workflow retval encoded by worker
      worker.shutdown();
    };
    await Promise.all([worker.run(), runAndShutdown()]);
    t.is(logs[0], 'encodedencoded'); // workflow args encoded by client
  });

  test('Workflow arguments and retvals are decoded', async (t) => {
    const logs: string[] = [];
    const sinks: InjectedSinks<LogSinks> = {
      logger: {
        log: {
          fn(_, message) {
            logs.push(message);
          },
        },
      },
    };

    const dataConverter = { payloadCodec: new TestDecodeCodec() };
    const taskQueue = 'test-workflow-decoded';
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      dataConverter,
      sinks,
    });
    const client = new WorkflowClient(new Connection().service, { dataConverter });
    const runAndShutdown = async () => {
      const result = await client.execute(twoStrings, {
        args: ['arg1', 'arg2'],
        workflowId: uuid4(),
        taskQueue,
      });

      t.is(result, 'decoded'); // workflow retval decoded by client
      worker.shutdown();
    };
    await Promise.all([worker.run(), runAndShutdown()]);
    t.is(logs[0], 'decodeddecoded'); // workflow args decoded by worker
  });

  test('Activity arguments and retvals are encoded', async (t) => {
    const workflowLogs: string[] = [];
    const sinks: InjectedSinks<LogSinks> = {
      logger: {
        log: {
          fn(_, message) {
            workflowLogs.push(message);
          },
        },
      },
    };
    const activityLogs: string[] = [];

    const dataConverter = { payloadCodec: new TestEncodeCodec() };
    const taskQueue = 'test-activity-encoded';
    const worker = await Worker.create({
      ...defaultOptions,
      activities: createConcatActivity(activityLogs),
      taskQueue,
      dataConverter,
      sinks,
    });
    const client = new WorkflowClient(new Connection().service, { dataConverter });
    const runAndShutdown = async () => {
      await client.execute(twoStringsActivity, {
        workflowId: uuid4(),
        taskQueue,
      });
      worker.shutdown();
    };
    await Promise.all([worker.run(), runAndShutdown()]);
    t.is(workflowLogs[0], 'encoded'); // activity retval encoded by worker
    t.is(activityLogs[0], 'Activityencodedencoded'); // activity args encoded by worker
  });

  test('Activity arguments and retvals are decoded', async (t) => {
    const workflowLogs: string[] = [];
    const sinks: InjectedSinks<LogSinks> = {
      logger: {
        log: {
          fn(_, message) {
            workflowLogs.push(message);
          },
        },
      },
    };
    const activityLogs: string[] = [];

    const dataConverter = { payloadCodec: new TestDecodeCodec() };
    const taskQueue = 'test-activity-decoded';
    const worker = await Worker.create({
      ...defaultOptions,
      activities: createConcatActivity(activityLogs),
      taskQueue,
      dataConverter,
      sinks,
    });
    const client = new WorkflowClient(new Connection().service, { dataConverter });
    const runAndShutdown = async () => {
      await client.execute(twoStringsActivity, {
        workflowId: uuid4(),
        taskQueue,
      });
      worker.shutdown();
    };
    await Promise.all([worker.run(), runAndShutdown()]);
    t.is(workflowLogs[0], 'decoded'); // activity retval decoded by worker
    t.is(activityLogs[0], 'Activitydecodeddecoded'); // activity args decoded by worker
  });
}
