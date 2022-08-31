import { InjectedSinks, BundleOptions, WorkerOptions } from '@temporalio/worker';
import { CoverageSinks } from './sinks';
import libCoverage from 'istanbul-lib-coverage';

// Pull `webpack.Configuration` type without needing to import Webpack
type WebpackConfigType = ReturnType<NonNullable<BundleOptions['webpackConfigHook']>>;

export class WorkflowCoverage {
  coverageMap = libCoverage.createCoverageMap();

  /**
   * Add all necessary coverage-specific logic to Worker config:
   * interceptors, sinks, and Webpack config hook.
   */

  augmentWorkerOptions(workerOptions: WorkerOptions): WorkerOptions {
    if (!workerOptions.workflowsPath) {
      throw new TypeError('Cannot automatically instrument coverage without specifying `workflowsPath`');
    }

    const workflowsPath = workerOptions.workflowsPath;

    // Interceptors
    workerOptions.interceptors = workerOptions.interceptors || {};
    workerOptions.interceptors.workflowModules = workerOptions.interceptors.workflowModules || [];
    workerOptions.interceptors.workflowModules.push(this.interceptorModule);

    // Sinks
    workerOptions.sinks = workerOptions.sinks || {};
    Object.assign(workerOptions.sinks, this.sinks);

    // Webpack config hook
    workerOptions.bundlerOptions = workerOptions.bundlerOptions || {};
    const existingWebpackConfigHook = workerOptions.bundlerOptions.webpackConfigHook;

    workerOptions.bundlerOptions.webpackConfigHook = (config: WebpackConfigType) => {
      config = this.webpackConfigHook(workflowsPath, config);

      if (existingWebpackConfigHook != null) {
        return existingWebpackConfigHook(config);
      }

      return config;
    }

    return workerOptions;
  }

  /**
   * Interceptor to inject into `WorkerOptions.interceptors.workflowModules`
   */
  public get interceptorModule(): string {
    return require.resolve('./interceptors');
  }

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
   * Modify the given Worker config to auto instrument Workflow
   * code using istanbul-instrumenter-loader
   */

  webpackConfigHook(workflowsPath: string, config: WebpackConfigHookType): WebpackConfigHookType {
    const rules = config?.module?.rules || [];

    rules.push({
      use: {
        loader: require.resolve('istanbul-instrumenter-loader'),
        options: { esModules: true }
      },
      enforce: 'post',
      include: workflowsPath,
    });

    return config;
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
