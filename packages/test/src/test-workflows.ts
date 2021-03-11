import anyTest, { TestInterface, ExecutionContext } from 'ava';
import path from 'path';
import iface from '@temporalio/proto';
import { defaultDataConverter } from '@temporalio/workflow/commonjs/converter/data-converter';
import { msToTs, msStrToTs } from '@temporalio/workflow/commonjs/time';
import { Workflow } from '@temporalio/worker/lib/workflow';
import { u8 } from './helpers';

export interface Context {
  workflow: Workflow;
  logs: unknown[][];
  script: string;
}

const test = anyTest as TestInterface<Context>;

function getWorkflow(name: string) {
  return path.join(__dirname, '../../test-workflows/lib', name);
}

test.beforeEach(async (t) => {
  const workflow = await Workflow.create('test-workflowId');
  const logs: unknown[][] = [];
  await workflow.inject('console.log', (...args: unknown[]) => void logs.push(args));
  const activities = new Map([['@activities', { httpGet: () => undefined }]]);
  await workflow.registerActivities(activities);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const testName = t.title.match(/\S+$/)![0];
  const script = getWorkflow(`${testName}.js`);
  await workflow.registerImplementation(script);
  t.context = { workflow, logs, script };
});

async function activate(t: ExecutionContext<Context>, activation: iface.coresdk.IWFActivation) {
  const taskToken = u8(`${Math.random()}`);
  const arr = await t.context.workflow.activate(taskToken, activation);
  const req = iface.coresdk.TaskCompletion.decodeDelimited(arr);
  t.deepEqual(req.taskToken, taskToken);
  t.is(req.variant, 'workflow');
  return req;
}

function compareCompletion(
  t: ExecutionContext<Context>,
  req: iface.coresdk.TaskCompletion,
  expected: iface.coresdk.IWFActivationCompletion
) {
  const actual = req.toJSON().workflow;
  t.deepEqual(actual, iface.coresdk.WFActivationCompletion.create(expected).toJSON());
}

function makeSuccess(
  commands: iface.coresdk.ICommand[] = [makeCompleteWorkflowExecution()]
): iface.coresdk.IWFActivationCompletion {
  return { successful: { commands } };
}

function makeStartWorkflow(
  script: string,
  args?: iface.temporal.api.common.v1.IPayloads,
  timestamp: number = Date.now()
): iface.coresdk.IWFActivation {
  return {
    runId: 'test-runId',
    timestamp: msToTs(timestamp),
    jobs: [{ startWorkflow: { workflowId: 'test-workflowId', workflowType: script, arguments: args } }],
  };
}

function makeActivation(
  timestamp: number = Date.now(),
  ...jobs: iface.coresdk.IWFActivationJob[]
): iface.coresdk.IWFActivation {
  return {
    runId: 'test-runId',
    timestamp: msToTs(timestamp),
    jobs,
  };
}

function makeFireTimer(timerId: string, timestamp: number = Date.now()): iface.coresdk.IWFActivation {
  return makeActivation(timestamp, makeFireTimerJob(timerId));
}

function makeFireTimerJob(timerId: string): iface.coresdk.IWFActivationJob {
  return {
    fireTimer: { timerId },
  };
}

function makeResolveActivityJob(
  activityId: string,
  result: iface.coresdk.IActivityResult
): iface.coresdk.IWFActivationJob {
  return {
    resolveActivity: { activityId, result },
  };
}

function makeResolveActivity(
  timerId: string,
  result: iface.coresdk.IActivityResult,
  timestamp: number = Date.now()
): iface.coresdk.IWFActivation {
  return makeActivation(timestamp, makeResolveActivityJob(timerId, result));
}

function makeQueryWorkflow(
  queryType: string,
  queryArgs: any[],
  timestamp: number = Date.now()
): iface.coresdk.IWFActivation {
  return makeActivation(timestamp, makeQueryWorkflowJob(queryType, ...queryArgs));
}

function makeQueryWorkflowJob(queryType: string, ...queryArgs: any[]): iface.coresdk.IWFActivationJob {
  return {
    queryWorkflow: {
      query: { queryType, queryArgs: defaultDataConverter.toPayloads(...queryArgs) },
    },
  };
}

