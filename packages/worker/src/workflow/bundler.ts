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
  protected readonly ignoreModules: string[];
  protected readonly webpackConfigHook: (config: Configuration) => Configuration;

  constructor({
    logger,
    workflowsPath,
    payloadConverterPath,
    failureConverterPath,
    workflowInterceptorModules,
    ignoreModules,
    webpackConfigHook,
  }: BundleOptions) {
    this.logger = logger ?? new DefaultLogger('INFO');
    this.workflowsPath = workflowsPath;
    this.payloadConverterPath = payloadConverterPath;
    this.failureConverterPath = failureConverterPath;
    this.workflowInterceptorModules = workflowInterceptorModules ?? [];
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

    const code = `
const api = require('@temporalio/workflow/lib/worker-interface.js');
exports.api = api;

const { overrideGlobals } = require('@temporalio/workflow/lib/global-overrides.js');
overrideGlobals();

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
        this.foundProblematicModules.add(module);
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

    const compiler = webpack(this.webpackConfigHook(options));

    // Cast to any because the type declarations are inaccurate
    compiler.inputFileSystem = inputFilesystem as any;
    // Don't use ufs due to a strange bug on Windows:
    // https://github.com/temporalio/sdk-typescript/pull/554
    compiler.outputFileSystem = outputFilesystem as any;

    try {
      return await new Promise<string>((resolve, reject) => {
        compiler.run((err, stats) => {
          if (stats !== undefined) {
            const hasError = stats.hasErrors();
            // To debug webpack build:
            // const lines = stats.toString({ preset: 'verbose' }).split('\n');
            const webpackOutput = stats.toString({
              chunks: false,
              colors: hasColorSupport(this.logger),
              errorDetails: true,
            });
            this.logger[hasError ? 'error' : 'info'](webpackOutput);
            if (hasError) {
              reject(
                new Error(
                  "Webpack finished with errors, if you're unsure what went wrong, visit our troubleshooting page at https://docs.temporal.io/develop/typescript/debugging#webpack-errors"
                )
              );
            }

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
                  `See also: https://typescript.temporal.io/api/namespaces/worker#workflowbundleoption and https://docs.temporal.io/typescript/determinism.`
              );

              reject(err);
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
   * Use this option when your Workflow code references an import that cannot be used in isolation,
   * e.g. a Node.js built-in module. Modules listed here **MUST** not be used at runtime.
   *
   * > NOTE: This is an advanced option that should be used with care.
   */
  ignoreModules?: string[];

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
