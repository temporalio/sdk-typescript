import path from 'node:path';
import * as libCoverage from 'istanbul-lib-coverage';
import { InjectedSinks, BundleOptions, WorkerOptions } from '@temporalio/worker';
import { CoverageSinks } from './sinks';

// Pull `webpack.Configuration` type without needing to import Webpack
type WebpackConfigType = ReturnType<NonNullable<BundleOptions['webpackConfigHook']>>;

export class WorkflowCoverage {
  coverageMapsData: libCoverage.CoverageMapData[] = [];

  // Check if running through nyc or some other Istanbul-based tool.
  // If not, any `workflowCoverage()` tools are a no-op.
  private hasCoverageGlobal() {
    return '__coverage__' in global;
  }

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

    if (!this.hasCoverageGlobal()) {
      return workerOptions;
    }

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
          config = this.addInstrumenterRule(config);

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
  augmentBundleOptions(
    bundleOptions: BundleOptions & { workflowsPath: NonNullable<WorkerOptions['workflowsPath']> }
  ): BundleOptions {
    if (!bundleOptions.workflowsPath) {
      throw new TypeError('Cannot automatically instrument coverage without specifying `workflowsPath`');
    }

    if (!this.hasCoverageGlobal()) {
      return bundleOptions;
    }

    return {
      ...bundleOptions,
      workflowInterceptorModules: [...(bundleOptions.workflowInterceptorModules || []), this.interceptorModule],
      webpackConfigHook: (config: WebpackConfigType) => {
        config = this.addInstrumenterRule(config);

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
      throw new TypeError(
        'Cannot call `augmentWorkerOptionsWithBundle()` unless you specify a `workflowBundle`. Perhaps you meant to use `augmentBundleOptions()` instead?'
      );
    }

    if (!this.hasCoverageGlobal()) {
      return workerOptions;
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
            this.coverageMapsData.push(testCoverage);
          },
          callDuringReplay: false,
        },
      },
    };
  }

  /**
   * Modify the given Worker config to auto instrument Workflows
   */
  addInstrumenterRule(config: WebpackConfigType): WebpackConfigType {
    if (!this.hasCoverageGlobal()) {
      return config;
    }

    const rules = config?.module?.rules || [];

    if (Object.keys(require.cache).some((file) => file.includes('ts-node/register'))) {
      // ts-node is currently loaded
      // ts-node and SWC doesn't translate TypeScript code the same way, which will cause
      // line number mismatches in generated coverage reports.
      const tsLoaderRule = {
        test: /\.ts$/,
        loader: require.resolve('ts-loader'),
        exclude: /node_modules/,
      };

      const swcRuleIndex = rules.findIndex((rule) => {
        const loader = (rule as any).use?.loader;
        return loader && loader.indexOf('swc-loader') >= 0;
      });

      rules[swcRuleIndex] = tsLoaderRule;
    }

    rules.push({
      use: {
        loader: require.resolve('./loader'),
      },
      enforce: 'post' as const,
      test: /\.[tj]s$/,
      exclude: [
        /[/\\]node_modules[/\\]/,
        path.dirname(require.resolve('@temporalio/common')),
        path.dirname(require.resolve('@temporalio/workflow')),
        path.dirname(require.resolve('@temporalio/nyc-test-coverage')),
        path.dirname(require.resolve('@temporalio/nexus')),
        path.dirname(require.resolve('nexus-rpc')),
      ],
    });

    return {
      ...config,
      module: {
        ...config?.module,
        rules,
      },
    };
  }

  /**
   * Merge this WorkflowCoverage's coverage map into the global coverage
   * map data `global.__coverage__`.
   */
  mergeIntoGlobalCoverage(): void {
    if (!this.hasCoverageGlobal()) {
      return;
    }

    const coverageMap = libCoverage.createCoverageMap();
    this.coverageMapsData.unshift(global.__coverage__);
    for (const data of this.coverageMapsData) coverageMap.merge(data);
    this.coverageMapsData = [];

    global.__coverage__ = coverageMap.data;
  }
}