function makeCompleteWorkflowExecution(...payloads: iface.temporal.api.common.v1.IPayload[]): iface.coresdk.ICommand {
  if (payloads.length === 0) payloads = [{ metadata: { encoding: u8('binary/null') } }];
  return {
    api: {
      commandType: iface.temporal.api.enums.v1.CommandType.COMMAND_TYPE_COMPLETE_WORKFLOW_EXECUTION,
      completeWorkflowExecutionCommandAttributes: { result: { payloads } },
    },
  };
}

function makeFailWorkflowExecution(message: string): iface.coresdk.ICommand {
  return {
    api: {
      commandType: iface.temporal.api.enums.v1.CommandType.COMMAND_TYPE_FAIL_WORKFLOW_EXECUTION,
      failWorkflowExecutionCommandAttributes: { failure: { message } },
    },
  };
}

function makeScheduleActivityCommand(
  attrs: iface.temporal.api.command.v1.IScheduleActivityTaskCommandAttributes
): iface.coresdk.ICommand {
  return {
    api: {
      commandType: iface.temporal.api.enums.v1.CommandType.COMMAND_TYPE_SCHEDULE_ACTIVITY_TASK,
      scheduleActivityTaskCommandAttributes: attrs,
    },
  };
}

function makeCancelActivityCommand(activityId: string): iface.coresdk.ICommand {
  return {
    core: {
      requestActivityCancellation: { activityId },
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
    },
  };
}

function makeCancelTimerCommand(
  attrs: iface.temporal.api.command.v1.ICancelTimerCommandAttributes
): iface.coresdk.ICommand {
  return {
    api: {
      commandType: iface.temporal.api.enums.v1.CommandType.COMMAND_TYPE_CANCEL_TIMER,
      cancelTimerCommandAttributes: attrs,
    },
  };
}

function makeRespondToQueryCommand(
  respondToQuery: iface.temporal.api.query.v1.IWorkflowQueryResult
): iface.coresdk.ICommand {
  return {
    core: { respondToQuery },
  };
}

test('random', async (t) => {
  const { logs, script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess());
  t.deepEqual(logs, [[0.9602179527282715]]);
});

test('sync', async (t) => {
  const { script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(
    t,
    req,
    makeSuccess([
      makeCompleteWorkflowExecution({
        metadata: { encoding: u8('json/plain') },
        data: u8(JSON.stringify('success')),
      }),
    ])
  );
});

test('throw-sync', async (t) => {
  const { script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess([makeFailWorkflowExecution('failure')]));
});

test('throw-async', async (t) => {
  const { script } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(t, req, makeSuccess([makeFailWorkflowExecution('failure')]));
});

test('date', async (t) => {
  const { logs, script } = t.context;
  const now = Date.now();
  const req = await activate(t, makeStartWorkflow(script, undefined, now));
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
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(100) })]));
  }
  {
    const req = await activate(t, makeFireTimer('0'));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['slept']]);
});

test('set-timeout-after-microtasks', async (t) => {
  const { logs, script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(100) })]));
  }
  {
    const req = await activate(t, makeFireTimer('0'));
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
  t.deepEqual(logs, [[1, 2, 3], [1, 2, 3], [1, 2, 3], ['wow']]);
});

test('tasks-and-microtasks', async (t) => {
  const { logs, script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(0) })]));
  }
  {
    const req = await activate(t, makeFireTimer('0'));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['script start'], ['script end'], ['promise1'], ['promise2'], ['setTimeout']]);
});

test('trailing-timer', async (t) => {
  const { logs, script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(1) }),
        makeStartTimerCommand({ timerId: '1', startToFireTimeout: msToTs(1) }),
      ])
    );
  }
  {
    const req = await activate(t, makeActivation(undefined, makeFireTimerJob('0'), makeFireTimerJob('1')));
    // Note that the trailing timer does not get scheduled since the workflow completes
    // after the first timer is triggered causing the second one to be dropped.
    compareCompletion(t, req, makeSuccess([makeCompleteWorkflowExecution(defaultDataConverter.toPayload('first'))]));
  }
  t.deepEqual(logs, []);
});

test('promise-race', async (t) => {
  const { logs, script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(20) }),
        makeStartTimerCommand({ timerId: '1', startToFireTimeout: msToTs(30) }),
      ])
    );
  }
  {
    const req = await activate(t, makeActivation(undefined, makeFireTimerJob('0'), makeFireTimerJob('1')));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [[1], [1], [1], [1], [20], ['wow']]);
});

