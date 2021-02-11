import test from 'ava';
import { Connection } from '../../lib/workflow-client';
import { Worker } from '../../lib/worker';
import { ArgsAndReturn } from '../../workflow-interfaces/lib';
import { u8 } from './helpers';

test('args-and-return', async (t) => {
  const worker = new Worker(__dirname, { workflowsPath: `${__dirname}/../../test-workflows/lib` });
  // TODO: worker shutdown is not yet implemented, fix this dangling promise
  worker.run("test");
  const client = new Connection();
  const workflow = client.workflow<ArgsAndReturn>('args-and-return', { taskQueue: 'test' });
  const res = await workflow('Hello', undefined, u8('world!'));
  t.is(res, 'Hello, world!');
});

test.todo('WorkflowOptions are passed correctly with defaults');
test.todo('WorkflowOptions are passed correctly');
