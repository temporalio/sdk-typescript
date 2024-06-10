import { getActivator } from '@temporalio/workflow/lib/global-attributes';
import { SdkFlag } from '@temporalio/workflow/lib/flags';

const defaultValueOverrides = new Map<number, boolean>();

let mockInstalled = false;

function maybeInstallMock() {
  if (mockInstalled) return;
  const activator = getActivator();
  const originalHasFlag = activator.hasFlag.bind(activator);
  activator.hasFlag = (flag) => {
    const overridenDefaultValue = defaultValueOverrides.get(flag.id);
    if (overridenDefaultValue !== undefined) {
      flag = { id: flag.id, default: overridenDefaultValue };
    }
    return originalHasFlag(flag);
  };
  mockInstalled = true;
}
export function overrideSdkInternalFlag(flag: SdkFlag, defaultValue: boolean): void {
  maybeInstallMock();
  defaultValueOverrides.set(flag.id, defaultValue);
}
