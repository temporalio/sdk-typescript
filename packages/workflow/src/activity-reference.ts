import type { ActivityFunction } from '@temporalio/common';
import { InvalidActivityReferenceError } from './errors';

const activityReference = Symbol.for('__temporal_activity_reference');

function referenceError(message: string): InvalidActivityReferenceError {
  return new InvalidActivityReferenceError(
    `${message}\n` +
      `Mark the Activity import with { temporal: 'activity' }, for example:\n` +
      `  import { echo } from './my-acts' with { temporal: 'activity' };\n` +
      `Use executeActivity or executeLocalActivity to execute the reference; do not call it directly.\n` +
      `By default, this error fails the Workflow Task, not the Workflow Execution. ` +
      `Deploy corrected workflow code to resume execution.`
  );
}

/** @internal Used by the workflow bundler. Does not load the Activity implementation. */
export function createActivityReference(name: string): ActivityFunction {
  return Object.defineProperty(
    function activityReferenceStub(): never {
      throw referenceError(`Activity reference '${name}' cannot be called directly.`);
    },
    activityReference,
    { value: name }
  );
}

/** @internal */
export function activityReferenceName(value: unknown, api: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'function' && Object.hasOwn(value, activityReference)) {
    const name: unknown = (value as unknown as Record<symbol, unknown>)[activityReference];
    if (typeof name === 'string' && name.length > 0) return name;
  }
  throw referenceError(
    `${api} expected an Activity reference or a nonempty Activity name. ` +
      `The supplied value was not a transformed Activity reference. The Activity implementation was not invoked.`
  );
}
