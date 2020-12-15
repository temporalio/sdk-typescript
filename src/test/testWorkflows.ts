import path from 'path';
import test from 'ava';
import { Scheduler } from '../scheduler';
import { Workflow } from '../engine';
import { httpGet } from '../../testActivities/lib';

test('async workflow', async (t) => {
  const script = path.join(__dirname, '../../testWorkflows/lib/asyncWorkflow.js');

  const workflow = await Workflow.create();
  const logs: Array<Array<unknown>> = [];
  await workflow.inject('console.log', (...args: unknown[]) => logs.push(args));
  await workflow.run(script);
  t.deepEqual(logs, [['async']]);
});

test('setTimeout', async (t) => {
  const script = path.join(__dirname, '../../testWorkflows/lib/setTimeout.js');

  const workflow = await Workflow.create();
  const logs: Array<Array<unknown>> = [];
  await workflow.inject('console.log', (...args: unknown[]) => logs.push(args));
  await workflow.run(script);
  t.deepEqual(logs, [['slept']]);
});

test('promiseThenPromise', async (t) => {
  const script = path.join(__dirname, '../../testWorkflows/lib/promiseThenPromise.js');

  const workflow = await Workflow.create();
  const logs: Array<Array<unknown>> = [];
  await workflow.inject('console.log', (...args: unknown[]) => logs.push(args));
  await workflow.run(script);
  t.deepEqual(logs, [[2]]);
});

test('race', async (t) => {
  const script = path.join(__dirname, '../../testWorkflows/lib/race.js');

  let workflow: Workflow | undefined;
  for (let i = 0; i < 3; ++i) {
    workflow = await Workflow.create(new Scheduler(workflow === undefined ? [] : workflow.scheduler.history));
    const logs: Array<Array<unknown>> = [];
    await workflow.inject('console.log', (...args: unknown[]) => void logs.push(args));
    await workflow.run(script);
    t.deepEqual(logs, [[1], [2]]);
  }
});

test('importer', async (t) => {
  const script = path.join(__dirname, '../../testWorkflows/lib/importer.js');

  let workflow: Workflow | undefined;
  for (let i = 0; i < 3; ++i) {
    workflow = await Workflow.create(new Scheduler(workflow === undefined ? [] : workflow.scheduler.history));
    const logs: Array<Array<unknown>> = [];
    await workflow.inject('console.log', (...args: unknown[]) => void logs.push(args));
    await workflow.run(script);
    t.deepEqual(logs, [['slept']]);
  }
});

test('import ramda', async (t) => {
  const script = path.join(__dirname, '../../testWorkflows/lib/externalImporter.js');

  let workflow: Workflow | undefined;
  for (let i = 0; i < 3; ++i) {
    workflow = await Workflow.create(new Scheduler(workflow === undefined ? [] : workflow.scheduler.history));
    const logs: Array<Array<unknown>> = [];
    await workflow.inject('console.log', (...args: unknown[]) => void logs.push(args));
    await workflow.run(script);
    t.deepEqual(logs, [
      [{ a: 1, b: 2 }],
    ]);
  }
});

test('invoke activity as an async function / with options', async (t) => {
  const script = path.join(__dirname, '../../testWorkflows/lib/http.js');

  let workflow: Workflow | undefined;
  for (let i = 0; i < 3; ++i) {
    workflow = await Workflow.create(new Scheduler(workflow === undefined ? [] : workflow.scheduler.history));
    const logs: Array<Array<unknown>> = [];
    await workflow.injectActivity('httpGet', httpGet);
    await workflow.inject('console.log', (...args: unknown[]) => void logs.push(args));
    await workflow.run(script);
    t.deepEqual(logs, [
      ['<html><body>hello from https://google.com</body></html>'],
      ['<html><body>hello from http://example.com</body></html>'],
    ]);
  }
});
