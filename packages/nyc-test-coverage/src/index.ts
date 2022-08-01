import {
  InjectedSinks,
} from '@temporalio/worker';
import { CoverageSinks } from './sinks';
import libCoverage from 'istanbul-lib-coverage';

export const coverageMap = libCoverage.createCoverageMap();

export const sinks: InjectedSinks<CoverageSinks> = {
  coverage: {
    merge: {
      fn(_workflowInfo, testCoverage) {
        coverageMap.merge(testCoverage as libCoverage.CoverageMap);
      },
      callDuringReplay: false,
    },
  },
};

export function mergeWorkflowCoverage() {
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