test('race', async (t) => {
  const { logs, script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(10) }),
        makeStartTimerCommand({ timerId: '1', startToFireTimeout: msToTs(11) }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer('0'));
    compareCompletion(t, req, makeSuccess([]));
  }
  {
    const req = await activate(t, makeFireTimer('1'));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [[1], [2], [3]]);
});

test('importer', async (t) => {
  const { logs, script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(10) })]));
  }
  {
    const req = await activate(t, makeFireTimer('0'));
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

test('args-and-return', async (t) => {
  const { script } = t.context;
  const req = await activate(
    t,
    makeStartWorkflow(script, {
      payloads: [
        {
          metadata: { encoding: u8('json/plain') },
          data: u8(JSON.stringify('Hello')),
        },
        {
          metadata: { encoding: u8('binary/null') },
        },
        {
          metadata: { encoding: u8('binary/plain') },
          data: u8('world'),
        },
      ],
    })
  );
  compareCompletion(
    t,
    req,
    makeSuccess([
      makeCompleteWorkflowExecution({
        metadata: { encoding: u8('json/plain') },
        data: u8(JSON.stringify('Hello, world')),
      }),
    ])
  );
});

test('simple-query', async (t) => {
  const { script } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(10) })]));
  }
  {
    const req = await activate(t, makeQueryWorkflow('hasSlept', []));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeRespondToQueryCommand({
          answer: { payloads: [defaultDataConverter.toPayload(false)] },
          resultType: iface.temporal.api.enums.v1.QueryResultType.QUERY_RESULT_TYPE_ANSWERED,
        }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer('0'));
    compareCompletion(t, req, makeSuccess());
  }
  {
    const req = await activate(t, makeQueryWorkflow('hasSleptAsync', []));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeRespondToQueryCommand({
          answer: { payloads: [defaultDataConverter.toPayload(true)] },
          resultType: iface.temporal.api.enums.v1.QueryResultType.QUERY_RESULT_TYPE_ANSWERED,
        }),
      ])
    );
  }
});

test('cancel-workflow', async (t) => {
  const url = 'https://temporal.io';
  const { script, logs } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script, defaultDataConverter.toPayloads(url)));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(1) })]));
  }
  {
    const req = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeCancelTimerCommand({ timerId: '0' }),
        makeStartTimerCommand({ timerId: '1', startToFireTimeout: msToTs(1) }),
      ])
    );
  }
  {
    const req = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '2', startToFireTimeout: msToTs(1) })]));
  }
  {
    const req = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(t, req, makeSuccess([]));
  }
  {
    const req = await activate(t, makeFireTimer('2'));
    compareCompletion(t, req, makeSuccess([makeCompleteWorkflowExecution(defaultDataConverter.toPayload({ url }))]));
  }
  t.deepEqual(logs, [['Workflow cancelled'], ['Workflow cancelled'], ['Workflow cancelled']]);
});

test('cancel-timer-immediately', async (t) => {
  const { script, logs } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(
    t,
    req,
    makeSuccess([
      makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(3) }),
      makeCancelTimerCommand({ timerId: '0' }),
      makeCompleteWorkflowExecution(),
    ])
  );
  t.deepEqual(logs, [['Timer cancelled 👍']]);
});

test('cancel-non-scope-throws', async (t) => {
  const { script, logs } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(
    t,
    req,
    makeSuccess([
      makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(3) }),
      makeCompleteWorkflowExecution(),
    ])
  );
  t.deepEqual(logs, [['Promise is not cancellable'], ['Promise is not cancellable']]);
});

test('cancellation-scopes', async (t) => {
  const { script, logs } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(3) })]));
  }
  {
    const req = await activate(t, makeFireTimer('0'));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ timerId: '1', startToFireTimeout: msToTs(3) }),
        makeStartTimerCommand({ timerId: '2', startToFireTimeout: msToTs(3) }),
        makeCancelTimerCommand({ timerId: '1' }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer('2'));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '3', startToFireTimeout: msToTs(3) })]));
  }
  {
    const req = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(t, req, makeSuccess([makeCancelTimerCommand({ timerId: '3' }), makeCompleteWorkflowExecution()]));
  }
  t.deepEqual(logs, [
    ['Scope cancelled 👍'],
    ['Exception was propagated 👍'],
    ['Scope 2 was not cancelled 👍'],
    ['Scope cancelled 👍'],
    ['Exception was propagated 👍'],
  ]);
});

