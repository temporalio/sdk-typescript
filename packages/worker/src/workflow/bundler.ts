import * as realFS from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import util from 'node:util';
import * as unionfs from 'unionfs';
import * as memfs from 'memfs';
import { Configuration, webpack } from 'webpack';
import { DefaultLogger, Logger, hasColorSupport } from '../logger';
import { toMB } from '../utils';

export const defaultWorkflowInterceptorModules = [require.resolve('../workflow-log-interceptor')];

export const allowedBuiltinModules = ['assert', 'url', 'util'];
export const disallowedBuiltinModules = builtinModules.filter((module) => !allowedBuiltinModules.includes(module));
export const disallowedModules = [
  ...disallowedBuiltinModules,
  '@temporalio/activity',
  '@temporalio/client',
  '@temporalio/worker',
  '@temporalio/common/lib/internal-non-workflow',
  '@temporalio/interceptors-opentelemetry/lib/client',
  '@temporalio/interceptors-opentelemetry/lib/worker',
  '@temporalio/testing',
  '@temporalio/core-bridge',
];

export function moduleMatches(userModule: string, modules: string[]): boolean {
  return modules.some((module) => userModule === module || userModule.startsWith(`${module}/`));
}

export interface WorkflowBundleWithSourceMap {
  /**
   * Source maps are generated inline - this is no longer used
   * @deprecated
   */
  sourceMap: string;
  code: string;
}

/**
 * Builds a V8 Isolate by bundling provided Workflows using webpack.
 *
 * @param workflowsPath all Workflows found in path will be put in the bundle
 * @param workflowInterceptorModules list of interceptor modules to register on Workflow creation
 */
export class WorkflowCodeBundler {
  private foundProblematicModules = new Set<string>();

  public readonly logger: Logger;
  public readonly workflowsPath: string;
  public readonly workflowInterceptorModules: string[];
  protected readonly payloadConverterPath?: string;
  protected readonly failureConverterPath?: string;
  protected readonly preloadedModules: string[];
  protected readonly ignoreModules: string[];
  protected readonly webpackConfigHook: (config: Configuration) => Configuration;

  constructor({
    logger,
    workflowsPath,
    payloadConverterPath,
    failureConverterPath,
    workflowInterceptorModules,
    preloadedModules,
    ignoreModules,
    webpackConfigHook,
  }: BundleOptions) {
    this.logger = logger ?? new DefaultLogger('INFO');
    this.workflowsPath = workflowsPath;
    this.payloadConverterPath = payloadConverterPath;
    this.failureConverterPath = failureConverterPath;
    this.workflowInterceptorModules = workflowInterceptorModules ?? [];
    this.preloadedModules = preloadedModules ?? [];
    this.ignoreModules = ignoreModules ?? [];
    this.webpackConfigHook = webpackConfigHook ?? ((config) => config);
  }

  /**
   * @return a {@link WorkflowBundle} containing bundled code, including inlined source map
   */
  public async createBundle(): Promise<WorkflowBundleWithSourceMap> {
    const vol = new memfs.Volume();
    const ufs = new unionfs.Union();

    /**
     * readdir and exclude sourcemaps and d.ts files
     */
    function readdir(...args: Parameters<typeof realFS.readdir>) {
      // Help TS a bit because readdir has multiple signatures
      const callback: (err: NodeJS.ErrnoException | null, files: string[]) => void = args.pop() as any;
      const newArgs: Parameters<typeof realFS.readdir> = [
        ...args,
        (err: Error | null, files: string[]) => {
          if (err !== null) {
            callback(err, []);
            return;
          }
          callback(
            null,
            files.filter((f) => /\.[jt]s$/.test(path.extname(f)) && !f.endsWith('.d.ts'))
          );
        },
      ] as any;
      return realFS.readdir(...newArgs);
    }

    // Cast because the type definitions are inaccurate
    const memoryFs = memfs.createFsFromVolume(vol);
    ufs.use(memoryFs as any).use({ ...realFS, readdir: readdir as any });
    const distDir = '/dist';
    const entrypointPath = this.makeEntrypointPath(ufs, this.workflowsPath);

    this.genEntrypoint(vol, entrypointPath);
    const bundleFilePath = await this.bundle(ufs, memoryFs, entrypointPath, distDir);
    let code = memoryFs.readFileSync(bundleFilePath, 'utf8') as string;
    // Replace webpack's module cache with an object injected by the runtime.
    // This is the key to reusing a single v8 context.
    code = code.replace(
      'var __webpack_module_cache__ = {}',
      'var __webpack_module_cache__ = globalThis.__webpack_module_cache__'
    );

    this.logger.info('Workflow bundle created', { size: `${toMB(code.length)}MB` });

    // Cast because the type definitions are inaccurate
    return {
      sourceMap: 'deprecated: this is no longer in use\n',
      code,
    };
  }

