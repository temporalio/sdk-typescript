import anyTest from 'ava';
import type { Client, WorkflowHandle } from '@temporalio/client';
import { WorkflowUpdateFailedError, WorkflowUpdateRPCTimeoutOrCancelledError } from '@temporalio/client';
import { ApplicationFailure, defaultPayloadConverter } from '@temporalio/common';
import { throwIfReservedName } from '@temporalio/common/internal/internal-workflow';
import { WorkflowStreamClient, type PollInput, type PollResult } from '../client';
import { encodePayloadWire } from '../workflow';

const test = anyTest;
const pollError = new WorkflowUpdateFailedError(
  'Run closed',
  ApplicationFailure.create({
    type: 'AcceptedUpdateCompletedWorkflow',
  })
);
function page(value: string, offset: number, more_ready = false): PollResult {
  return {
    items: [{ topic: 'events', data: encodePayloadWire(defaultPayloadConverter.toPayload(value)), offset }],
    next_offset: offset + 1,
    more_ready,
  };
}

for (const status of ['COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT']) {
  test(`terminal_${status} pins and drains all pages through the typed delivery path`, async (t) => {
    const queries: Array<[string | undefined, PollInput]> = [];
    let describeCount = 0;
    let pollCount = 0;
    const handle = {
      workflowId: 'workflow',
      async startUpdate() {
        pollCount++;
        throw pollError;
      },
      async describe() {
        describeCount++;
        return { status: { name: status }, runId: 'closed' };
      },
      client: {
        getHandle(_workflowId: string, runId?: string) {
          return {
            async query(_name: string, input: PollInput) {
              queries.push([runId, input]);
              return page(input.from_offset === 0 ? 'first' : 'tail', input.from_offset, input.from_offset === 0);
            },
          };
        },
      },
    } as unknown as WorkflowHandle;
    const received = [];
    for await (const item of new WorkflowStreamClient(handle)
      .topic<string>('events')
      .subscribe(0, { pollCooldown: 0 })) {
      received.push(item);
    }
    t.deepEqual(
      received.map(({ data, offset }) => [data, offset]),
      [
        ['first', 0],
        ['tail', 1],
      ]
    );
    t.deepEqual(queries, [
      ['closed', { topics: ['events'], from_offset: 0 }],
      ['closed', { topics: ['events'], from_offset: 1 }],
    ]);
    t.is(describeCount, 1);
    t.is(pollCount, 1);
  });
}

test('unconfirmed closure, missing workflow and failed descriptions surface the polling error', async (t) => {
  for (const status of ['RUNNING', 'CONTINUED_AS_NEW', 'describe failure']) {
    const handle = {
      workflowId: 'workflow',
      async startUpdate() {
        throw pollError;
      },
      async describe() {
        if (status === 'describe failure') throw new Error('not found');
        return { status: { name: status }, runId: 'run' };
      },
    } as unknown as WorkflowHandle;
    await t.throwsAsync(new WorkflowStreamClient(handle).subscribe().next(), { is: pollError });
  }
  const timeout = new WorkflowUpdateRPCTimeoutOrCancelledError('timed out');
  const handle = {
    workflowId: 'workflow',
    async startUpdate() {
      throw timeout;
    },
    async describe() {
      return { status: { name: 'RUNNING' }, runId: 'run' };
    },
  } as unknown as WorkflowHandle;
  await t.throwsAsync(new WorkflowStreamClient(handle).subscribe().next(), { is: timeout });
});

test('missing query handler and configured query rejection errors propagate unchanged', async (t) => {
  for (const message of ['query handler not registered', 'query rejected']) {
    const queryError = new Error(message);
    const handle = {
      workflowId: 'workflow',
      async startUpdate() {
        throw pollError;
      },
      async describe() {
        return { status: { name: 'COMPLETED' }, runId: 'closed' };
      },
      client: {
        getHandle() {
          return {
            async query() {
              throw queryError;
            },
          };
        },
      },
    } as unknown as WorkflowHandle;
    await t.throwsAsync(new WorkflowStreamClient(handle).subscribe().next(), { is: queryError });
  }
});

