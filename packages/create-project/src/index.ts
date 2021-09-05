#!/usr/bin/env node
import os from 'os';
import path from 'path';
import { mkdir, writeFile, readFile } from 'fs-extra';
import arg from 'arg';
import { spawn } from './subprocess';

const command = '@temporalio/create';
const typescriptVersion = '4.4.2';
const nodeMajorVersion = parseInt(process.versions.node, 10);
const npm = /^win/.test(process.platform) ? 'npm.cmd' : 'npm';

const packageJsonBase = {
  version: '0.1.0',
  private: true,
  scripts: {
    build: 'tsc --build',
    'build.watch': 'tsc --build --watch',
    start: 'ts-node src/worker.ts',
    'start.watch': 'nodemon src/worker.ts',
    workflow: 'ts-node src/exec-workflow.ts',
  },
  devDependencies: {
    typescript: `^${typescriptVersion}`,
    [`@tsconfig/node${nodeMajorVersion}`]: '^1.0.0',
    'ts-node': '^10.2.1',
    nodemon: '^2.0.12',
  },
  nodemonConfig: {
    watch: ['src'],
    ext: 'ts',
    execMap: {
      ts: 'ts-node',
    },
  },
};

const tsConfig = {
  extends: `@tsconfig/node${nodeMajorVersion}/tsconfig.json`,
  version: typescriptVersion,
  compilerOptions: {
    emitDecoratorMetadata: false,
    experimentalDecorators: false,
    declaration: true,
    declarationMap: true,
    sourceMap: true,
    composite: true,
    rootDir: './src',
    outDir: './lib',
  },
  include: ['src/**/*.ts'],
  exclude: ['node_modules'],
};

/**
 * Copy sample from `source` to `target` stripping away snipsync comments
 */
async function copySample(source: string, target: string) {
  const code = await readFile(source, 'utf8');
  const stripped = code.replace(/.*@@@SNIP(START|END).*\n/gm, '');
  await writeFile(target, stripped);
}

async function writePrettyJson(path: string, obj: any) {
  await writeFile(path, JSON.stringify(obj, null, 2) + os.EOL);
}

class UsageError extends Error {
  public readonly name: string = 'UsageError';
}

interface Template {
  copySources(sampleDir: string, targetDir: string): Promise<void>;
}

class HelloWorld implements Template {
  constructor(public connectionVariant: 'default' | 'mtls') {}

  async copySources(sampleDir: string, targetDir: string): Promise<void> {
    if (this.connectionVariant === 'default') {
      await copySample(path.join(sampleDir, 'worker.ts'), path.join(targetDir, 'worker.ts'));
      await copySample(path.join(sampleDir, 'client.ts'), path.join(targetDir, 'exec-workflow.ts'));
    } else if (this.connectionVariant === 'mtls') {
      await copySample(path.join(sampleDir, 'mtls-env.ts'), path.join(targetDir, 'mtls-env.ts'));
      await copySample(path.join(sampleDir, 'worker-mtls.ts'), path.join(targetDir, 'worker.ts'));
      await copySample(path.join(sampleDir, 'client-mtls.ts'), path.join(targetDir, 'exec-workflow.ts'));
    }
    await copySample(path.join(sampleDir, 'activity.ts'), path.join(targetDir, 'activities.ts'));
    await copySample(path.join(sampleDir, 'workflow.ts'), path.join(targetDir, 'workflows', 'example.ts'));
    await copySample(path.join(sampleDir, 'interface.ts'), path.join(targetDir, 'interfaces', 'workflows.ts'));
  }
}

function getTemplate(sampleName: string): Template {
  switch (sampleName) {
    case 'hello-world':
      return new HelloWorld('default');
    case 'hello-world-mtls':
      return new HelloWorld('mtls');
  }
  throw new TypeError(`Invalid sample name ${sampleName}`);
}

async function createProject(projectPath: string, useYarn: boolean, temporalVersion: string, sample: string) {
  const root = path.resolve(projectPath);
  const src = path.resolve(root, 'src');
  const name = path.basename(root);
  await mkdir(root);
  const packageJson = { ...packageJsonBase, name };
  await writePrettyJson(path.join(root, 'package.json'), packageJson);
  await mkdir(src);
  await mkdir(path.join(src, 'interfaces'));
  await mkdir(path.join(src, 'workflows'));
  await writePrettyJson(path.join(root, 'tsconfig.json'), tsConfig);
  const sampleDir = path.join(__dirname, '../samples');
  const template = getTemplate(sample);
  await template.copySources(sampleDir, src);
  if (useYarn) {
    await spawn('yarn', ['install'], { cwd: root, stdio: 'inherit' });
    await spawn('yarn', ['add', `temporalio@${temporalVersion}`], { cwd: root, stdio: 'inherit' });
  } else {
    await spawn(npm, ['install'], { cwd: root, stdio: 'inherit' });
    await spawn(npm, ['install', `temporalio@${temporalVersion}`], { cwd: root, stdio: 'inherit' });
  }
}

async function init() {
  const { _: args, ...opts } = arg({
    '--use-yarn': Boolean,
    '--temporal-version': String,
    '--sample': String,
  });
  if (args.length !== 1) {
    throw new UsageError();
  }
  const sample = opts['--sample'] || 'hello-world';
  await createProject(args[0], !!opts['--use-yarn'], opts['--temporal-version'] || 'latest', sample);
}

init()
  .then(() => process.exit(0))
  .catch((err) => {
    if (err instanceof UsageError) {
      console.error(
        `Usage: ${command} [--use-yarn] [--temporal-version VERSION] [--sample hello-world|hello-world-mtls] <packagePath>`
      );
    } else {
      console.error(err);
    }
    process.exit(1);
  });
