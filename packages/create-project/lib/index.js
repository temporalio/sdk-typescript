#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const fs_extra_1 = require("fs-extra");
const arg_1 = __importDefault(require("arg"));
const subprocess_1 = require("./subprocess");
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
async function writePrettyJson(path, obj) {
    await fs_extra_1.writeFile(path, JSON.stringify(obj, null, 2) + os_1.default.EOL);
}
class UsageError extends Error {
    constructor() {
        super(...arguments);
        this.name = 'UsageError';
    }
}
async function createProject(projectPath, useYarn, temporalVersion) {
    const root = path_1.default.resolve(projectPath);
    const src = path_1.default.resolve(root, 'src');
    const name = path_1.default.basename(root);
    await fs_extra_1.mkdir(root);
    const packageJson = { ...packageJsonBase, name };
    await writePrettyJson(path_1.default.join(root, 'package.json'), packageJson);
    await fs_extra_1.mkdir(src);
    await fs_extra_1.mkdir(path_1.default.join(src, 'interfaces'));
    await fs_extra_1.mkdir(path_1.default.join(src, 'workflows'));
    await fs_extra_1.mkdir(path_1.default.join(src, 'activities'));
    await fs_extra_1.mkdir(path_1.default.join(src, 'worker'));
    await writePrettyJson(path_1.default.join(src, 'interfaces', 'tsconfig.json'), {
        ...tsConfigBase,
        compilerOptions: { ...tsConfigBase.compilerOptions, outDir: '../../lib/interfaces' },
    });
    await writePrettyJson(path_1.default.join(src, 'workflows', 'tsconfig.json'), workflowsTsConfig);
    await writePrettyJson(path_1.default.join(src, 'activities', 'tsconfig.json'), {
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
    await writePrettyJson(path_1.default.join(src, 'worker', 'tsconfig.json'), {
        ...tsConfigBase,
        compilerOptions: {
            ...tsConfigBase.compilerOptions,
            outDir: '../../lib/worker',
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
    const sampleDir = path_1.default.join(__dirname, '../samples');
    await fs_extra_1.copyFile(path_1.default.join(sampleDir, 'worker.ts'), path_1.default.join(src, 'worker', 'index.ts'));
    await fs_extra_1.copyFile(path_1.default.join(sampleDir, 'client.ts'), path_1.default.join(src, 'worker', 'schedule-workflow.ts'));
    await fs_extra_1.copyFile(path_1.default.join(sampleDir, 'activity.ts'), path_1.default.join(src, 'activities', 'greeter.ts'));
    await fs_extra_1.copyFile(path_1.default.join(sampleDir, 'workflow.ts'), path_1.default.join(src, 'workflows', 'example.ts'));
    await fs_extra_1.copyFile(path_1.default.join(sampleDir, 'interface.ts'), path_1.default.join(src, 'interfaces', 'workflows.ts'));
    if (useYarn) {
        await subprocess_1.spawn('yarn', ['install'], { cwd: root, stdio: 'inherit' });
        await subprocess_1.spawn('yarn', ['add', `temporalio@${temporalVersion}`], { cwd: root, stdio: 'inherit' });
    }
    else {
        await subprocess_1.spawn(npm, ['install'], { cwd: root, stdio: 'inherit' });
        await subprocess_1.spawn(npm, ['install', `temporalio@${temporalVersion}`], { cwd: root, stdio: 'inherit' });
    }
}
async function init() {
    const { _: args, ...opts } = arg_1.default({
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
    }
    else {
        console.error(err);
    }
    process.exit(1);
});