test('concurrent subscriptions describe and query their own accepted runs', async (t) => {
  let polls = 0;
  let failFirst!: () => void;
  let failSecond!: () => void;
  const pendingFirst = new Promise<PollResult>((_resolve, reject) => {
    failFirst = () => reject(pollError);
  });
  const pendingSecond = new Promise<PollResult>((_resolve, reject) => {
    failSecond = () => reject(pollError);
  });
  const described: string[] = [];
  const queried: string[] = [];
  const handle = {
    workflowId: 'workflow',
    async startUpdate() {
      const first = polls++ === 0;
      return { workflowRunId: first ? 'first' : 'second', result: () => (first ? pendingFirst : pendingSecond) };
    },
    client: {
      getHandle(_workflowId: string, runId: string) {
        return {
          async describe() {
            described.push(runId);
            return { status: { name: 'COMPLETED' }, runId };
          },
          async query() {
            queried.push(runId);
            return page(runId, 0);
          },
        };
      },
    },
  } as unknown as WorkflowHandle;
  const client = new WorkflowStreamClient(handle);
  const first = client.topic<string>('events').subscribe(0);
  const second = client.topic<string>('events').subscribe(0);
  const firstItem = first.next();
  const secondItem = second.next();
  failFirst();
  t.is((await firstItem).value?.data, 'first');
  failSecond();
  t.is((await secondItem).value?.data, 'second');
  t.deepEqual(described, ['first', 'second']);
  t.deepEqual(queried, ['first', 'second']);
  t.true((await first.next()).done);
  t.true((await second.next()).done);
});

test('continue-as-new clears the previous accepted run before a successor closes immediately', async (t) => {
  const described: Array<string | undefined> = [];
  const queried: string[] = [];
  let handleRequests = 0;
  const workflow = {
    getHandle(_workflowId: string, runId?: string) {
      const initial = handleRequests++ === 0;
      return {
        workflowId: 'workflow',
        client: workflow,
        async startUpdate() {
          if (!initial) throw pollError;
          return {
            workflowRunId: 'old',
            async result() {
              throw pollError;
            },
          };
        },
        async describe() {
          described.push(runId);
          return { status: { name: runId === 'old' ? 'CONTINUED_AS_NEW' : 'COMPLETED' }, runId: runId ?? 'new' };
        },
        async query() {
          queried.push(runId!);
          return page('tail', 0);
        },
      };
    },
  };
  const client = WorkflowStreamClient.create({ workflow } as unknown as Client, 'workflow');
  const subscription = client.topic<string>('events').subscribe(0);
  t.is((await subscription.next()).value?.data, 'tail');
  t.true((await subscription.next()).done);
  t.deepEqual(described, ['old', undefined]);
  t.deepEqual(queried, ['new']);
});

test('poll protocol name is allowed only for Queries and Updates', (t) => {
  const name = '__temporal_workflow_stream_poll';
  for (const type of ['query', 'update'] as const) t.notThrows(() => throwIfReservedName(type, name));
  for (const type of ['signal', 'activity', 'task queue', 'sink', 'workflow'] as const) {
    t.throws(() => throwIfReservedName(type, name), { instanceOf: TypeError });
  }
  t.throws(() => throwIfReservedName('query', name + '_other'), { instanceOf: TypeError });
});

test('closure during an accepted poll delivers only the unread tail', async (t) => {
  let polls = 0;
  const queriedOffsets: number[] = [];
  const handle = {
    workflowId: 'workflow',
    async startUpdate() {
      const first = polls++ === 0;
      return {
        workflowRunId: 'closed',
        async result() {
          if (first) return page('first', 0);
          throw pollError;
        },
      };
    },
    client: {
      getHandle(_workflowId: string, runId: string) {
        return {
          async describe() {
            return { status: { name: 'COMPLETED' }, runId };
          },
          async query(_name: string, input: PollInput) {
            queriedOffsets.push(input.from_offset);
            return page('tail', input.from_offset);
          },
        };
      },
    },
  } as unknown as WorkflowHandle;
  const values: string[] = [];
  for await (const item of new WorkflowStreamClient(handle).topic<string>('events').subscribe(0, { pollCooldown: 0 })) {
    values.push(item.data);
  }
  t.deepEqual(values, ['first', 'tail']);
  t.deepEqual(queriedOffsets, [1]);
});

test('terminal descriptions without a run ID do not create unpinned read handles', async (t) => {
  for (const runId of [undefined, '']) {
    let readHandles = 0;
    const handle = {
      workflowId: 'workflow',
      async startUpdate() {
        throw pollError;
      },
      async describe() {
        return { status: { name: 'COMPLETED' }, runId };
      },
      client: {
        getHandle() {
          readHandles++;
          throw new Error('Unpinned read handle');
        },
      },
    } as unknown as WorkflowHandle;
    await t.throwsAsync(new WorkflowStreamClient(handle).subscribe().next(), { is: pollError });
    t.is(readHandles, 0);
  }
});
