import type { TestFn, ExecutionContext } from 'ava';
import anyTest from 'ava';
import { v4 as uuid4 } from 'uuid';
import type { InjectedSinks, LogEntry, LogLevel, LoggerSinks } from '@temporalio/worker';
import { DefaultLogger, Runtime, defaultSinks } from '@temporalio/worker';
import type { WorkflowInfo } from '@temporalio/workflow';
import * as workflows from './workflows';
import { Worker, TestWorkflowEnvironment } from './helpers';

interface Context {
  testEnv: TestWorkflowEnvironment;
  taskQueue: string;
}
const test = anyTest as TestFn<Context>;

const recordedLogs: { [workflowId: string]: LogEntry[] } = {};

test.before(async (t) => {
  Runtime.install({
    logger: new DefaultLogger('DEBUG', (entry) => {
      const workflowId = (entry.meta as any)?.workflowInfo?.workflowId ?? (entry.meta as any)?.workflowId;
      recordedLogs[workflowId] ??= [];
      recordedLogs[workflowId].push(entry);
    }),
  });

  t.context = {
    testEnv: await TestWorkflowEnvironment.createLocal(),
    taskQueue: '', // Will be set in beforeEach
  };
});

test.beforeEach(async (t) => {
  t.context.taskQueue = uuid4();
});

test.after.always(async (t) => {
  await t.context.testEnv?.teardown();
});

async function withWorker(
  t: ExecutionContext<Context>,
  p: Promise<any>,
  workflowId: string
): Promise<[LogEntry, LogEntry]> {
  const { nativeConnection } = t.context.testEnv;
  const worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: t.context.taskQueue,
    workflowsPath: require.resolve('./workflows'),
  });
  await worker.runUntil(p);
  const logs = recordedLogs[workflowId];
  t.true(logs.length >= 2);
  return logs as [LogEntry, LogEntry];
}

test('Workflow Worker logs when workflow completes', async (t) => {
  const { client } = t.context.testEnv;
  const workflowId = uuid4();
  const [startLog, endLog] = await withWorker(
    t,
    client.workflow.execute(workflows.successString, { workflowId, taskQueue: t.context.taskQueue }),
    workflowId
  );
  t.is(startLog.level, 'DEBUG');
  t.is(startLog.message, 'Workflow started');
  t.is(startLog.meta?.workflowId, workflowId);
  t.true(typeof startLog.meta?.runId === 'string');
  t.is(startLog.meta?.taskQueue, t.context.taskQueue);
  t.is(startLog.meta?.namespace, 'default');
  t.is(startLog.meta?.workflowType, 'successString');
  t.is(endLog.level, 'DEBUG');
  t.is(endLog.message, 'Workflow completed');
});

test('Workflow Worker logs when workflow continues as new', async (t) => {
  const { client } = t.context.testEnv;
  const workflowId = uuid4();
  const [_, endLog] = await withWorker(
    t,
    t.throwsAsync(
      client.workflow.execute(workflows.continueAsNewSameWorkflow, {
        args: ['execute', 'execute'],
        workflowId,
        taskQueue: t.context.taskQueue,
        followRuns: false,
      })
    ),
    workflowId
  );
  t.is(endLog.level, 'DEBUG');
  t.is(endLog.message, 'Workflow continued as new');
});

test('Workflow Worker logs warning when workflow fails', async (t) => {
  const { client } = t.context.testEnv;
  const workflowId = uuid4();
  const [_, endLog] = await withWorker(
    t,
    t.throwsAsync(
      client.workflow.execute(workflows.throwAsync, {
        workflowId,
        taskQueue: t.context.taskQueue,
        followRuns: false,
      })
    ),
    workflowId
  );
  t.is(endLog.level, 'WARN');
  t.is(endLog.message, 'Workflow failed');
});

test('(Legacy) defaultSinks(logger) can be used to customize where logs are sent', async (t) => {
  const { client } = t.context.testEnv;
  const workflowId = uuid4();
  const { nativeConnection } = t.context.testEnv;
  const logs = Array<LogEntry>();
  const logger = new DefaultLogger('DEBUG', (entry) => logs.push(entry));
  const worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: t.context.taskQueue,
    workflowsPath: require.resolve('./workflows'),
    // eslint-disable-next-line deprecation/deprecation
    sinks: defaultSinks(logger),
  });
  await worker.runUntil(
    client.workflow.execute(workflows.successString, { workflowId, taskQueue: t.context.taskQueue })
  );
  t.false(workflowId in recordedLogs);
  t.true(logs.length >= 2);
  const [startLog, endLog] = logs;
  t.is(startLog.level, 'DEBUG');
  t.is(startLog.message, 'Workflow started');
  t.is(startLog.meta?.workflowId, workflowId);
  t.true(typeof startLog.meta?.runId === 'string');
  t.is(startLog.meta?.taskQueue, t.context.taskQueue);
  t.is(startLog.meta?.namespace, 'default');
  t.is(startLog.meta?.workflowType, 'successString');
  t.is(endLog.level, 'DEBUG');
  t.is(endLog.message, 'Workflow completed');
});

test('(Legacy) Can register defaultWorkerLogger sink to customize where logs are sent', async (t) => {
  const { client } = t.context.testEnv;
  const workflowId = uuid4();
  const { nativeConnection } = t.context.testEnv;
  const logs = Array<LogEntry>();
  const fn = (level: LogLevel, _info: WorkflowInfo, message: string, attrs?: Record<string, unknown>) => {
    logs.push({ level, message, meta: attrs, timestampNanos: 0n });
  };
  const worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: t.context.taskQueue,
    workflowsPath: require.resolve('./workflows'),
    // eslint-disable-next-line deprecation/deprecation
    sinks: <InjectedSinks<LoggerSinks>>{
      defaultWorkerLogger: {
        trace: { fn: fn.bind(undefined, 'TRACE') },
        debug: { fn: fn.bind(undefined, 'DEBUG') },
        info: { fn: fn.bind(undefined, 'INFO') },
        warn: { fn: fn.bind(undefined, 'WARN') },
        error: { fn: fn.bind(undefined, 'ERROR') },
      },
    },
  });
  await worker.runUntil(
    client.workflow.execute(workflows.successString, { workflowId, taskQueue: t.context.taskQueue })
  );
  t.false(workflowId in recordedLogs);
  t.true(logs.length >= 2);
  const [startLog, endLog] = logs;
  t.is(startLog.level, 'DEBUG');
  t.is(startLog.message, 'Workflow started');
  t.is(startLog.meta?.workflowId, workflowId);
  t.true(typeof startLog.meta?.runId === 'string');
  t.is(startLog.meta?.taskQueue, t.context.taskQueue);
  t.is(startLog.meta?.namespace, 'default');
  t.is(startLog.meta?.workflowType, 'successString');
  t.is(endLog.level, 'DEBUG');
  t.is(endLog.message, 'Workflow completed');
});

test('(Legacy) Can explicitly call defaultWorkerLogger sink to emit logs', async (t) => {
  const { client } = t.context.testEnv;
  const workflowId = uuid4();
  const [_, midLog] = await withWorker(
    t,
    client.workflow.execute(workflows.useDepreatedLoggerSinkWorkflow, { workflowId, taskQueue: t.context.taskQueue }),
    workflowId
  );
  t.is(midLog.level, 'INFO');
  t.is(midLog.message, 'Log message from workflow');
});