  protected makeEntrypointPath(fs: typeof unionfs.ufs, workflowsPath: string): string {
    const stat = fs.statSync(workflowsPath);
    if (stat.isFile()) {
      // workflowsPath is a file; make the entrypoint a sibling of that file
      const { root, dir, name } = path.parse(workflowsPath);
      return path.format({ root, dir, base: `${name}-autogenerated-entrypoint.cjs` });
    } else {
      // workflowsPath is a directory; make the entrypoint a sibling of that directory
      const { root, dir, base } = path.parse(workflowsPath);
      return path.format({ root, dir, base: `${base}-autogenerated-entrypoint.cjs` });
    }
  }

  /**
   * Creates the main entrypoint for the generated webpack library.
   *
   * Exports all detected Workflow implementations and some workflow libraries to be used by the Worker.
   */
  protected genEntrypoint(vol: typeof memfs.vol, target: string): void {
    const interceptorImports = [...new Set(this.workflowInterceptorModules)]
      .map((v) => `require(/* webpackMode: "eager" */ ${JSON.stringify(v)})`)
      .join(', \n');

    const preloadedModulesImports = [...new Set(this.preloadedModules)]
      .map((v) => `require(/* webpackMode: "eager" */ ${JSON.stringify(v)})`)
      .join(';\n');

    const code = `
      const api = require('@temporalio/workflow/lib/worker-interface.js');
      exports.api = api;

      const { overrideGlobals } = require('@temporalio/workflow/lib/global-overrides.js');
      overrideGlobals();

      ${preloadedModulesImports}

      exports.importWorkflows = function importWorkflows() {
        return require(/* webpackMode: "eager" */ ${JSON.stringify(this.workflowsPath)});
      }

      exports.importInterceptors = function importInterceptors() {
        return [
          ${interceptorImports}
        ];
      }
    `;
    try {
      vol.mkdirSync(path.dirname(target), { recursive: true });
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
    }
    vol.writeFileSync(target, code);
  }

