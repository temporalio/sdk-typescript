import {
  proxySinks,
  SignalInput,
  WorkflowExecuteInput,
  WorkflowInterceptorsFactory,
  WorkflowInboundCallsInterceptor,
  QueryInput
} from '@temporalio/workflow';
import { CoverageSinks } from './sinks';

const { coverage } = proxySinks<CoverageSinks>();

class CoverageInterceptor implements WorkflowInboundCallsInterceptor {
  public async handleQuery(input: QueryInput, next: any): Promise<unknown> {
    const ret = await next(input);

    // @ts-ignore
    const globalCoverage = global.__coverage__;
    coverage.merge(JSON.parse(JSON.stringify(globalCoverage)));
    clearCoverage(globalCoverage);

    return ret;
  }

  public async handleSignal(input: SignalInput, next: any): Promise<void> {
    const ret = await next(input);

    // @ts-ignore
    const globalCoverage = global.__coverage__;
    coverage.merge(JSON.parse(JSON.stringify(globalCoverage)));
    clearCoverage(globalCoverage);

    return ret;
  }

  public async execute(input: WorkflowExecuteInput, next: any): Promise<unknown> {
    const ret = await next(input);

    // @ts-ignore
    const globalCoverage = global.__coverage__;
    coverage.merge(JSON.parse(JSON.stringify(globalCoverage)));
    clearCoverage(globalCoverage);

    return ret;
  }
}

// Export the interceptors
export const interceptors: WorkflowInterceptorsFactory = () => ({
  inbound: [new CoverageInterceptor()],
});

function clearCoverage(coverage: any): void {
  for (const path of Object.keys(coverage)) {
    for (const index of Object.keys(coverage[path].s)) {
      coverage[path].s[index] = 0;
    }
  }
}