import anyTest, { TestInterface, ExecutionContext } from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Worker, DefaultLogger, LogEntry, defaultSinks } from '@temporalio/worker';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import * as workflows from './workflows';

interface Context {
  testEnv: TestWorkflowEnvironment;
}
const test = anyTest as TestInterface<Context>;

test.before(async (t) => {
  t.context = {
    testEnv: await TestWorkflowEnvironment.create(),
  };
});

test.after.always(async (t) => {
  await t.context.testEnv?.teardown();
});

async function withWorker(t: ExecutionContext<Context>, p: Promise<any>): Promise<[LogEntry, LogEntry]> {
  const { nativeConnection } = t.context.testEnv;
  const logs = Array<LogEntry>();
  const logger = new DefaultLogger('DEBUG', (entry) => logs.push(entry));
  const worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: 'test',
    workflowsPath: require.resolve('./workflows'),
    sinks: defaultSinks(logger),
  });
  await worker.runUntil(p);
  t.true(logs.length >= 2);
  return logs as [LogEntry, LogEntry];
}

test.serial('WorkflowInboundLogInterceptor logs when workflow completes', async (t) => {
  const { client } = t.context.testEnv;
  const workflowId = uuid4();
  const [startLog, endLog] = await withWorker(
    t,
    client.workflow.execute(workflows.successString, { workflowId, taskQueue: 'test' })
  );
  t.is(startLog.level, 'DEBUG');
  t.is(startLog.message, 'Workflow started');
  t.is(startLog.meta?.workflowId, workflowId);
  t.true(typeof startLog.meta?.runId === 'string');
  t.is(startLog.meta?.taskQueue, 'test');
  t.is(startLog.meta?.namespace, 'default');
  t.is(startLog.meta?.workflowType, 'successString');
  t.is(endLog.level, 'DEBUG');
  t.is(endLog.message, 'Workflow completed');
});

test.serial('WorkflowInboundLogInterceptor logs when workflow continues as new', async (t) => {
  const { client } = t.context.testEnv;
  const [_, endLog] = await withWorker(
    t,
    t.throwsAsync(
      client.workflow.execute(workflows.continueAsNewSameWorkflow, {
        args: ['execute', 'execute'],
        workflowId: uuid4(),
        taskQueue: 'test',
        followRuns: false,
      })
    )
  );
  t.is(endLog.level, 'DEBUG');
  t.is(endLog.message, 'Workflow continued as new');
});

test.serial('WorkflowInboundLogInterceptor logs warning when workflow fails', async (t) => {
  const { client } = t.context.testEnv;
  const [_, endLog] = await withWorker(
    t,
    t.throwsAsync(
      client.workflow.execute(workflows.throwAsync, {
        workflowId: uuid4(),
        taskQueue: 'test',
        followRuns: false,
      })
    )
  );
  t.is(endLog.level, 'WARN');
  t.is(endLog.message, 'Workflow failed');
});
