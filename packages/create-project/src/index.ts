import os from 'os';
import path from 'path';
import { mkdir, writeFile, copyFile } from 'fs-extra';
import arg from 'arg';
import { spawn } from './subprocess';

const command = '@temporalio/create';
const temporalVersion = '0.1.0';
const typescriptVersion = '4.2.2';

const packageJsonBase = {
  version: '0.1.0',
  private: true,
  scripts: {
    build: 'tsc --build src/worker/tsconfig.json',
    'build.watch': 'tsc --build --watch src/worker/tsconfig.json',
  },
  dependencies: {
    temporalio: `^${temporalVersion}`,
  },
  devDependencies: {
    typescript: `^${typescriptVersion}`,
    '@tsconfig/node12': '^1.0.7',
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
  extends: '@tsconfig/node12/tsconfig.json',
  ...tsConfigSharedBase,
};

const workflowsTsConfig = {
  ...tsConfigSharedBase,
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
    target: 'es2017',
    module: 'es2020',
    moduleResolution: 'node',
    esModuleInterop: true,
    strict: true,
    typeRoots: ['.'],
    outDir: '../lib/workflows',
    paths: {
      '@activities': ['../activities'],
      '@activities/*': ['../activities/*'],
      '@interfaces': ['../interfaces'],
      '@interfaces/*': ['../interfaces/*'],
    },
  },
  references: [{ path: '../activities/tsconfig.json' }, { path: '../interfaces/tsconfig.json' }],
};

async function writePrettyJson(path: string, obj: any) {
  await writeFile(path, JSON.stringify(obj, null, 2) + os.EOL);
}

export class UsageError extends Error {
  public readonly name: string = 'UsageError';
}

async function createProject(projectPath: string, useYarn: boolean) {
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
    compilerOptions: { ...tsConfigBase.compilerOptions, outDir: '../lib/interfaces' },
  });
  await writeFile(path.join(src, 'interfaces', 'index.ts'), '');
  await writePrettyJson(path.join(src, 'workflows', 'tsconfig.json'), workflowsTsConfig);
  await writeFile(path.join(src, 'workflows', 'index.ts'), '');
  await writePrettyJson(path.join(src, 'activities', 'tsconfig.json'), {
    ...tsConfigBase,
    compilerOptions: {
      ...tsConfigBase.compilerOptions,
      outDir: '../lib/activities',
      paths: {
        '@interfaces': ['../interfaces'],
        '@interfaces/*': ['../interfaces/*'],
      },
    },
    references: [{ path: '../interfaces/tsconfig.json' }],
  });
  await writeFile(path.join(src, 'activities', 'index.ts'), '');
  await writePrettyJson(path.join(src, 'worker', 'tsconfig.json'), {
    ...tsConfigBase,
    compilerOptions: {
      ...tsConfigBase.compilerOptions,
      outDir: '../lib/worker',
      paths: {
        '@workflows': ['../workflows'],
        '@workflows/*': ['../workflows/*'],
        '@activities': ['../activities'],
        '@activities/*': ['../activities/*'],
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
  await copyFile(path.join(__dirname, '../samples/worker.ts'), path.join(src, 'worker', 'index.ts'));
  if (useYarn) {
    await spawn('yarn', ['install'], { cwd: root, stdio: 'inherit' });
  } else {
    await spawn('npm', ['install'], { cwd: root, stdio: 'inherit' });
  }
}

async function init() {
  const { _: args, ...opts } = arg({
    '--use-yarn': Boolean,
  });
  if (args.length !== 1) {
    throw new UsageError();
  }
  await createProject(args[0], !!opts['--use-yarn']);
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
