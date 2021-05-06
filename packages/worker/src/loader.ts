import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import dedent from 'dedent';
import ivm from 'isolated-vm';
import webpack from 'webpack';
import { ActivityOptions, validateActivityOptions } from '@temporalio/workflow';
import { Logger } from './logger';

export class WorkflowIsolateBuilder {
  public readonly activities = new Set<string>();

  protected constructor(
    public readonly logger: Logger,
    public readonly distDir: string,
    public readonly workflowsPath: string,
    public readonly nodeModulesPath: string,
    public readonly activityDefaults: ActivityOptions
  ) {}

  public static async create(
    workflowsPath: string,
    nodeModulesPath: string,
    activityDefaults: ActivityOptions,
    logger: Logger
  ): Promise<WorkflowIsolateBuilder> {
    const distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'temporal-bundler-out-'));
    logger.info('Created Isolate builder dist dir', { distDir });
    return new this(logger, distDir, workflowsPath, nodeModulesPath, activityDefaults);
  }

  public async build(): Promise<ivm.Isolate> {
    try {
      const prebuildDir = path.join(this.distDir, 'prebuild');
      await fs.mkdir(prebuildDir, { recursive: true });
      const entrypointPath = path.join(prebuildDir, 'main.js');
      const workflows = await this.findWorkflows();
      await this.genEntrypoint(entrypointPath, workflows);
      await this.bundle(entrypointPath);
      const code = await fs.readFile(path.join(this.distDir, 'main.js'), 'utf8');
      const snapshot = ivm.Isolate.createSnapshot([{ code }]);
      return new ivm.Isolate({ snapshot });
    } finally {
      await fs.remove(this.distDir);
    }
  }

  async findWorkflows(): Promise<string[]> {
    const files = await fs.readdir(this.workflowsPath);
    return files.filter((f) => path.extname(f) === '.js').map((f) => path.basename(f, path.extname(f)));
  }

  protected async genEntrypoint(target: string, workflows: string[]): Promise<void> {
    let code = dedent`
      const init = require('@temporalio/workflow/es2020/init');
      const internals = require('@temporalio/workflow/es2020/internals');
      internals.state.activityDefaults = ${JSON.stringify(this.activityDefaults)};

      const workflows = {};
      export { init, internals, workflows };
    `;
    for (const wf of workflows) {
      code += `workflows[${JSON.stringify(wf)}] = require(${JSON.stringify(path.join(this.workflowsPath, wf))});\n`;
    }
    await fs.writeFile(target, code);
  }

  public async bundle(entry: string): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      webpack(
        {
          resolve: {
            modules: [this.nodeModulesPath],
            extensions: ['.js'],
            alias: Object.fromEntries(
              [...this.activities].map((spec) => [spec, path.resolve(this.distDir, 'prebuild', spec)])
            ),
          },
          entry: [entry],
          mode: 'development',
          output: {
            path: this.distDir,
            filename: 'main.js',
            library: 'lib',
          },
        },
        (err, stats) => {
          this.logger.info(stats.toString({ chunks: false, colors: true }));
          if (err) {
            reject(err);
          } else if (stats.hasErrors()) {
            reject(new Error('Webpack stats has errors'));
          } else {
            resolve();
          }
        }
      )
    );
  }

  public async registerActivities(
    activities: Map<string, Record<string, any>>,
    options: ActivityOptions
  ): Promise<void> {
    validateActivityOptions(options);
    const serializedOptions = JSON.stringify(options);
    for (const [specifier, module] of activities.entries()) {
      this.activities.add(specifier);
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
      const modulePath = path.resolve(this.distDir, 'prebuild', `${specifier}.js`);
      try {
        await fs.mkdir(path.dirname(modulePath), { recursive: true });
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      await fs.writeFile(modulePath, code);
    }
  }
}
