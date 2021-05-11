#!/usr/bin/env node
import os from 'os';
import path from 'path';
import { mkdir, writeFile, readFile } from 'fs-extra';
import arg from 'arg';
import { spawn } from './subprocess';

const command = '@temporalio/create';
const typescriptVersion = '4.2.2';
const npm = /^win/.test(process.platform) ? 'npm.cmd' : 'npm';

const packageJsonBase = {
  version: '0.1.0',
  private: true,
  scripts: {
    build: 'tsc --build src/worker/tsconfig.json',
    'build.watch': 'tsc --build --watch src/worker/tsconfig.json',
    start: 'node lib/worker',
  },
  devDependencies: {
    typescript: `^${typescriptVersion}`,
    '@tsconfig/node14': '^1.0.0',
  },
};

const tsConfigSharedBase = {
  version: typescriptVersion,
  compilerOptions: {
    emitDecoratorMetadata: false,
    experimentalDecorators: false,
    declaration: true,
    declarationMap: true,
    sourceMap: true,
    composite: true,
    incremental: true,
    rootDir: '.',
  },
  include: ['./**/*.ts'],
};

const tsConfigBase = {
  extends: '@tsconfig/node14/tsconfig.json',
  ...tsConfigSharedBase,
};

const workflowsTsConfig = {
  ...tsConfigBase,
  compilerOptions: {
    ...tsConfigSharedBase.compilerOptions,
    lib: [
      // es2015.collection excluded because it defines WeakMap and WeakSet
      'es5',
      'es2015.core',
      'es2015.generator',
      'es2015.iterable',
      'es2015.promise',
      'es2015.proxy',
      'es2015.reflect',
      'es2015.symbol',
      'es2015.symbol.wellknown',
      'es2016.array.include',
      'es2017.object',
      'es2017.intl',
      'es2017.sharedmemory',
      'es2017.string',
      'es2017.typedarrays',
    ],
    typeRoots: ['.'],
    outDir: '../../lib/workflows',
    paths: {
      '@activities': ['../activities'],
      '@activities/*': ['../activities/*'],
      '@interfaces': ['../interfaces'],
      '@interfaces/*': ['../interfaces/*'],
    },
  },
  references: [{ path: '../activities/tsconfig.json' }, { path: '../interfaces/tsconfig.json' }],
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

async function createProject(projectPath: string, useYarn: boolean, temporalVersion: string) {
  const root = path.resolve(projectPath);
  const src = path.resolve(root, 'src');
  const name = path.basename(root);
  await mkdir(root);
  const packageJson = { ...packageJsonBase, name };
  await writePrettyJson(path.join(root, 'package.json'), packageJson);
  await mkdir(src);
  await mkdir(path.join(src, 'interfaces'));
  await mkdir(path.join(src, 'workflows'));
  await mkdir(path.join(src, 'activities'));
  await mkdir(path.join(src, 'worker'));
  await writePrettyJson(path.join(src, 'interfaces', 'tsconfig.json'), {
    ...tsConfigBase,
    compilerOptions: { ...tsConfigBase.compilerOptions, outDir: '../../lib/interfaces' },
  });
  await writePrettyJson(path.join(src, 'workflows', 'tsconfig.json'), workflowsTsConfig);
  await writePrettyJson(path.join(src, 'activities', 'tsconfig.json'), {
    ...tsConfigBase,
    compilerOptions: {
      ...tsConfigBase.compilerOptions,
      outDir: '../../lib/activities',
      paths: {
        '@interfaces': ['../interfaces'],
        '@interfaces/*': ['../interfaces/*'],
      },
    },
    references: [{ path: '../interfaces/tsconfig.json' }],
  });
  await writePrettyJson(path.join(src, 'worker', 'tsconfig.json'), {
    ...tsConfigBase,
    compilerOptions: {
      ...tsConfigBase.compilerOptions,
      outDir: '../../lib/worker',
      paths: {
        '@interfaces': ['../interfaces'],
        '@interfaces/*': ['../interfaces/*'],
      },
    },
    references: [
      { path: '../interfaces/tsconfig.json' },
      { path: '../activities/tsconfig.json' },
      { path: '../workflows/tsconfig.json' },
    ],
  });
  const sampleDir = path.join(__dirname, '../samples');
  await copySample(path.join(sampleDir, 'worker.ts'), path.join(src, 'worker', 'index.ts'));
  await copySample(path.join(sampleDir, 'client.ts'), path.join(src, 'worker', 'schedule-workflow.ts'));
  await copySample(path.join(sampleDir, 'activity.ts'), path.join(src, 'activities', 'greeter.ts'));
  await copySample(path.join(sampleDir, 'workflow.ts'), path.join(src, 'workflows', 'example.ts'));
  await copySample(path.join(sampleDir, 'interface.ts'), path.join(src, 'interfaces', 'workflows.ts'));
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
  });
  if (args.length !== 1) {
    throw new UsageError();
  }
  await createProject(args[0], !!opts['--use-yarn'], opts['--temporal-version'] || 'latest');
}

init()
  .then(() => process.exit(0))
  .catch((err) => {
    if (err instanceof UsageError) {
      console.error(`Usage: ${command} <packagePath>`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
