import { getActivator } from '@temporalio/workflow/lib/global-attributes';
import type { SdkFlag } from '@temporalio/workflow/lib/flags';

const defaultValueOverrides = new Map<number, boolean>();

let mockInstalled = false;

function maybeInstallMock() {
  if (mockInstalled) return;
  const activator = getActivator();
  const originalHasFlag = activator.hasFlag.bind(activator);
  activator.hasFlag = (flag) => {
    const overridenDefaultValue = defaultValueOverrides.get(flag.id);
    if (overridenDefaultValue !== undefined) {
      flag = { id: flag.id, default: overridenDefaultValue, alternativeConditions: undefined };
    }
    return originalHasFlag(flag);
  };
  mockInstalled = true;
}

// Override the default value of an SDK flag. That is, assuming a workflow execution is not in
// replay mode and that `f` has not already been recorded, then `hasFlag(f)` will return
// `defaultValue`, and record the flag to history if `defaultValue` is `true`.
export function overrideSdkInternalFlag(flag: SdkFlag, defaultValue: boolean): void {
  maybeInstallMock();
  defaultValueOverrides.set(flag.id, defaultValue);
}
