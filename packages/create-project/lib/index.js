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
async function copySample(source, target) {
    const code = await (0, fs_extra_1.readFile)(source, 'utf8');
    const stripped = code.replace(/.*@@@SNIP(START|END).*\n/gm, '');
    await (0, fs_extra_1.writeFile)(target, stripped);
}
async function writePrettyJson(path, obj) {
    await (0, fs_extra_1.writeFile)(path, JSON.stringify(obj, null, 2) + os_1.default.EOL);
}
class UsageError extends Error {
    constructor() {
        super(...arguments);
        this.name = 'UsageError';
    }
}
class HelloWorld {
    constructor(connectionVariant) {
        this.connectionVariant = connectionVariant;
    }
    async copySources(sampleDir, targetDir) {
        if (this.connectionVariant === 'default') {
            await copySample(path_1.default.join(sampleDir, 'worker.ts'), path_1.default.join(targetDir, 'worker.ts'));
            await copySample(path_1.default.join(sampleDir, 'client.ts'), path_1.default.join(targetDir, 'exec-workflow.ts'));
        }
        else if (this.connectionVariant === 'mtls') {
            await copySample(path_1.default.join(sampleDir, 'mtls-env.ts'), path_1.default.join(targetDir, 'mtls-env.ts'));
            await copySample(path_1.default.join(sampleDir, 'worker-mtls.ts'), path_1.default.join(targetDir, 'worker.ts'));
            await copySample(path_1.default.join(sampleDir, 'client-mtls.ts'), path_1.default.join(targetDir, 'exec-workflow.ts'));
        }
        await copySample(path_1.default.join(sampleDir, 'activity.ts'), path_1.default.join(targetDir, 'activities.ts'));
        await copySample(path_1.default.join(sampleDir, 'workflow.ts'), path_1.default.join(targetDir, 'workflows', 'index.ts'));
        await copySample(path_1.default.join(sampleDir, 'interface.ts'), path_1.default.join(targetDir, 'interfaces.ts'));
    }
}
function getTemplate(sampleName) {
    switch (sampleName) {
        case 'hello-world':
            return new HelloWorld('default');
        case 'hello-world-mtls':
            return new HelloWorld('mtls');
    }
    throw new TypeError(`Invalid sample name ${sampleName}`);
}
async function createProject(projectPath, useYarn, temporalVersion, sample) {
    const root = path_1.default.resolve(projectPath);
    const src = path_1.default.resolve(root, 'src');
    const name = path_1.default.basename(root);
    await (0, fs_extra_1.mkdir)(root);
    const packageJson = { ...packageJsonBase, name };
    await writePrettyJson(path_1.default.join(root, 'package.json'), packageJson);
    await (0, fs_extra_1.mkdir)(src);
    await (0, fs_extra_1.mkdir)(path_1.default.join(src, 'workflows'));
    await writePrettyJson(path_1.default.join(root, 'tsconfig.json'), tsConfig);
    const sampleDir = path_1.default.join(__dirname, '../samples');
    const template = getTemplate(sample);
    await template.copySources(sampleDir, src);
    if (useYarn) {
        await (0, subprocess_1.spawn)('yarn', ['install'], { cwd: root, stdio: 'inherit' });
        await (0, subprocess_1.spawn)('yarn', ['add', `temporalio@${temporalVersion}`], { cwd: root, stdio: 'inherit' });
    }
    else {
        await (0, subprocess_1.spawn)(npm, ['install'], { cwd: root, stdio: 'inherit' });
        await (0, subprocess_1.spawn)(npm, ['install', `temporalio@${temporalVersion}`], { cwd: root, stdio: 'inherit' });
    }
}
async function init() {
    const { _: args, ...opts } = (0, arg_1.default)({
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
        console.error(`Usage: ${command} [--use-yarn] [--temporal-version VERSION] [--sample hello-world|hello-world-mtls] <packagePath>`);
    }
    else {
        console.error(err);
    }
    process.exit(1);
});
//# sourceMappingURL=index.js.map