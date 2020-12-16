import path from 'path';
import test from 'ava';
import { Scheduler } from '../scheduler';
import { Workflow } from '../engine';
import { httpGet } from '../../testActivities/lib';

async function run(script: string, callback: (logs: unknown[]) => void) {
  let workflow: Workflow | undefined;
  for (let i = 0; i < 3; ++i) {
    workflow = await Workflow.create(new Scheduler(workflow === undefined ? [] : workflow.scheduler.history));
    const logs: Array<Array<unknown>> = [];
    await workflow.injectActivity('httpGet', httpGet);
    await workflow.inject('console.log', (...args: unknown[]) => void logs.push(args));
    await workflow.run(script);
    callback(logs);
  }
}

test('async workflow', async (t) => {
  const script = path.join(__dirname, '../../testWorkflows/lib/asyncWorkflow.js');
  await run(script, (logs) => t.deepEqual(logs, [['async']]));
});

test('deferredResolve', async (t) => {
  const script = path.join(__dirname, '../../testWorkflows/lib/deferredResolve.js');
  await run(script, (logs) => t.deepEqual(logs, [[1], [2]]));
});

test('setTimeout', async (t) => {
  const script = path.join(__dirname, '../../testWorkflows/lib/setTimeout.js');
  await run(script, (logs) => t.deepEqual(logs, [['slept']]));
});

test('promiseThenPromise', async (t) => {
  const script = path.join(__dirname, '../../testWorkflows/lib/promiseThenPromise.js');
  await run(script, (logs) => t.deepEqual(logs, [[2]]));
});

test('race', async (t) => {
  const script = path.join(__dirname, '../../testWorkflows/lib/race.js');
  await run(script, (logs) => t.deepEqual(logs, [[1], [2]]));
});

test('importer', async (t) => {
  const script = path.join(__dirname, '../../testWorkflows/lib/importer.js');
  await run(script, (logs) => t.deepEqual(logs, [['slept']]));
});

test('import ramda', async (t) => {
  const script = path.join(__dirname, '../../testWorkflows/lib/externalImporter.js');
  await run(script, (logs) => t.deepEqual(logs, [[{ a: 1, b: 2 }]]));
});

test('invoke activity as an async function / with options', async (t) => {
  const script = path.join(__dirname, '../../testWorkflows/lib/http.js');
  await run(script, (logs) => t.deepEqual(logs, [
    ['<html><body>hello from https://google.com</body></html>'],
    ['<html><body>hello from http://example.com</body></html>'],
  ]));
});
