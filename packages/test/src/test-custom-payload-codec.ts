import { randomUUID } from 'crypto';
import type { ExecutionContext } from 'ava';
import { WorkflowClient } from '@temporalio/client';
import type { DataConverter, Payload, PayloadCodec } from '@temporalio/common';
import { decode } from '@temporalio/common/lib/encoding';
import type { InjectedSinks } from '@temporalio/worker';
import { createConcatActivity } from './activities/create-concat-activity';
import { u8 } from './helpers';
import type { Context } from './helpers-integration';
import { helpers, makeTestFunction } from './helpers-integration';
import type { LogSinks } from './workflows';
import { twoStrings, twoStringsActivity } from './workflows';

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

function makeClient(t: ExecutionContext<Context>, dataConverter: DataConverter): WorkflowClient {
  return new WorkflowClient({
    connection: t.context.env.client.connection,
    namespace: t.context.env.client.options.namespace,
    dataConverter,
  });
}

const test = makeTestFunction({ workflowsPath: require.resolve('./workflows') });

test('Workflow arguments and retvals are encoded', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
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

  const dataConverter = { payloadCodecs: [new TestEncodeCodec()] };
  const worker = await createWorker({
    dataConverter,
    sinks,
  });
  const client = makeClient(t, dataConverter);
  await worker.runUntil(async () => {
    const result = await client.execute(twoStrings, {
      args: ['arg1', 'arg2'],
      workflowId: randomUUID(),
      taskQueue,
    });

    t.is(result, 'encoded'); // workflow retval encoded by worker
  });
  t.is(logs[0], 'encodedencoded'); // workflow args encoded by client
});

test('Workflow arguments and retvals are decoded', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
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

  const dataConverter = { payloadCodecs: [new TestDecodeCodec()] };
  const worker = await createWorker({
    dataConverter,
    sinks,
  });
  const client = makeClient(t, dataConverter);
  await worker.runUntil(async () => {
    const result = await client.execute(twoStrings, {
      args: ['arg1', 'arg2'],
      workflowId: randomUUID(),
      taskQueue,
    });

    t.is(result, 'decoded'); // workflow retval decoded by client
  });
  t.is(logs[0], 'decodeddecoded'); // workflow args decoded by worker
});

test('Activity arguments and retvals are encoded', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
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

  const dataConverter = { payloadCodecs: [new TestEncodeCodec()] };
  const worker = await createWorker({
    activities: createConcatActivity(activityLogs),
    dataConverter,
    sinks,
  });
  const client = makeClient(t, dataConverter);
  await worker.runUntil(async () => {
    await client.execute(twoStringsActivity, {
      workflowId: randomUUID(),
      taskQueue,
    });
  });
  t.is(workflowLogs[0], 'encoded'); // activity retval encoded by worker
  t.is(activityLogs[0], 'Activityencodedencoded'); // activity args encoded by worker
});

test('Activity arguments and retvals are decoded', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
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

  const dataConverter = { payloadCodecs: [new TestDecodeCodec()] };
  const worker = await createWorker({
    activities: createConcatActivity(activityLogs),
    dataConverter,
    sinks,
  });
  const client = makeClient(t, dataConverter);
  await worker.runUntil(async () => {
    await client.execute(twoStringsActivity, {
      workflowId: randomUUID(),
      taskQueue,
    });
  });
  t.is(workflowLogs[0], 'decoded'); // activity retval decoded by worker
  t.is(activityLogs[0], 'Activitydecodeddecoded'); // activity args decoded by worker
});

test('Multiple encodes happen in the correct order', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
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

  const dataConverter = {
    payloadCodecs: [
      new TestEncodeCodec(),
      {
        async encode(payloads: Payload[]): Promise<Payload[]> {
          if (decode(payloads[0]!.data!) !== '"encoded"') {
            throw new Error('wrong order');
          }
          return payloads;
        },
        async decode(payloads: Payload[]): Promise<Payload[]> {
          return payloads;
        },
      },
    ],
  };
  const worker = await createWorker({
    dataConverter,
    sinks,
  });
  const client = makeClient(t, dataConverter);
  await worker.runUntil(async () => {
    const result = await client.execute(twoStrings, {
      args: ['arg1', 'arg2'],
      workflowId: randomUUID(),
      taskQueue,
    });

    t.is(result, 'encoded'); // workflow retval encoded by worker
  });
  t.is(logs[0], 'encodedencoded'); // workflow args encoded by client
});

test('Multiple decodes happen in the correct order', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
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

  const dataConverter = {
    payloadCodecs: [
      {
        async encode(payloads: Payload[]): Promise<Payload[]> {
          return payloads;
        },
        async decode(payloads: Payload[]): Promise<Payload[]> {
          if (decode(payloads[0]!.data!) !== '"decoded"') {
            throw new Error('wrong order');
          }

          return payloads;
        },
      },
      new TestDecodeCodec(),
    ],
  };
  const worker = await createWorker({
    dataConverter,
    sinks,
  });
  const client = makeClient(t, dataConverter);
  await worker.runUntil(async () => {
    const result = await client.execute(twoStrings, {
      args: ['arg1', 'arg2'],
      workflowId: randomUUID(),
      taskQueue,
    });

    t.is(result, 'decoded'); // workflow retval decoded by client
  });
  t.is(logs[0], 'decodeddecoded'); // workflow args decoded by worker
});
