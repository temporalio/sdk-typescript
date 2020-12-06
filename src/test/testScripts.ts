import path from 'path';
import test from 'ava';
import { Workflow } from '../engine';

test('async workflow', async (t) => {
  const script = path.join(__dirname, '../../testScripts/lib/asyncWorkflow.js');

  const workflow = await Workflow.create();
  const logs: Array<Array<unknown>> = [];
  await workflow.inject('console.log', (...args: unknown[]) => logs.push(args));
  await workflow.run(script);
  t.deepEqual(logs, [['async']]);
});

test('setTimeout', async (t) => {
  const script = path.join(__dirname, '../../testScripts/lib/setTimeout.js');

  const workflow = await Workflow.create();
  const logs: Array<Array<unknown>> = [];
  await workflow.inject('console.log', (...args: unknown[]) => logs.push(args));
  await workflow.run(script);
  t.deepEqual(logs, [['slept']]);
});
