import path from 'path';
import util from 'util';
import os from 'os';
import fs from 'fs-extra';
import dedent from 'dedent';
import ivm from 'isolated-vm';
import webpack from 'webpack';
import { ActivityOptions, validateActivityOptions } from '@temporalio/workflow';
import { Logger } from './logger';

/**
 * Builds a V8 Isolate by bundling provided Workflows using webpack.
 * Activities are replaced with stubs.
 *
 * @param nodeModulesPath node_modules path with required Workflow dependencies
 * @param workflowsPath all Workflows found in path will be put in the bundle
 * @param activities mapping of module name to module exports, exported functions will be replaced with stubs and the rest ignored
 * @param activityDefaults used to inject Activity options into the Activity stubs
 */
export class WorkflowIsolateBuilder {
  constructor(
    public readonly logger: Logger,
    public readonly nodeModulesPath: string,
    public readonly workflowsPath: string,
    public readonly activities: Map<string, Record<string, any>>,
    public readonly activityDefaults: ActivityOptions
  ) {}

  /**
   * Bundle Workflows with dependencies and return an Isolate pre-loaded with bundle.
   */
  public async build(): Promise<ivm.Isolate> {
    const distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'temporal-bundler-out-'));
    this.logger.info('Building Workflow code for Worker isolate', { distDir });
    try {
      const prebuildDir = path.join(distDir, 'prebuild');
      await fs.mkdir(prebuildDir, { recursive: true });
      await this.registerActivities(prebuildDir);
      const entrypointPath = path.join(prebuildDir, 'main.js');
      const workflows = await this.findWorkflows();
      await this.genEntrypoint(entrypointPath, workflows);
      await this.bundle(entrypointPath, distDir);
      const code = await fs.readFile(path.join(distDir, 'main.js'), 'utf8');
      const snapshot = ivm.Isolate.createSnapshot([{ code }]);
      return new ivm.Isolate({ snapshot });
    } finally {
      await fs.remove(distDir);
    }
  }

  /**
   * Shallow lookup of all js files in workflowsPath
   */
  protected async findWorkflows(): Promise<string[]> {
    const files = await fs.readdir(this.workflowsPath);
    return files.filter((f) => path.extname(f) === '.js').map((f) => path.basename(f, path.extname(f)));
  }

  /**
   * Creates the main entrypoint for the generated webpack library.
   *
   * Exports all detected Workflow implementations and some workflow libraries to be used by the Worker.
   */
  protected async genEntrypoint(target: string, workflows: string[]): Promise<void> {
    let code = dedent`
      const init = require('@temporalio/workflow/lib/init');
      const internals = require('@temporalio/workflow/lib/internals');
      internals.state.activityDefaults = ${JSON.stringify(this.activityDefaults)};

      const workflows = {};
      export { init, internals, workflows };
    `;
    for (const wf of workflows) {
      code += `workflows[${JSON.stringify(wf)}] = require(${JSON.stringify(path.join(this.workflowsPath, wf))});\n`;
    }
    await fs.writeFile(target, code);
  }

  /**
   * Run webpack
   */
  protected async bundle(entry: string, distDir: string): Promise<void> {
    const compiler = webpack({
      resolve: {
        modules: [this.nodeModulesPath],
        extensions: ['.js'],
        alias: Object.fromEntries(
          [...this.activities.keys()].map((spec) => [spec, path.resolve(distDir, 'prebuild', spec)])
        ),
      },
      entry: [entry],
      // TODO: production build?
      mode: 'development',
      output: {
        path: distDir,
        filename: 'main.js',
        library: 'lib',
      },
    });

    try {
      await new Promise<void>((resolve, reject) => {
        compiler.run((err, stats) => {
          if (stats !== undefined) {
            const lines = stats.toString({ chunks: false, colors: true }).split('\n');
            for (const line of lines) {
              this.logger.info(line);
            }
          }
          if (err) {
            reject(err);
          } else if (stats?.hasErrors()) {
            reject(new Error('Webpack stats has errors'));
          } else {
            resolve();
          }
        });
      });
    } finally {
      await util.promisify(compiler.close).bind(compiler)();
    }
  }

  public async registerActivities(prebuildDir: string): Promise<void> {
    validateActivityOptions(this.activityDefaults);
    const serializedOptions = JSON.stringify(this.activityDefaults);
    for (const [specifier, module] of this.activities.entries()) {
      let code = dedent`
        import { scheduleActivity } from '@temporalio/workflow';
      `;
      for (const [k, v] of Object.entries(module)) {
        if (v instanceof Function) {
          // Activities are identified by their module specifier and name.
          // We double stringify below to generate a string containing a JSON array.
          const type = JSON.stringify(JSON.stringify([specifier, k]));
          // TODO: Validate k against pattern
          code += dedent`
            export function ${k}(...args) {
              return scheduleActivity(${type}, args, ${serializedOptions});
            }
            ${k}.type = ${type};
            ${k}.options = ${serializedOptions};
          `;
        }
      }
      const modulePath = path.resolve(prebuildDir, `${specifier}.js`);
      try {
        await fs.mkdir(path.dirname(modulePath), { recursive: true });
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      await fs.writeFile(modulePath, code);
    }
  }

  /**
   * Resolve activities by perfoming a shallow lookup all JS files in `activitiesPath`.
   */
  public static async resolveActivities(
    logger: Logger,
    activitiesPath: string
  ): Promise<Map<string, Record<string, (...args: any[]) => any>>> {
    const resolvedActivities = new Map<string, Record<string, (...args: any[]) => any>>();
    const files = await fs.readdir(activitiesPath, { encoding: 'utf8' });
    for (const file of files) {
      const ext = path.extname(file);
      if (ext === '.js') {
        const fullPath = path.resolve(activitiesPath, file);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require(fullPath);
        const functions = Object.fromEntries(
          Object.entries(module).filter((entry): entry is [string, () => any] => entry[1] instanceof Function)
        );
        const importName = path.basename(file, ext);
        logger.debug('Loaded activity', { importName, fullPath });
        resolvedActivities.set(`@activities/${importName}`, functions);
        if (importName === 'index') {
          resolvedActivities.set('@activities', functions);
        }
      }
    }
    return resolvedActivities;
  }
}
