import path from 'path';
import test from 'ava';
import { Scheduler } from '../../lib/scheduler';
import { Workflow } from '../../lib/engine';
import * as activities from '../../test-activities/lib';

async function run(script: string, callback: (logs: unknown[]) => void) {
  let workflow: Workflow | undefined;
  for (let i = 0; i < 3; ++i) {
    workflow = await Workflow.create('TODO', new Scheduler(workflow === undefined ? [] : workflow.scheduler.history));
    const logs: Array<Array<unknown>> = [];
    await workflow.registerActivities({ '@activities': activities });
    await workflow.inject('console.log', (...args: unknown[]) => void logs.push(args));
    await workflow.run(script);
    callback(logs);
  }
}

test('random', async (t) => {
  const script = path.join(__dirname, '../../test-workflows/lib/random.js');
  await run(script, (logs) => t.deepEqual(logs, [[0.22569616744294763]]));
});

test('async workflow', async (t) => {
  const script = path.join(__dirname, '../../test-workflows/lib/asyncWorkflow.js');
  await run(script, (logs) => t.deepEqual(logs, [['async']]));
});

test('deferredResolve', async (t) => {
  const script = path.join(__dirname, '../../test-workflows/lib/deferredResolve.js');
  await run(script, (logs) => t.deepEqual(logs, [[1], [2]]));
});

test('setTimeout', async (t) => {
  const script = path.join(__dirname, '../../test-workflows/lib/setTimeout.js');
  await run(script, (logs) => t.deepEqual(logs, [['slept']]));
});

test('promiseThenPromise', async (t) => {
  const script = path.join(__dirname, '../../test-workflows/lib/promiseThenPromise.js');
  await run(script, (logs) => t.deepEqual(logs, [[2]]));
});

test('rejectPromise', async (t) => {
  const script = path.join(__dirname, '../../test-workflows/lib/rejectPromise.js');
  await run(script, (logs) => t.deepEqual(logs, [[true], [true]]));
});

test('promiseAll', async (t) => {
  const script = path.join(__dirname, '../../test-workflows/lib/promiseAll.js');
  await run(script, (logs) => t.deepEqual(logs, [
    [1, 2, 3],
    [1, 2, 3],
    [1, 2, 3],
    ['wow'],
  ]));
});

test('promiseRace', async (t) => {
  const script = path.join(__dirname, '../../test-workflows/lib/promiseRace.js');
  await run(script, (logs) => t.deepEqual(logs, [
    [1],
    [1],
    [1],
    [1],
    [20],
    ['wow'],
  ]));
});

test('race', async (t) => {
  const script = path.join(__dirname, '../../test-workflows/lib/race.js');
  await run(script, (logs) => t.deepEqual(logs, [[1], [2], [3]]));
});

test('importer', async (t) => {
  const script = path.join(__dirname, '../../test-workflows/lib/importer.js');
  await run(script, (logs) => t.deepEqual(logs, [['slept']]));
});

test('import ramda', async (t) => {
  const script = path.join(__dirname, '../../test-workflows/lib/externalImporter.js');
  await run(script, (logs) => t.deepEqual(logs, [[{ a: 1, b: 2 }]]));
});

test('invoke activity as an async function / with options', async (t) => {
  const script = path.join(__dirname, '../../test-workflows/lib/http.js');
  await run(script, (logs) => t.deepEqual(logs, [
    ['<html><body>hello from https://google.com</body></html>'],
    ['<html><body>hello from http://example.com</body></html>'],
  ]));
});
