#!/usr/bin/env node

// Modified from: https://github.com/vercel/next.js/blob/2425f4703c4c6164cecfdb6aa8f80046213f0cc6/packages/create-next-app/index.ts

import chalk from 'chalk';
import Commander from 'commander';
import path from 'path';
import prompts from 'prompts';
import checkForUpdate from 'update-check';
import { createApp } from './create-project';
import { shouldUseYarn } from './helpers/should-use-yarn';
import { validateNpmName } from './helpers/validate-pkg';
import packageJson from '../package.json';

const program = new Commander.Command(packageJson.name)
  .version(packageJson.version, '-v, --version')
  .arguments('<project-directory>')
  .usage(`${chalk.green('<project-directory>')} [options]`)
  .option(
    '--use-yarn',
    `

  Use yarn instead of npm
`
  )
  .option(
    '-e, --example [name]|[github-url]',
    `

  An example to bootstrap the app with. You can use an example name
  from https://github.com/temporalio/samples-node or a GitHub URL. 
  The URL can use any branch and/or subdirectory
`
  )
  .option(
    '--example-path <path-to-example>',
    `

  In a rare case, your GitHub URL might contain a branch name with
  a slash (e.g. bug/fix-1) and the path to the example (e.g. foo/bar).
  In this case, you must specify the path to the example separately:
  --example-path foo/bar
`
  )
  .allowUnknownOption()
  .parse(process.argv);

async function run(): Promise<void> {
  let projectPath = program.args[0];

  if (typeof projectPath === 'string') {
    projectPath = projectPath.trim();
  }

  if (!projectPath) {
    const res = await prompts({
      type: 'text',
      name: 'path',
      message: 'What is your project named?',
      initial: 'my-temporal',
      validate: (name) => {
        const validation = validateNpmName(path.basename(path.resolve(name)));
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
    console.error(`  ${chalk.cyan(program.name())} ${chalk.green('<project-directory>')}`);
    console.error();
    console.error('For example:');
    console.error(`  ${chalk.cyan(program.name())} ${chalk.green('my-temporal-project')}`);
    console.error();
    console.error(`Run ${chalk.cyan(`${program.name()} --help`)} to see all options.`);
    process.exit(1);
  }

  const resolvedProjectPath = path.resolve(projectPath);
  const projectName = path.basename(resolvedProjectPath);

  const { valid, problems } = validateNpmName(projectName);
  if (!valid) {
    console.error(
      `Could not create a project called ${chalk.red(`"${projectName}"`)} because of npm naming restrictions:`
    );

    problems?.forEach((p) => console.error(`    ${chalk.red.bold('*')} ${p}`));
    process.exit(1);
  }

  let example = program.example;

  // `example` is true when --example is used by itself
  if (typeof example !== 'string') {
    const res = await prompts({
      type: 'text',
      name: 'example',
      message: 'Which template would you like to use?',
      initial: 'hello-world',
      // validate: (name) => {
      //   const validation = validateNpmName(path.basename(path.resolve(name)));
      //   if (validation.valid) {
      //     return true;
      //   }
      //   return 'Invalid project name: ' + validation.problems![0];
      // },
    });

    if (typeof res.example === 'string') {
      example = res.example;
    }
  }

  if (typeof example !== 'string') {
    console.error();
    console.error('Please specify which example:');
    console.error(`  ${chalk.cyan(program.name())} --example ${chalk.green('[name]|[github-url]')}`);
    console.error();
    console.error('For example:');
    console.error(`  ${chalk.cyan(program.name())} --example ${chalk.green('hello-world')}`);
    console.error();
    console.error(`Run ${chalk.cyan(`${program.name()} --help`)} to see all options.`);
    process.exit(1);
  }

  await createApp({
    appPath: resolvedProjectPath,
    useYarn: !!program.useYarn,
    example: example.trim(),
    examplePath: typeof program.examplePath === 'string' ? program.examplePath.trim() : undefined,
  });
}

const update = checkForUpdate(packageJson).catch(() => null);

async function notifyUpdate(): Promise<void> {
  try {
    const res = await update;
    if (res?.latest) {
      const isYarn = shouldUseYarn();

      console.log();
      console.log(chalk.yellow.bold('A new version of `@temporalio/create` is available!'));
      console.log(
        'You can update by running: ' +
          chalk.cyan(isYarn ? 'yarn global add @temporalio/create' : 'npm i -g @temporalio/create')
      );
      console.log();
    }
    process.exit();
  } catch {
    // ignore error
  }
}

run()
  .then(notifyUpdate)
  .catch(async (reason) => {
    console.log();
    console.log('Aborting installation.');
    if (reason.command) {
      console.log(`  ${chalk.cyan(reason.command)} has failed.`);
    } else {
      console.log(chalk.red('Unexpected error. Please report it as a bug:'));
      console.log(reason);
    }
    console.log();

    await notifyUpdate();

    process.exit(1);
  });
