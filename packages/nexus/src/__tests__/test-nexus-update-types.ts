/**
 * Type-level tests for {@link UpdatableWorkflowHandle.update}.
 *
 * The assertions live inside never-called `_assertion` functions: the `@ts-expect-error` comments
 * fail the build if the expected type error stops occurring, and the positive cases fail the build if
 * a legal call stops compiling. The runtime `t.pass()` just gives each case a name in the test report.
 */
import test from 'ava';
import type { UpdateDefinition } from '@temporalio/common';
import { WorkflowUpdateStage } from '@temporalio/client';
import type { TemporalOperationResult, UpdatableWorkflowHandle, WorkflowHandle } from '../workflow-helpers';

declare const handle: UpdatableWorkflowHandle<void>;
/** Handle as returned by `startWorkflow` / `signalWithStartWorkflow`: no `update`. */
declare const runHandle: WorkflowHandle<void>;

declare const noArgUpdate: UpdateDefinition<string, []>;
declare const twoArgUpdate: UpdateDefinition<string, [number, string]>;

test('update with no args requires only the stage', async (t) => {
  async function _assertion() {
    const _result: TemporalOperationResult<string> = await handle.update(noArgUpdate, { waitForStage: 'ACCEPTED' });
    const _withUpdateId: TemporalOperationResult<string> = await handle.update(noArgUpdate, {
      waitForStage: 'ACCEPTED',
      updateId: 'uid',
    });
  }
  t.pass();
});

test('update with no args rejects being passed args', async (t) => {
  async function _assertion() {
    // @ts-expect-error - noArgUpdate takes no arguments, so `args` is not accepted
    await handle.update(noArgUpdate, { waitForStage: 'ACCEPTED', args: [1] });
    // @ts-expect-error - an empty `args` tuple is still not a legal argument list to supply
    await handle.update(noArgUpdate, { waitForStage: 'ACCEPTED', args: [1, 'a'] });
  }
  t.pass();
});

test('update with args requires the matching argument tuple', async (t) => {
  async function _assertion() {
    const _result: TemporalOperationResult<string> = await handle.update(twoArgUpdate, {
      waitForStage: 'ACCEPTED',
      args: [1, 'a'],
    });
    const _withUpdateId: TemporalOperationResult<string> = await handle.update(twoArgUpdate, {
      waitForStage: 'ACCEPTED',
      args: [1, 'a'],
      updateId: 'uid',
    });
  }
  t.pass();
});

test('update with args rejects missing or mismatched args', async (t) => {
  async function _assertion() {
    // @ts-expect-error - twoArgUpdate takes arguments, so `args` is required
    await handle.update(twoArgUpdate, { waitForStage: 'ACCEPTED' });
    // @ts-expect-error - twoArgUpdate takes arguments, so `args` is required
    await handle.update(twoArgUpdate, { waitForStage: 'ACCEPTED', updateId: 'uid' });
    // @ts-expect-error - wrong argument types
    await handle.update(twoArgUpdate, { waitForStage: 'ACCEPTED', args: ['a', 1] });
    // @ts-expect-error - too few arguments
    await handle.update(twoArgUpdate, { waitForStage: 'ACCEPTED', args: [1] });
  }
  t.pass();
});

test('update requires options carrying the stage', async (t) => {
  async function _assertion() {
    // @ts-expect-error - `waitForStage` is required, so options cannot be omitted
    await handle.update(noArgUpdate);
    // @ts-expect-error - `waitForStage` is required
    await handle.update(noArgUpdate, { updateId: 'uid' });
    // @ts-expect-error - `waitForStage` is required
    await handle.update(twoArgUpdate, { args: [1, 'a'] });
  }
  t.pass();
});

test('update accepts the stage as a literal or as the enum-like constant', async (t) => {
  async function _assertion() {
    await handle.update(noArgUpdate, { waitForStage: 'ACCEPTED' });
    await handle.update(noArgUpdate, { waitForStage: WorkflowUpdateStage.ACCEPTED });
  }
  t.pass();
});

test('update rejects a stage other than ACCEPTED', async (t) => {
  async function _assertion() {
    // @ts-expect-error - only ACCEPTED is supported
    await handle.update(noArgUpdate, { waitForStage: 'COMPLETED' });
    // @ts-expect-error - only ACCEPTED is supported
    await handle.update(noArgUpdate, { waitForStage: 'ADMITTED' });
    // @ts-expect-error - only ACCEPTED is supported
    await handle.update(twoArgUpdate, { waitForStage: 'COMPLETED', args: [1, 'a'] });
  }
  t.pass();
});

test('update infers the result type from the Update definition', async (t) => {
  async function _assertion() {
    // @ts-expect-error - the Update returns string, not number
    const _wrong: TemporalOperationResult<number> = await handle.update(noArgUpdate, { waitForStage: 'ACCEPTED' });
  }
  t.pass();
});

test('update by name carries no argument type information', async (t) => {
  async function _assertion() {
    // An Update addressed by name cannot be checked against a definition, so both forms are legal.
    const _noArgs: TemporalOperationResult<number> = await handle.update<number>('someUpdate', {
      waitForStage: 'ACCEPTED',
    });
    const _withArgs: TemporalOperationResult<number> = await handle.update<number, [number]>('someUpdate', {
      waitForStage: 'ACCEPTED',
      args: [1],
    });
  }
  t.pass();
});

test('the handle returned by startWorkflow does not expose update', async (t) => {
  async function _assertion() {
    // @ts-expect-error - the Workflow run already backs the operation, so `update` is not offered
    await runHandle.update(noArgUpdate, { waitForStage: 'ACCEPTED' });
  }
  t.pass();
});
