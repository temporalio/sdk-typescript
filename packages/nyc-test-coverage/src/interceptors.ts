import { proxySinks, WorkflowInterceptors } from '@temporalio/workflow';
import { CoverageSinks } from './sinks';

const { coverage } = proxySinks<CoverageSinks>();

// Export the interceptors
export const interceptors = (): WorkflowInterceptors => ({
  internals: [
    {
      concludeActivation(input, next) {
        /* eslint-disable @typescript-eslint/ban-ts-comment */
        // @ts-ignore
        const globalCoverage = global.__coverage__;
        coverage.merge(JSON.parse(JSON.stringify(globalCoverage)));
        clearCoverage(globalCoverage);

        return next(input);
      },
    },
  ],
  inbound: [],
  outbound: [],
});

function clearCoverage(coverage: any): void {
  for (const path of Object.keys(coverage)) {
    for (const index of Object.keys(coverage[path].s)) {
      coverage[path].s[index] = 0;
    }
  }
}
