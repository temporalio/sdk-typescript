import { InjectedSinks } from '@temporalio/worker';
import { ICoverageSinks } from './sinks';
import libCoverage from 'istanbul-lib-coverage';

export class CoverageSinks {
  coverageMap = libCoverage.createCoverageMap();
  sinksInternal: InjectedSinks<ICoverageSinks> = {
    coverage: {
      merge: {
        fn: (_workflowInfo: any, testCoverage: libCoverage.CoverageMap) => {
          this.coverageMap.merge(testCoverage);
        },
        callDuringReplay: false,
      },
    },
  };

  get sinks(): InjectedSinks<ICoverageSinks> {
    return this.sinksInternal;
  }

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
