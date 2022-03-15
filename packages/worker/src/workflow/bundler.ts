import dedent from 'dedent';
import * as realFS from 'fs';
import * as memfs from 'memfs';
import path from 'path';
import * as unionfs from 'unionfs';
import util from 'util';
import { v4 as uuid4 } from 'uuid';
import webpack from 'webpack';
import { DefaultLogger, Logger } from '../logger';

const nodejsBuiltinModules: string[] = [
  // assert, // A replacement module is injected through module-overrides
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
];

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
    const entrypointPath = this.makeEntrypointPath(ufs, this.workflowsPath);

    this.genEntrypoint(vol, entrypointPath);
    await this.bundle(ufs, entrypointPath, distDir);
    return ufs.readFileSync(path.join(distDir, 'main.js'), 'utf8');
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
  protected async bundle(filesystem: typeof unionfs.ufs, entry: string, distDir: string): Promise<void> {
    const captureProblematicModules: webpack.Configuration['externals'] = async (
      data,
      _callback
    ): Promise<undefined> => {
      // Ignore the "node:" prefix if any.
      const module: string = data.request?.startsWith('node:')
        ? data.request.slice('node:'.length)
        : data.request ?? '';

      if (nodejsBuiltinModules.includes(module) && !this.ignoreModules.includes(module)) {
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
          ...Object.fromEntries([...this.ignoreModules, ...nodejsBuiltinModules].map((m) => [m, false])),
        },
      },
      externals: captureProblematicModules,
      module: {
        rules: [
          {
            test: /\.ts$/,
            loader: require.resolve('ts-loader'),
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
    });

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
            this.reportProblematicModules(this.foundProblematicModules);
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

  protected reportProblematicModules(foundProblematicModules: Set<string>): void {
    if (!foundProblematicModules.size) return;

    this.logger.warn(
      `Your Workflow code (or a library used by your Workflow code) is importing the following built-in Node modules:\n` +
        Array.from(foundProblematicModules)
          .map((module) => `  - '${module}'\n`)
          .join('') +
        `Workflow code don't have access to built-in Node modules (in order to help enforce determinism). If your are certain ` +
        `these modules will not be used at runtime, then you may add their names to 'BundleOptions.ignoreModules' in order to ` +
        `dismiss this warning. However, if your code execution actually depends on these modules, then you must change the code` +
        `or remove the library.\n` +
        `See https://typescript.temporal.io/api/namespaces/worker/#bundleworkflowcode for details.`
    );
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

export async function bundleWorkflowCode(options: BundleOptions): Promise<{ code: string }> {
  const bundler = new WorkflowCodeBundler(options);
  return { code: await bundler.createBundle() };
}