  /**
   * Run webpack
   */
  protected async bundle(
    inputFilesystem: typeof unionfs.ufs,
    outputFilesystem: memfs.IFs,
    entry: string,
    distDir: string
  ): Promise<string> {
    const captureProblematicModules: Configuration['externals'] = async (data, _callback): Promise<undefined> => {
      // Ignore the "node:" prefix if any.
      const module: string = data.request?.startsWith('node:')
        ? data.request.slice('node:'.length)
        : data.request ?? '';

      if (moduleMatches(module, disallowedModules) && !moduleMatches(module, this.ignoreModules)) {
        // this.foundProblematicModules.add(module);
        // // callback(new Error(`Import of disallowed module: '${module}'`));
        throw new Error(`Import of disallowed module: '${module}'`);
      }

      return undefined;
    };

    const options: Configuration = {
      resolve: {
        // https://webpack.js.org/configuration/resolve/#resolvemodules
        modules: [path.resolve(__dirname, 'module-overrides'), 'node_modules'],
        extensions: ['.ts', '.js'],
        extensionAlias: { '.js': ['.ts', '.js'] },
        alias: {
          __temporal_custom_payload_converter$: this.payloadConverterPath ?? false,
          __temporal_custom_failure_converter$: this.failureConverterPath ?? false,
          ...Object.fromEntries([...this.ignoreModules, ...disallowedModules].map((m) => [m, false])),
        },
        conditionNames: ['temporalio:workflow', '...'],
      },
      externals: captureProblematicModules,
      module: {
        rules: [
          {
            test: /\.js$/,
            enforce: 'pre',
            use: [require.resolve('source-map-loader')],
          },
          {
            test: /\.ts$/,
            exclude: /node_modules/,
            use: {
              loader: require.resolve('swc-loader'),
              options: {
                sourceMap: true,
                jsc: {
                  target: 'es2017',
                  parser: {
                    syntax: 'typescript',
                    decorators: true,
                  },
                },
              },
            },
          },
        ],
      },
      entry: [entry],
      mode: 'development',
      devtool: 'inline-source-map',
      output: {
        path: distDir,
        filename: 'workflow-bundle-[fullhash].js',
        devtoolModuleFilenameTemplate: '[absolute-resource-path]',
        library: '__TEMPORAL__',
      },
      ignoreWarnings: [/Failed to parse source map/],
    };

    const finalOptions = this.webpackConfigHook(options);
    const compiler = webpack(finalOptions);

    // Cast to any because the type declarations are inaccurate
    compiler.inputFileSystem = inputFilesystem as any;
    // Don't use ufs due to a strange bug on Windows:
    // https://github.com/temporalio/sdk-typescript/pull/554
    compiler.outputFileSystem = outputFilesystem as any;

    try {
      return await new Promise<string>((resolve, reject) => {
        compiler.run((err, stats) => {
          if (stats !== undefined) {
            let userStatsOptions: Parameters<typeof stats.toString>[0];
            switch (typeof (finalOptions.stats ?? undefined)) {
              case 'string':
              case 'boolean':
                userStatsOptions = { preset: finalOptions.stats as string | boolean };
                break;
              case 'object':
                userStatsOptions = finalOptions.stats as object;
                break;
              default:
                userStatsOptions = undefined;
            }

            // To debug webpack build:
            // const lines = stats.toString({ preset: 'verbose' }).split('\n');
            const webpackOutput = stats.toString({
              chunks: false,
              colors: hasColorSupport(this.logger),
              errorDetails: true,
              ...userStatsOptions,
            });

            if (this.foundProblematicModules.size) {
              const err = new Error(
                `Your Workflow code (or a library used by your Workflow code) is importing the following disallowed modules:\n` +
                  Array.from(this.foundProblematicModules)
                    .map((module) => `  - '${module}'\n`)
                    .join('') +
                  `These modules can't be used in workflow context as they might break determinism.` +
                  `HINT: Consider the following options:\n` +
                  ` • Make sure that activity code is not imported from workflow code. Use \`import type\` to import activity function signatures.\n` +
                  ` • Move code that has non-deterministic behaviour to activities.\n` +
                  ` • If you know for sure that a disallowed module will not be used at runtime, add its name to 'WorkerOptions.bundlerOptions.ignoreModules' in order to dismiss this warning.\n` +
                  `See also: https://typescript.temporal.io/api/namespaces/worker#workflowbundleoption and https://docs.temporal.io/develop/typescript/debugging#webpack-errors.`
              );

              reject(err);
              return;
            }

            if (stats.hasErrors()) {
              this.logger.error(webpackOutput);
              reject(
                new Error(
                  "Webpack finished with errors, if you're unsure what went wrong, visit our troubleshooting page at https://docs.temporal.io/develop/typescript/debugging#webpack-errors"
                )
              );
            } else if (finalOptions.stats !== 'none') {
              this.logger.info(webpackOutput);
            }

            const outputFilename = Object.keys(stats.compilation.assets)[0];
            if (!err) {
              resolve(path.join(distDir, outputFilename));
            }
          }
          reject(err);
        });
      });
    } finally {
      await util.promisify(compiler.close).bind(compiler)();
    }
  }
}

/**
 * Options for bundling Workflow code using Webpack
 */
export interface BundleOptions {
  /**
   * Path to look up workflows in, any function exported in this path will be registered as a Workflows when the bundle is loaded by a Worker.
   */
  workflowsPath: string;

