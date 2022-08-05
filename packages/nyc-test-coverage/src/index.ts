import { InjectedSinks } from '@temporalio/worker';
import { CoverageSinks } from './sinks';
import libCoverage from 'istanbul-lib-coverage';

export function createCoverageSinks(): { sinks: InjectedSinks<CoverageSinks>; coverageMap: libCoverage.CoverageMap } {
  const coverageMap = libCoverage.createCoverageMap();

  return {
    coverageMap,
    sinks: {
      coverage: {
        merge: {
          fn(_workflowInfo: any, testCoverage: libCoverage.CoverageMap) {
            coverageMap.merge(testCoverage);
          },
          callDuringReplay: false,
        },
      },
    },
  };
}

export function mergeWorkflowCoverage(coverageMap: libCoverage.CoverageMap): void {
  /* eslint-disable @typescript-eslint/ban-ts-comment */
  // @ts-ignore
  coverageMap.merge(global.__coverage__);
  // @ts-ignore
  global.__coverage__ = Object.keys(coverageMap.data).reduce((cur, path) => {
    const fileCoverage = coverageMap.data[path];
    // @ts-ignore
    cur[path] = fileCoverage.data;
    return cur;
  }, {});
}
