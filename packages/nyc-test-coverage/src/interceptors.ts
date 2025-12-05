import type { CoverageMapData } from 'istanbul-lib-coverage';
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
        const globalCoverage: CoverageMapData = global.__coverage__;
        if (globalCoverage) {
          // Send coverage data through the sink to be merged into the _real_ global coverage map
          // Make a deep copy first, otherwise clearCoverage may wipe out the data
          // before it actually get processed by the sink
          coverage.merge(JSON.parse(JSON.stringify(globalCoverage)));
          clearCoverage(globalCoverage);
        }

        return next(input);
      },
    },
  ],
});

function clearCoverage(coverage: CoverageMapData): void {
  for (const path of Object.keys(coverage)) {
    if (coverage[path]) {
      for (const index of Object.keys(coverage[path].s)) {
        coverage[path].s[index] = 0;
      }
    }
  }
}
