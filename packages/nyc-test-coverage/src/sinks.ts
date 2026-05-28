import type { CoverageMapData } from 'istanbul-lib-coverage';
import type { Sinks } from '@temporalio/workflow';

export interface CoverageSinks extends Sinks {
  coverage: {
    merge(coverageMap: CoverageMapData): void;
  };
}
