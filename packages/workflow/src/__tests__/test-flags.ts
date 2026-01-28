import test from 'ava';
import { SdkFlags, type SdkFlag } from '../flags';
import type { WorkflowInfo } from '../index';

type Conditions = SdkFlag['alternativeConditions'];
function composeConditions(conditions: Conditions): NonNullable<Conditions>[number] {
  return (ctx) => {
    for (const cond of conditions ?? []) {
      if (cond(ctx)) {
        return true;
      }
    }
    return false;
  };
}

test('OpenTelemetryInterceptorsTracesInboundSignals enabled by version', (t) => {
  const cases = [
    { version: undefined, expected: false },
    { version: '1.0.0', expected: false },
    { version: '1.11.3', expected: false },
    { version: '1.11.5', expected: true },
    { version: '1.11.6', expected: true },
    { version: '1.12.0', expected: true },
    { version: '1.13.1', expected: true },
    { version: '1.13.2', expected: true },
    { version: '1.14.0', expected: true },
  ];
  for (const { version, expected } of cases) {
    const actual = composeConditions(SdkFlags.OpenTelemetryInterceptorsTracesInboundSignals.alternativeConditions)({
      info: {} as WorkflowInfo,
      sdkVersion: version,
    });
    t.is(
      actual,
      expected,
      `Expected OpenTelemetryInterceptorsTracesInboundSignals on ${version} to evaluate as ${expected}`
    );
  }
});

test('OpenTelemetryInterceporsAvoidsExtraYields enabled by version', (t) => {
  const cases = [
    // If there isn't any SDK version available we enable this flag as these yields were present since the initial version of the OTEL interceptors
    { version: undefined, expected: false },
    { version: '0.1.0', expected: false },
    { version: '1.0.0', expected: false },
    { version: '1.9.0-rc.0', expected: false },
    { version: '1.11.3', expected: false },
    { version: '1.13.1', expected: false },
    { version: '1.13.2', expected: true },
    { version: '1.14.0', expected: true },
    { version: '2.0.0', expected: true },
  ];
  for (const { version, expected } of cases) {
    const actual = composeConditions(SdkFlags.OpenTelemetryInterceporsAvoidsExtraYields.alternativeConditions)({
      info: {} as WorkflowInfo,
      sdkVersion: version,
    });
    t.is(
      actual,
      expected,
      `Expected OpenTelemetryInterceporsAvoidsExtraYields on ${version} to evaluate as ${expected}`
    );
  }
});

test('OpenTelemetryInterceptorsTracesLocalActivities enabled by version', (t) => {
  const cases = [
    { version: undefined, expected: false },
    { version: '1.0.0', expected: false },
    { version: '1.11.3', expected: false },
    { version: '1.11.5', expected: false },
    { version: '1.11.6', expected: true },
    { version: '1.12.0', expected: true },
    { version: '1.13.1', expected: true },
    { version: '1.13.2', expected: true },
    { version: '1.14.0', expected: true },
  ];
  for (const { version, expected } of cases) {
    const actual = composeConditions(SdkFlags.OpenTelemetryInterceptorsTracesLocalActivities.alternativeConditions)({
      info: {} as WorkflowInfo,
      sdkVersion: version,
    });
    t.is(
      actual,
      expected,
      `Expected OpenTelemetryInterceptorsTracesLocalActivities on ${version} to evaluate as ${expected}`
    );
  }
});
