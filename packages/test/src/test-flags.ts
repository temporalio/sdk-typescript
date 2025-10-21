import test from 'ava';
import { SdkFlags } from '@temporalio/workflow/lib/flags';
import type { WorkflowInfo } from '@temporalio/workflow';

test('OpenTelemetryHandleSignalInterceptorInsertYield enabled by version', (t) => {
  const cases = [
    { version: '1.0.0', expected: false },
    { version: '1.11.3', expected: false },
    { version: '1.11.5', expected: true },
    { version: '1.11.6', expected: true },
    { version: '1.12.0', expected: true },
    { version: '1.13.1', expected: true },
    { version: '1.13.2', expected: false },
    { version: '1.14.0', expected: false },
  ];
  for (const { version, expected } of cases) {
    const actual = SdkFlags.OpenTelemetryHandleSignalInterceptorInsertYield.alternativeConditions![0]!({
      info: {} as WorkflowInfo,
      sdkVersion: version,
    });
    t.is(
      actual,
      expected,
      `Expected OpenTelemetryHandleSignalInterceptorInsertYield on ${version} to evaluate as ${expected}`
    );
  }
});
