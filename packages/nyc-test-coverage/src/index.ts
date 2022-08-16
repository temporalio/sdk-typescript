import { InjectedSinks } from '@temporalio/worker';
import { CoverageSinks } from './sinks';
import libCoverage from 'istanbul-lib-coverage';

export class WorkflowCoverage {
  coverageMap = libCoverage.createCoverageMap();

  /**
   * Contains sinks that allow Workflows to gather coverage data.
   */
  get sinks(): InjectedSinks<CoverageSinks> {
    return {
      coverage: {
        merge: {
          fn: (_workflowInfo, testCoverage) => {
            this.coverageMap.merge(testCoverage);
          },
          callDuringReplay: false,
        },
      },
    };
  }

  /**
   * Merge this WorkflowCoverage's coverage map into the global coverage
   * map data `global.__coverage__`.
   */
  mergeIntoGlobalCoverage(): void {
    /* eslint-disable @typescript-eslint/ban-ts-comment */
    // @ts-ignore
    this.coverageMap.merge(global.__coverage__);

    const coverageMapData: libCoverage.CoverageMapData = Object.keys(this.coverageMap.data).reduce(
      (cur: libCoverage.CoverageMapData, path) => {
        const fileCoverage = this.coverageMap.data[path] as libCoverage.FileCoverage;

        cur[path] = fileCoverage.data;
        return cur;
      },
      {}
    );

    // @ts-ignore
    global.__coverage__ = coverageMapData;
  }
}
