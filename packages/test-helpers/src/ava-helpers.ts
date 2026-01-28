import ava, { TestFn } from 'ava';
import { inWorkflowContext } from '@temporalio/workflow';
import { RUN_TIME_SKIPPING_TESTS } from './flags';

function noopTest(): void {
  // eslint: this function body is empty and it's okay.
}

noopTest.serial = () => undefined;
noopTest.macro = () => undefined;
noopTest.before = () => undefined;
noopTest.after = () => undefined;
(noopTest.after as any).always = () => undefined;
noopTest.beforeEach = () => undefined;
noopTest.afterEach = () => undefined;
noopTest.skip = () => noopTest;

/**
 * (Mostly complete) helper to allow mixing workflow and non-workflow code in the same test file.
 */
export const test: TestFn<unknown> = inWorkflowContext() ? (noopTest as any) : ava;

export const testTimeSkipping = RUN_TIME_SKIPPING_TESTS ? test : noopTest;

export { noopTest };