  /**
   * List of modules to import Workflow interceptors from.
   *
   * Modules should export an `interceptors` variable of type {@link WorkflowInterceptorsFactory}.
   */
  workflowInterceptorModules?: string[];

  /**
   * Optional logger for logging Webpack output
   */
  logger?: Logger;

  /**
   * Path to a module with a `payloadConverter` named export.
   * `payloadConverter` should be an instance of a class that implements {@link PayloadConverter}.
   */
  payloadConverterPath?: string;

  /**
   * Path to a module with a `failureConverter` named export.
   * `failureConverter` should be an instance of a class that implements {@link FailureConverter}.
   */
  failureConverterPath?: string;

  /**
   * List of modules to be excluded from the Workflows bundle.
   *
   * > WARN: This is an advanced option that should be used with care. Improper usage may result in
   * >       runtime errors (e.g. "Cannot read properties of undefined") in Workflow code.
   *
   * Use this option when your Workflow code references an import that cannot be used in isolation,
   * e.g. a Node.js built-in module. Modules listed here **MUST** not be used at runtime.
   */
  ignoreModules?: string[];

  /**
   * List of modules to be preloaded into the Workflow sandbox execution context.
   *
   * > WARN: This is an advanced option that should be used with care. Improper usage may result in
   * >       non-deterministic behaviors and/or context leaks across workflow executions.
   *
   * When the Worker is configured with `reuseV8Context: true`, a single v8 execution context is
   * reused by multiple Workflow executions. That is, a single v8 execution context is created at
   * launch time; the source code of the workflow bundle gets injected into that context, and some
   * modules get `require`d, which forces the actual loading of those modules (i.e. module code gets
   * parsed, module variables and functions objects get instantiated, module gets registered into
   * the `require` cache, etc). After that initial loading, the execution context's globals and all
   * cached loaded modules get frozen, to avoid further mutations that could result in context
   * leaks between workflow executions.
   *
   * Then, every time a workflow is started, the workflow sandbox is restored to its pristine state,
   * and the workflow module gets `require`d, which results in loading the workflow module and any
   * other modules imported from that one. Importantly, modules loaded at that point will be
   * per-workflow-instance, and will therefore honor workflow-specific isolation guarantees without
   * requirement of being frozen. That notably means that module-level variables will be distinct
   * between workflow executions.
   *
   * Use this option to force preloading of some modules during the preparation phase of the
   * workflow execution context. This may be done for two reasons:
   *
   * - Preloading modules may reduce the per-workflow runtime cost of those modules, notably in
   *   terms memory footprint and workflow startup time.
   * - Preloading modules may be necessary if those modules need to modify global variables that
   *   would get frozen after the preparation phase, such as polyfills.
   *
   * Be warned, however, that preloaded modules will themselves get frozen, and may therefore be
   * unable to use module-level variables in some ways. There are ways to work around the
   * limitations incurred by freezing modules (e.g. use of `Map` or `Set`, closures, ECMA
   * `#privateFields`, etc.), but doing so may result in code that exhibits non-deterministic
   * behaviors and/or that may leak context across workflow executions.
   *
   * This option will have no noticeable effect if `reuseV8Context` is disabled.
   */
  preloadedModules?: string[];

  /**
   * Before Workflow code is bundled with Webpack, `webpackConfigHook` is called with the Webpack
   * {@link https://webpack.js.org/configuration/ | configuration} object so you can modify it.
   */
  webpackConfigHook?: (config: Configuration) => Configuration;
}

/**
 * Create a bundle to pass to {@link WorkerOptions.workflowBundle}. Helpful for reducing Worker startup time in
 * production.
 *
 * When using with {@link Worker.runReplayHistory}, make sure to pass the same interceptors and payload converter used
 * when the history was generated.
 */
export async function bundleWorkflowCode(options: BundleOptions): Promise<WorkflowBundleWithSourceMap> {
  const bundler = new WorkflowCodeBundler(options);
  return await bundler.createBundle();
}
