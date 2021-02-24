/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Connection, compileWorkflowOptions, addDefaults } from '@temporalio/client';
import { Worker } from '@temporalio/worker/lib/worker';
import { ArgsAndReturn } from '../../test-interfaces/lib';
import * as iface from '@temporalio/proto';
import { defaultDataConverter } from '@temporalio/workflow/commonjs/converter/data-converter';
import { u8 } from './helpers';

if (process.env.RUN_INTEGRATION_TESTS === '1') {
  test.before(() => {
    const worker = new Worker(__dirname, { workflowsPath: `${__dirname}/../../test-workflows/lib` });
    // TODO: worker shutdown is not yet implemented, fix this dangling promise
    worker.run('test');
  });

  test('args-and-return', async (t) => {
    const client = new Connection();
    const workflow = client.workflow<ArgsAndReturn>('args-and-return', { taskQueue: 'test' });
    const res = await workflow('Hello', undefined, u8('world!'));
    t.is(res, 'Hello, world!');
  });

  test('WorkflowOptions are passed correctly with defaults', async (t) => {
    const client = new Connection();
    const opts = compileWorkflowOptions(addDefaults({ taskQueue: 'test' }));
    const runId = await client.startWorkflowExecution(opts, 'args-and-return');
    const execution = await client.service.describeWorkflowExecution({
      namespace: client.options.namespace,
      execution: { runId, workflowId: opts.workflowId },
    });
    t.deepEqual(
      execution.workflowExecutionInfo?.type,
      iface.temporal.api.common.v1.WorkflowType.create({ name: 'args-and-return' })
    );
    t.deepEqual(execution.workflowExecutionInfo?.memo, iface.temporal.api.common.v1.Memo.create({ fields: {} }));
    t.deepEqual(
      execution.workflowExecutionInfo?.searchAttributes,
      iface.temporal.api.common.v1.SearchAttributes.create({})
    );
    t.is(execution.executionConfig?.taskQueue?.name, 'test');
    t.is(execution.executionConfig?.taskQueue?.kind, iface.temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_NORMAL);
    t.is(execution.executionConfig?.workflowRunTimeout, null);
    t.is(execution.executionConfig?.workflowExecutionTimeout, null);
  });

  test('WorkflowOptions are passed correctly', async (t) => {
    const client = new Connection();
    const opts = compileWorkflowOptions(
      addDefaults({
        taskQueue: 'test2',
        memo: { a: 'b' },
        searchAttributes: { CustomIntField: 3 },
        workflowId: uuid4(),
        workflowRunTimeout: '1s',
        workflowExecutionTimeout: '2s',
        workflowTaskTimeout: '3s',
      })
    );
    const runId = await client.startWorkflowExecution(opts, 'set-timeout');
    const execution = await client.service.describeWorkflowExecution({
      namespace: client.options.namespace,
      execution: { runId, workflowId: opts.workflowId },
    });
    t.deepEqual(
      execution.workflowExecutionInfo?.type,
      iface.temporal.api.common.v1.WorkflowType.create({ name: 'set-timeout' })
    );
    t.deepEqual(defaultDataConverter.fromPayload(execution.workflowExecutionInfo!.memo!.fields!.a!), 'b');
    t.deepEqual(
      defaultDataConverter.fromPayload(
        execution.workflowExecutionInfo!.searchAttributes!.indexedFields!.CustomIntField!
      ),
      3
    );
    t.is(execution.executionConfig?.taskQueue?.name, 'test2');
    t.is(execution.executionConfig?.taskQueue?.kind, iface.temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_NORMAL);
    // TODO: convert Duraton with Long to number and test these
    // t.is(execution.executionConfig?.workflowRunTimeout, opts.workflowRunTimeout);
    // t.is(execution.executionConfig?.workflowExecutionTimeout, opts.workflowExecutionTimeout);
    // t.is(execution.executionConfig?.defaultWorkflowTaskTimeout, opts.workflowTaskTimeout);
  });

  test.todo('untilComplete throws if workflow cancelled');
  test.todo('untilComplete throws if terminated');
  test.todo('untilComplete throws if timed out');
  test.todo('untilComplete throws if continued as new');
}
