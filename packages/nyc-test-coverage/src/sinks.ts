import { Sinks } from '@temporalio/workflow';

export interface ICoverageSinks extends Sinks {
  coverage: {
    merge(coverageMap: any): unknown;
  };
}
