import { proxySinks, WorkflowInterceptors } from '@temporalio/workflow';
import { ICoverageSinks } from './sinks';
import libCoverage from 'istanbul-lib-coverage';

const { coverage } = proxySinks<ICoverageSinks>();

// Export the interceptors
export const interceptors = (): WorkflowInterceptors => ({
  internals: [
    {
      concludeActivation(input, next) {
        /* eslint-disable @typescript-eslint/ban-ts-comment */
        // @ts-ignore
        const globalCoverage: libCoverage.CoverageMapData = global.__coverage__;

        coverage.merge(JSON.parse(JSON.stringify(globalCoverage)));
        clearCoverage(globalCoverage);

        return next(input);
      },
    },
  ],
});

function clearCoverage(coverage: libCoverage.CoverageMapData): void {
  for (const path of Object.keys(coverage)) {
    for (const index of Object.keys(coverage[path].s)) {
      coverage[path].s[index] = 0;
    }
  }
}
