#!/usr/bin/env node
"use strict";
// Modified from: https://github.com/vercel/next.js/blob/2425f4703c4c6164cecfdb6aa8f80046213f0cc6/packages/create-next-app/index.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const chalk_1 = __importDefault(require("chalk"));
const commander_1 = require("commander");
const path_1 = __importDefault(require("path"));
const prompts_1 = __importDefault(require("prompts"));
const update_check_1 = __importDefault(require("update-check"));
const create_project_1 = require("./create-project");
const validate_pkg_1 = require("./helpers/validate-pkg");
const fetch_examples_1 = require("./helpers/fetch-examples");
const pkg_1 = __importDefault(require("./pkg"));
const program = new commander_1.Command(pkg_1.default.name)
    .version(pkg_1.default.version, '-v, --version')
    .arguments('[project-directory]')
    .usage(`${chalk_1.default.green('[project-directory]')} [options]`)
    .option('--use-yarn', `

  Use yarn instead of npm
`)
    .option('-e, --example <name|github-url>', `

  An example to bootstrap the app with. You can use an example name
  from https://github.com/temporalio/samples-node or a GitHub URL. 
  The URL can use any branch and/or subdirectory
`)
    .option('--example-path <path-to-example>', `

  In a rare case, your GitHub URL might contain a branch name with
  a slash (e.g. bug/fix-1) and the path to the example (e.g. foo/bar).
  In this case, you must specify the path to the example separately:
  --example-path foo/bar
`)
    .option('-l, --list-examples', `

  Print available example projects
`)
    .allowUnknownOption()
    .parse(process.argv);
let opts;
async function run() {
    opts = program.opts();
    if (opts.listExamples) {
        const examples = await (0, fetch_examples_1.fetchExamples)();
        console.log(`Available examples:\n\n${examples.join('\n')}\n`);
        return;
    }
    let projectPath = program.args[0];
    if (typeof projectPath === 'string') {
        projectPath = projectPath.trim();
    }
    if (!projectPath) {
        const res = await (0, prompts_1.default)({
            type: 'text',
            name: 'path',
            message: 'What is your project named?',
            initial: 'my-temporal',
            validate: (name) => {
                const validation = (0, validate_pkg_1.validateNpmName)(path_1.default.basename(path_1.default.resolve(name)));
                if (validation.valid) {
                    return true;
                }
                return 'Invalid project name: ' + validation.problems?.[0];
            },
        });
        if (typeof res.path === 'string') {
            projectPath = res.path.trim();
        }
    }
    if (!projectPath) {
        console.error();
        console.error('Please specify the project directory:');
        console.error(`  ${chalk_1.default.cyan(program.name())} ${chalk_1.default.green('<project-directory>')}`);
        console.error();
        console.error('For example:');
        console.error(`  ${chalk_1.default.cyan(program.name())} ${chalk_1.default.green('my-temporal-project')}`);
        console.error();
        console.error(`Run ${chalk_1.default.cyan(`${program.name()} --help`)} to see all options.`);
        process.exit(1);
    }
    const resolvedProjectPath = path_1.default.resolve(projectPath);
    const projectName = path_1.default.basename(resolvedProjectPath);
    const { valid, problems } = (0, validate_pkg_1.validateNpmName)(projectName);
    if (!valid) {
        console.error(`Could not create a project called ${chalk_1.default.red(`"${projectName}"`)} because of npm naming restrictions:`);
        problems?.forEach((p) => console.error(`    ${chalk_1.default.red.bold('*')} ${p}`));
        process.exit(1);
    }
    let example = opts.example;
    if (!example) {
        const examples = await (0, fetch_examples_1.fetchExamples)();
        const choices = examples.map((example) => ({ title: example, value: example }));
        const res = await (0, prompts_1.default)({
            type: 'select',
            name: 'example',
            message: `Which example would you like to use?`,
            choices,
            initial: examples.indexOf('hello-world'),
        });
        if (typeof res.example === 'string') {
            example = res.example;
        }
    }
    if (!example) {
        console.error();
        console.error('Please specify which example:');
        console.error(`  ${chalk_1.default.cyan(program.name())} --example ${chalk_1.default.green('<name|github-url>')}`);
        console.error();
        console.error('For example:');
        console.error(`  ${chalk_1.default.cyan(program.name())} --example ${chalk_1.default.green('hello-world')}`);
        console.error();
        console.error(`Run ${chalk_1.default.cyan(`${program.name()} --help`)} to see all options.`);
        process.exit(1);
    }
    await (0, create_project_1.createApp)({
        appPath: resolvedProjectPath,
        useYarn: !!opts.useYarn,
        example: example.trim(),
        examplePath: typeof opts.examplePath === 'string' ? opts.examplePath.trim() : undefined,
    });
}
const update = (0, update_check_1.default)(pkg_1.default).catch(() => null);
async function notifyUpdate() {
    try {
        const res = await update;
        if (res?.latest) {
            console.log();
            console.log(chalk_1.default.yellow.bold('A new version of `@temporalio/create` is available!'));
            console.log('You can update by running: ' +
                chalk_1.default.cyan(opts.useYarn ? 'yarn global add @temporalio/create' : 'npm i -g @temporalio/create'));
            console.log();
        }
        process.exit();
    }
    catch {
        // ignore error
    }
}
run()
    .then(notifyUpdate)
    .catch(async (reason) => {
    console.log();
    console.log('Aborting installation.');
    if (reason.command) {
        console.log(`  ${chalk_1.default.cyan(reason.command)} has failed.`);
    }
    else {
        console.log(chalk_1.default.red('Unexpected error. Please report it as a bug:'));
        console.log(reason);
    }
    console.log();
    await notifyUpdate();
    process.exit(1);
});
//# sourceMappingURL=index.js.map