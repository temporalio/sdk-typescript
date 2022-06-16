import * as realFS from 'fs';
import * as memfs from 'memfs';
import { builtinModules } from 'module';
import path from 'path';
import dedent from 'ts-dedent';
import * as unionfs from 'unionfs';
import util from 'util';
import { v4 as uuid4 } from 'uuid';
import webpack from 'webpack';
import { DefaultLogger, Logger } from '../logger';

export const allowedBuiltinModules = ['assert'];
export const disallowedBuiltinModules = builtinModules.filter((module) => !allowedBuiltinModules.includes(module));

export function moduleMatches(userModule: string, modules: string[]): boolean {
  return modules.some((module) => userModule === module || userModule.startsWith(`${module}/`));
}

export interface WorkflowBundleWithSourceMap {
  code: string;
  sourceMap: string;
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
  protected readonly ignoreModules: string[];

  constructor({
    logger,
    workflowsPath,
    payloadConverterPath,
    workflowInterceptorModules,
    ignoreModules,
  }: BundleOptions) {
    this.logger = logger ?? new DefaultLogger('INFO');
    this.workflowsPath = workflowsPath;
    this.payloadConverterPath = payloadConverterPath;
    this.workflowInterceptorModules = workflowInterceptorModules ?? [];
    this.ignoreModules = ignoreModules ?? [];
  }

  /**
   * @return a {@link WorkflowBundleWithSourceMap} containing bundled code and source map
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
    await this.bundle(ufs, memoryFs, entrypointPath, distDir);

    // Cast because the type definitions are inaccurate
    return {
      code: memoryFs.readFileSync(path.join(distDir, 'main.js'), 'utf8') as string,
      sourceMap: memoryFs.readFileSync(path.join(distDir, 'main.source.js'), 'utf8') as string,
    };
  }

  protected makeEntrypointPath(fs: typeof unionfs.ufs, workflowsPath: string): string {
    const stat = fs.statSync(workflowsPath);
    if (stat.isFile()) {
      // workflowsPath is a file; make the entrypoint a sibling of that file
      const { root, dir, name } = path.parse(workflowsPath);
      return path.format({ root, dir, base: `${name}-entrypoint-${uuid4()}.js` });
    } else {
      // workflowsPath is a directory; make the entrypoint a sibling of that directory
      const { root, dir, base } = path.parse(workflowsPath);
      return path.format({ root, dir, base: `${base}-entrypoint-${uuid4()}.js` });
    }
  }

  /**
   * Creates the main entrypoint for the generated webpack library.
   *
   * Exports all detected Workflow implementations and some workflow libraries to be used by the Worker.
   */
  protected genEntrypoint(vol: typeof memfs.vol, target: string): void {
    const interceptorImports = [...new Set(this.workflowInterceptorModules)]
      .map((v) => `import(/* webpackMode: "eager" */ ${JSON.stringify(v)})`)
      .join(', \n');

    const code = dedent`
      import * as api from '@temporalio/workflow/lib/worker-interface.js';

      // Bundle all Workflows and interceptor modules for lazy evaluation
      api.overrideGlobals();
      api.setImportFuncs({
        importWorkflows: () => {
          return import(/* webpackMode: "eager" */ ${JSON.stringify(this.workflowsPath)});
        },
        importInterceptors: () => {
          return Promise.all([
            ${interceptorImports}
          ]);
        }
      });

      export { api };
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
  ): Promise<void> {
    const captureProblematicModules: webpack.Configuration['externals'] = async (
      data,
      _callback
    ): Promise<undefined> => {
      // Ignore the "node:" prefix if any.
      const module: string = data.request?.startsWith('node:')
        ? data.request.slice('node:'.length)
        : data.request ?? '';

      if (moduleMatches(module, disallowedBuiltinModules) && !moduleMatches(module, this.ignoreModules)) {
        this.foundProblematicModules.add(module);
      }

      return undefined;
    };

    const compiler = webpack({
      resolve: {
        // https://webpack.js.org/configuration/resolve/#resolvemodules
        modules: [path.resolve(__dirname, 'module-overrides'), 'node_modules'],
        extensions: ['.ts', '.js'],
        alias: {
          __temporal_custom_payload_converter$: this.payloadConverterPath ?? false,
          ...Object.fromEntries([...this.ignoreModules, ...disallowedBuiltinModules].map((m) => [m, false])),
        },
      },
      externals: captureProblematicModules,
      module: {
        rules: [
          {
            test: /\.js$/,
            enforce: 'pre',
            use: ['source-map-loader'],
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
      devtool: 'source-map',
      output: {
        path: distDir,
        filename: 'main.js',
        sourceMapFilename: 'main.source.js',
        devtoolModuleFilenameTemplate: '[absolute-resource-path]',
        library: '__TEMPORAL__',
      },
    });

    // Cast to any because the type declarations are inaccurate
    compiler.inputFileSystem = inputFilesystem as any;
    // Don't use ufs due to a strange bug on Windows:
    // https://github.com/temporalio/sdk-typescript/pull/554
    compiler.outputFileSystem = outputFilesystem as any;

    try {
      await new Promise<void>((resolve, reject) => {
        compiler.run((err, stats) => {
          if (stats !== undefined) {
            const hasError = stats.hasErrors();
            // To debug webpack build:
            // const lines = stats.toString({ preset: 'verbose' }).split('\n');
            const lines = stats.toString({ chunks: false, colors: true, errorDetails: true }).split('\n');
            for (const line of lines) {
              this.logger[hasError ? 'error' : 'info'](line);
            }
            if (hasError) {
              reject(
                new Error(
                  "Webpack finished with errors, if you're unsure what went wrong, visit our troubleshooting page at https://docs.temporal.io/typescript/troubleshooting#webpack-errors"
                )
              );
            }

            if (this.foundProblematicModules.size) {
              const err = new Error(
                `Your Workflow code (or a library used by your Workflow code) is importing the following built-in Node modules:\n` +
                  Array.from(this.foundProblematicModules)
                    .map((module) => `  - '${module}'\n`)
                    .join('') +
                  `Workflow code doesn't have access to built-in Node modules (in order to help enforce determinism). If you are certain ` +
                  `these modules will not be used at runtime, then you may add their names to 'WorkerOptions.bundlerOptions.ignoreModules' in order to ` +
                  `dismiss this warning. However, if your code execution actually depends on these modules, then you must change the code ` +
                  `or remove the library.\n` +
                  `See https://typescript.temporal.io/api/interfaces/worker.workeroptions/#bundleroptions for details.`
              );

              reject(err);
            }
          }
          if (err) {
            reject(err);
          } else {
            resolve();
          }
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
   * List of modules to import Workflow interceptors from
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
   * `payloadConverter` should be an instance of a class that extends {@link DataConverter}.
   */
  payloadConverterPath?: string;
  /**
   * List of modules to be excluded from the Workflows bundle.
   *
   * Use this option when your Workflow code references an import that cannot be used in isolation,
   * e.g. a Node.js built-in module. Modules listed here **MUST** not be used at runtime.
   *
   * > NOTE: This is an advanced option that should be used with care.
   */
  ignoreModules?: string[];
}

export async function bundleWorkflowCode(options: BundleOptions): Promise<WorkflowBundleWithSourceMap> {
  const bundler = new WorkflowCodeBundler(options);
  return await bundler.createBundle();
}
