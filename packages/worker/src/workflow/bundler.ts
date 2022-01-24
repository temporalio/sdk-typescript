import path from 'path';
import util from 'util';
import dedent from 'dedent';
import webpack from 'webpack';
import * as realFS from 'fs';
import * as memfs from 'memfs';
import * as unionfs from 'unionfs';
import { DefaultLogger, Logger } from '../logger';
import { resolveNodeModulesPaths } from '../worker-options';

/**
 * Builds a V8 Isolate by bundling provided Workflows using webpack.
 *
 * @param nodeModulesPath node_modules path with required Workflow dependencies
 * @param workflowsPath all Workflows found in path will be put in the bundle
 * @param workflowInterceptorModules list of interceptor modules to register on Workflow creation
 */
export class WorkflowCodeBundler {
  constructor(
    public readonly logger: Logger,
    public readonly nodeModulesPaths: string[],
    public readonly workflowsPath: string,
    public readonly workflowInterceptorModules: string[] = [],
    protected readonly payloadConverterPath?: string
  ) {}

  /**
   * @return a string representation of the bundled Workflow code
   */
  public async createBundle(): Promise<string> {
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
    ufs.use(memfs.createFsFromVolume(vol) as any).use({ ...realFS, readdir: readdir as any });
    const distDir = '/dist';
    const entrypointPath = '/src/main.js';

    this.genEntrypoint(vol, entrypointPath);
    await this.bundle(ufs, entrypointPath, distDir, this.payloadConverterPath);
    return ufs.readFileSync(path.join(distDir, 'main.js'), 'utf8');
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
    filesystem: typeof unionfs.ufs,
    entry: string,
    distDir: string,
    payloadConverterPath?: string
  ): Promise<void> {
    const webpackConfig: webpack.Configuration = {
      resolve: {
        modules: [path.resolve(__dirname, 'module-overrides'), ...this.nodeModulesPaths],
        extensions: ['.ts', '.js'],
        // If we don't set an alias for this below, then it won't be imported, so webpack can safely ignore it
        fallback: { __temporal_custom_data_converter: false },
      },
      module: {
        rules: [
          {
            test: /\.ts$/,
            loader: 'ts-loader',
            exclude: /node_modules/,
          },
        ],
      },
      entry: [entry],
      mode: 'development',
      // Recommended choice for development builds with high quality SourceMaps
      devtool: 'eval-source-map',
      output: {
        path: distDir,
        filename: 'main.js',
        library: '__TEMPORAL__',
      },
    };
    if (webpackConfig.resolve) {
      if (payloadConverterPath) {
        webpackConfig.resolve.alias = {
          __temporal_custom_data_converter$: payloadConverterPath,
        };
      } else {
        // Save 100KB from the bundle by not including the npm module,
        // since we can't decode without a `root` anyway.
        webpackConfig.resolve.alias = {
          'proto3-json-serializer$': path.resolve(__dirname, 'empty-proto3-json-serializer.js'),
        };
      }
    }

    const compiler = webpack(webpackConfig);

    // Cast to any because the type declarations are inaccurate
    compiler.inputFileSystem = filesystem as any;
    compiler.outputFileSystem = filesystem as any;

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
                  "Webpack finished with errors, if you're unsure what went wrong, visit our troubleshooting page at https://docs.temporal.io/docs/typescript/troubleshooting#webpack-errors"
                )
              );
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
   * Path for webpack to look up modules in for bundling the Workflow code.
   * Automatically discovered if undefined.
   */
  nodeModulesPaths?: string[];
  /**
   * List of modules to import Workflow interceptors from
   * - Modules should export an `interceptors` variable of type {@link WorkflowInterceptorsFactory}
   * - The same list must be provided to {@link Worker.create} to actually use the interceptors
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
}

export async function bundleWorkflowCode(options: BundleOptions): Promise<{ code: string }> {
  let { logger, nodeModulesPaths } = options;

  nodeModulesPaths ??= resolveNodeModulesPaths(realFS, options.workflowsPath);
  logger ??= new DefaultLogger('INFO');
  const bundler = new WorkflowCodeBundler(
    logger,
    nodeModulesPaths,
    options.workflowsPath,
    options.workflowInterceptorModules,
    options.payloadConverterPath
  );
  return { code: await bundler.createBundle() };
}
