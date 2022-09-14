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
  augmentWorkerOptions(
    workerOptions: WorkerOptions & { workflowsPath: NonNullable<WorkerOptions['workflowsPath']> }
  ): WorkerOptions {
    if (!workerOptions.workflowsPath) {
      throw new TypeError('Cannot automatically instrument coverage without specifying `workflowsPath`');
    }

    const workflowsPath = workerOptions.workflowsPath;

    return {
      ...workerOptions,
      interceptors: {
        ...workerOptions.interceptors,
        workflowModules: [...(workerOptions?.interceptors?.workflowModules || []), this.interceptorModule],
      },
      sinks: {
        ...workerOptions.sinks,
        ...this.sinks,
      },
      bundlerOptions: {
        ...workerOptions.bundlerOptions,
        webpackConfigHook: (config: WebpackConfigType) => {
          config = this.addInstrumenterRule(workflowsPath, config);

          const existingWebpackConfigHook = workerOptions?.bundlerOptions?.webpackConfigHook;
          if (existingWebpackConfigHook !== undefined) {
            return existingWebpackConfigHook(config);
          }

          return config;
        },
      },
    };
  }

  /**
   * Add all necessary coverage-specific logic to bundle config:
   * interceptors and Webpack config hook.
   * The end user is still responsible for adding sinks to the worker options!
   */
  augmentBundleOptions(bundleOptions: BundleOptions & { workflowsPath: NonNullable<WorkerOptions['workflowsPath']> }): BundleOptions {
    if (!bundleOptions.workflowsPath) {
      throw new TypeError('Cannot automatically instrument coverage without specifying `workflowsPath`');
    }
    const workflowsPath = bundleOptions.workflowsPath;
    return {
      ...bundleOptions,
      workflowInterceptorModules: [...(bundleOptions.workflowInterceptorModules || []), this.interceptorModule],
      webpackConfigHook: (config: WebpackConfigType) => {
        config = this.addInstrumenterRule(workflowsPath, config);

        const existingWebpackConfigHook = bundleOptions.webpackConfigHook;
        if (existingWebpackConfigHook !== undefined) {
          return existingWebpackConfigHook(config);
        }

        return config;
      },
    };
  }

  /**
   * Add sinks to Worker options. Use this method if you are passing a pre-built
   * bundle that was built with `augmentBundleOptions()`.
   */
   augmentWorkerOptionsWithBundle(
    workerOptions: WorkerOptions & { workflowBundle: NonNullable<WorkerOptions['workflowBundle']> }
  ): WorkerOptions {
    if (!workerOptions.workflowBundle) {
      throw new TypeError('Cannot call `augmentWorkerOptionsWithBundle()` unless you specify a `workflowBundle`. Perhaps you meant to use `augmentBundleOptions()` instead?');
    }

    return {
      ...workerOptions,
      sinks: {
        ...workerOptions.sinks,
        ...this.sinks,
      },
    };
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
  addInstrumenterRule(workflowsPath: string, config: WebpackConfigType): WebpackConfigType {
    const newRule = {
      use: {
        loader: require.resolve('istanbul-instrumenter-loader'),
        options: { esModules: true },
      },
      enforce: 'post' as const,
      include: workflowsPath,
    };

    return {
      ...config,
      module: {
        ...config?.module,
        rules: [...(config?.module?.rules || []), newRule],
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