test('child-and-shield', async (t) => {
  const { script, logs } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(5) }),
        makeStartTimerCommand({ timerId: '1', startToFireTimeout: msToTs(6) }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer('0'));
    compareCompletion(t, req, makeSuccess([]));
  }
  {
    const req = await activate(t, makeFireTimer('1'));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['Exception was propagated 👍'], ['Slept in shield 👍']]);
});

test('partial-shield', async (t) => {
  const { script, logs } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(5) }),
        makeStartTimerCommand({ timerId: '1', startToFireTimeout: msToTs(3) }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer('1'));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '2', startToFireTimeout: msToTs(2) })]));
  }
  {
    const req = await activate(t, makeActivation(undefined, { cancelWorkflow: {} }));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeCancelTimerCommand({ timerId: '2' }),
        makeStartTimerCommand({ timerId: '3', startToFireTimeout: msToTs(10) }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer('0'));
    compareCompletion(t, req, makeSuccess([makeStartTimerCommand({ timerId: '4', startToFireTimeout: msToTs(1) })]));
  }
  {
    const req = await activate(t, makeFireTimer('3'));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [['Workflow cancelled']]);
});

test('shield-in-shield', async (t) => {
  const { script, logs } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(2) }),
        makeStartTimerCommand({ timerId: '1', startToFireTimeout: msToTs(1) }),
      ])
    );
  }
  {
    const req = await activate(t, makeFireTimer('1'));
    compareCompletion(t, req, makeSuccess([]));
  }
  {
    const req = await activate(t, makeFireTimer('0'));
    compareCompletion(t, req, makeSuccess());
  }
  t.deepEqual(logs, [
    ['Exception was propagated 👍'],
    ['Timer 1 finished 👍'],
    ['Timer 0 finished 👍'],
    ['Exception was propagated 👍'],
  ]);
});

test('cancellation-error-is-propagated', async (t) => {
  const { script, logs } = t.context;
  const req = await activate(t, makeStartWorkflow(script));
  compareCompletion(
    t,
    req,
    makeSuccess([
      makeStartTimerCommand({ timerId: '0', startToFireTimeout: msToTs(0) }),
      makeCancelTimerCommand({ timerId: '0' }),
      makeFailWorkflowExecution('Cancelled'),
    ])
  );
  t.deepEqual(logs, []);
});

test('http', async (t) => {
  const { script, logs } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '0',
          activityType: { name: JSON.stringify(['@activities', 'httpGet']) },
          input: defaultDataConverter.toPayloads('https://google.com'),
        }),
      ])
    );
  }
  const result = '<html><body>hello from https://google.com</body></html>';
  {
    const req = await activate(
      t,
      makeResolveActivity('0', { completed: { result: defaultDataConverter.toPayloads(result) } })
    );
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '1',
          activityType: { name: JSON.stringify(['@activities', 'httpGet']) },
          input: defaultDataConverter.toPayloads('http://example.com'),
          startToCloseTimeout: msStrToTs('10 minutes'),
          taskQueue: { name: 'remote' },
        }),
      ])
    );
  }
  {
    const req = await activate(t, makeResolveActivity('1', { failed: { failure: { message: 'Connection timeout' } } }));
    compareCompletion(t, req, makeSuccess([makeFailWorkflowExecution('Connection timeout')]));
  }
  t.deepEqual(logs, [[result]]);
});

test('activity-cancellation', async (t) => {
  const { script, logs } = t.context;
  {
    const req = await activate(t, makeStartWorkflow(script));
    compareCompletion(
      t,
      req,
      makeSuccess([
        makeScheduleActivityCommand({
          activityId: '0',
          activityType: { name: JSON.stringify(['@activities', 'httpGet']) },
          input: defaultDataConverter.toPayloads('https://google.com'),
        }),
        makeCancelActivityCommand('0'),
      ])
    );
  }
  {
    const req = await activate(t, makeResolveActivity('0', { canceled: {} }));
    compareCompletion(t, req, makeSuccess([makeFailWorkflowExecution('Activity cancelled')]));
  }
  t.deepEqual(logs, []);
});
