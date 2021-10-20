import path from 'path';
import util from 'util';
import dedent from 'dedent';
import webpack from 'webpack';
import * as realFS from 'fs';
import * as memfs from 'memfs';
import * as unionfs from 'unionfs';
import { Logger } from '../logger';

/**
 * Builds a V8 Isolate by bundling provided Workflows using webpack.
 * Activities are replaced with stubs.
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
    public readonly workflowInterceptorModules: string[] = []
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
    const entrypointPath = path.join('/src/main.js');

    this.genEntrypoint(vol, entrypointPath);
    await this.bundle(ufs, entrypointPath, distDir);
    return ufs.readFileSync(path.join(distDir, 'main.js'), 'utf8');
  }

  /**
   * Creates the main entrypoint for the generated webpack library.
   *
   * Exports all detected Workflow implementations and some workflow libraries to be used by the Worker.
   */
  protected genEntrypoint(vol: typeof memfs.vol, target: string): void {
    const interceptorCases = [...new Set(this.workflowInterceptorModules)]
      .map(
        (v) => dedent`
        case ${JSON.stringify(v)}:
          return import(/* webpackMode: "eager" */ ${JSON.stringify(v)});
        `
      )
      .join('\n');

    const code = dedent`
      import * as api from '@temporalio/workflow/lib/worker-interface.js';

      // Bundle all Workflows and interceptor modules for lazy evaluation
      api.overrideGlobals();
      api.setRequireFunc(
        (path) => {
          if (path === undefined) {
            return import(/* webpackMode: "eager" */ ${JSON.stringify(this.workflowsPath)});
          }
          switch (path) {
            ${interceptorCases}
            default:
              throw new ReferenceError('Cannot load module: ' + path);
          }
        }
      );

      export const {
        initRuntime,
        activate,
        concludeActivation,
        inject,
        resolveExternalDependencies,
        getAndResetExternalCalls,
        tryUnblockConditions,
      } = api;
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
    const compiler = webpack({
      resolve: {
        modules: this.nodeModulesPaths,
        extensions: ['.ts', '.js'],
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
        library: 'lib',
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
            const lines = stats.toString({ chunks: false, colors: true }).split('\n');
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
