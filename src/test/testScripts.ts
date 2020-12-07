import path from 'path';
import test from 'ava';
import { Workflow, Timeline } from '../engine';

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

test('promiseThenPromise', async (t) => {
  const script = path.join(__dirname, '../../testScripts/lib/promiseThenPromise.js');

  const workflow = await Workflow.create();
  const logs: Array<Array<unknown>> = [];
  await workflow.inject('console.log', (...args: unknown[]) => logs.push(args));
  await workflow.run(script);
  t.deepEqual(logs, [[2]]);
});

test.only('race', async (t) => {
  const script = path.join(__dirname, '../../testScripts/lib/race.js');

  let workflow: Workflow | undefined;
  for (let i = 0; i < 3; ++i) {
    workflow = await Workflow.create(new Timeline(workflow === undefined ? [] : workflow.timeline.history));
    const logs: Array<Array<unknown>> = [];
    await workflow.inject('console.log', (...args: unknown[]) => void logs.push(args));
    await workflow.run(script);
    t.deepEqual(logs, [[1], [2]]);
  }
});
