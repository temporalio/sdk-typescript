import anyTest, { TestInterface, ExecutionContext } from 'ava';
import path from 'path';
import iface from '../../proto/core-interface';
import { Workflow } from '../../lib/workflow';

export interface Context {
  workflow: Workflow;
  logs: unknown[][];
  script: string;
}

const test = anyTest as TestInterface<Context>;

function getWorkflow(name: string) {
  return path.join(__dirname, '../../test-workflows/lib', name);
}

function u8(s: string) {
  return new Uint8Array(s.split('').map((c) => c.charCodeAt(0)));
}

export function msToTs(ms: number): iface.google.protobuf.ITimestamp {
  // TODO: seconds could be bigint | long | null | undeinfed
  const seconds = Math.floor(ms / 1000);
  const nanos = (ms % 1000) * 1000000;
  return { seconds, nanos };
}

test.beforeEach(async (t) => {
  const workflow = await Workflow.create('test-workflowId');
  const logs: unknown[][] = [];
  await workflow.inject('console.log', (...args: unknown[]) => void logs.push(args));
  const testName = t.title.match(/\S+$/)![0];
  const script = getWorkflow(`${testName}.js`);
  await workflow.registerImplementation(script);
  t.context = { workflow, logs, script };
});

async function activate(
  t: ExecutionContext<Context>,
  activation: iface.coresdk.IWFActivation,
) {
  const taskToken = u8(`${Math.random()}`);
  const arr = await t.context.workflow.activate(taskToken, activation);
  const req = iface.coresdk.CompleteTaskReq.decodeDelimited(arr);
  t.deepEqual(req.taskToken, taskToken);
  t.is(req.completion, 'workflow');
  return req;
}

function compareCompletion(
  t: ExecutionContext<Context>,
  req: iface.coresdk.CompleteTaskReq,
  expected: iface.coresdk.IWFActivationCompletion,
) {
  const actual = req.toJSON().workflow;
  t.deepEqual(actual, iface.coresdk.WFActivationCompletion.create(expected).toJSON());
}

function makeSuccess(...commands: iface.coresdk.ICommand[]): iface.coresdk.IWFActivationCompletion {
  return {
    successful: {
      commands: commands.length > 0 ? commands : [makeCompleteWorkflowExecution()],
    }
  }
}

function makeStartWorkflow(script: string, timestamp: number = Date.now()): iface.coresdk.IWFActivation {
  return {
    runId: 'test-runId',
    timestamp: msToTs(timestamp),
    startWorkflow: { workflowId: 'test-workflowId', name: script },
  };
}

function makeUnblockTimer(timerId: string, timestamp: number = Date.now()): iface.coresdk.IWFActivation {
  return {
    runId: 'test-runId',
    timestamp: msToTs(timestamp),
    unblockTimer: { timerId },
  };
}

function makeCompleteWorkflowExecution(
  ...payloads: iface.temporal.api.common.v1.IPayload[]
): iface.coresdk.ICommand {
  return {
    api: {
      commandType: iface.temporal.api.enums.v1.CommandType.COMMAND_TYPE_COMPLETE_WORKFLOW_EXECUTION,
      completeWorkflowExecutionCommandAttributes: { result: { payloads } },
    },
  };
}

function makeStartTimerCommand(
  attrs: iface.temporal.api.command.v1.IStartTimerCommandAttributes
): iface.coresdk.ICommand {
  return {
    api: {
      commandType: iface.temporal.api.enums.v1.CommandType.COMMAND_TYPE_START_TIMER,
      startTimerCommandAttributes: attrs,
    }
  };
}

test('random', async (t) => {
  const { logs, script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[0.9602179527282715]]);
});

test('date', async (t) => {
  const { logs, script } = t.context;
  const now = Date.now();
  const req = await activate(t, makeStartWorkflow(script, now));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[now], [now], [true]]);
});

test('async-workflow', async (t) => {
  const { logs, script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [['async']]);
});

test('deferred-resolve', async (t) => {
  const { logs, script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[1], [2]]);
});

test('set-timeout', async (t) => {
  const { logs, script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, req, makeSuccess(makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(100) })));
  }
  {
    const req = await activate(t, makeUnblockTimer('0'));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['slept']]);
});

test('set-timeout-after-microtasks', async (t) => {
  const { logs, script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, req, makeSuccess(makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(100) })));
  }
  {
    const req = await activate(t, makeUnblockTimer('0'));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['slept']]);
});

test('promise-then-promise', async (t) => {
  const { logs, script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[2]]);
});

test('reject-promise', async (t) => {
  const { logs, script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[true], [true]]);
});

test('promise-all', async (t) => {
  const { logs, script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [
    [1, 2, 3],
    [1, 2, 3],
    [1, 2, 3],
    ['wow'],
  ]);
});

test.skip('promise-race', async (t) => {
  // TODO: fixme
  const { logs, script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [
    [1],
    [1],
    [1],
    [1],
    [20],
    ['wow'],
  ]);
});

test.skip('race', async (t) => {
  // TODO: fixme
  const { logs, script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[1], [2], [3]]);
});

test('importer', async (t) => {
  const { logs, script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, req, makeSuccess(makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(1000) })));
  }
  {
    const req = await activate(t, makeUnblockTimer('0'));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['slept']]);
});

test('external-importer', async (t) => {
  const { logs, script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[{ a: 1, b: 2 }]]);
});

test.todo('args-and-return');
// Test passing workflow args and return value

// TODO: Reimplement once activities are supported
// test('invoke activity as an async function / with options', async (t) => {
//   const script = path.join(__dirname, '../../test-workflows/lib/http.js');
//   await run(script, (logs) => t.deepEqual(logs, [
//     ['<html><body>hello from https://google.com</body></html>'],
//     ['<html><body>hello from http://example.com</body></html>'],
//   ]));
// });
