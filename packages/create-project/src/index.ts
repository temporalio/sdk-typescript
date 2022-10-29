// Modified from: https://github.com/vercel/next.js/blob/2425f4703c4c6164cecfdb6aa8f80046213f0cc6/packages/create-next-app/index.ts
import chalk from 'chalk';
import dedent from 'dedent';
import { Command } from 'commander';
import path from 'path';
// eslint-disable-next-line import/no-named-as-default
import prompts from 'prompts';
import checkForUpdate from 'update-check';

import { createApp } from './create-project.js';
import { validateNpmName } from './helpers/validate-pkg.js';
import { fetchSamples } from './helpers/fetch-samples.js';
import packageJson from './pkg.js';

const program = new Command(packageJson.name)
  .version(packageJson.version, '-v, --version', 'Print the version and exit')
  .arguments('[project-directory]')
  .usage(`${chalk.green('[project-directory]')} [options]`)
  .option(
    '-s, --sample <name|github-url>',
    dedent`
  Which sample to bootstrap the project with. You can use the name of a sample
  from https://github.com/temporalio/samples-typescript or use a GitHub URL. 
  The URL can have a branch and/or subdirectory—for example:
  https://github.com/temporalio/samples-typescript/tree/next/hello-world
`
  )
  .option(
    '--sample-path <path-to-sample>',
    dedent`
  In a rare case, your GitHub URL might contain a branch name with
  a slash (e.g. bug/fix-1) and the path to the sample (e.g. foo/bar).
  In this case, you must specify the path to the sample separately:
  --sample-path foo/bar
`
  )
  .option(
    '-l, --list-samples',
    dedent`
  Print available sample projects and exit
`
  )
  .option(
    '--use-yarn',
    dedent`
  Use yarn instead of npm
`
  )
  .option(
    '--git-init',
    dedent`
  Initialize a git repository
`
  )
  .option(
    '--no-git-init',
    dedent`
  Skip git repository initialization
`
  )
  .option(
    '--sdk-version <version>',
    dedent`
  Specify which version of the @temporalio/* npm packages to use
`
  )
  .allowUnknownOption()
  .parse(process.argv);

interface Options {
  useYarn?: boolean;
  gitInit?: boolean;
  listSamples?: boolean;
  sample?: string;
  samplePath?: string;
  sdkVersion?: string;
}

let opts: Options;

async function start(): Promise<void> {
  opts = program.opts();
  if (opts.listSamples) {
    const samples = await fetchSamples();
    console.log(`Available samples:\n\n${samples.join('\n')}\n`);
    return;
  }

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

  let sample = opts.sample;
  if (!sample) {
    const samples = await fetchSamples();
    const choices = samples.map((sample) => ({ title: sample, value: sample }));

    const res = await prompts({
      type: 'select',
      name: 'sample',
      message: `Which sample would you like to use?`,
      choices,
      initial: samples.indexOf('hello-world'),
    });

    if (typeof res.sample === 'string') {
      sample = res.sample;
    }
  }

  if (!sample) {
    console.error();
    console.error('Please specify which sample:');
    console.error(`  ${chalk.cyan(program.name())} --sample ${chalk.green('<name|github-url>')}`);
    console.error();
    console.error('For example:');
    console.error(`  ${chalk.cyan(program.name())} --sample ${chalk.green('hello-world')}`);
    console.error();
    console.error(`Run ${chalk.cyan(`${program.name()} --help`)} to see all options.`);
    process.exit(1);
  }

  await createApp({
    appPath: resolvedProjectPath,
    useYarn: !!opts.useYarn,
    gitInit: opts.gitInit,
    sdkVersion: opts.sdkVersion,
    sample: sample.trim(),
    samplePath: typeof opts.samplePath === 'string' ? opts.samplePath.trim() : undefined,
  });
}

const update = checkForUpdate(packageJson).catch(() => null);

async function notifyUpdate(): Promise<void> {
  try {
    const res = await update;
    if (res?.latest) {
      console.log();
      console.log(chalk.yellow.bold('A new version of `@temporalio/create` is available!'));
      console.log(
        'You can update by running: ' +
          chalk.cyan(opts.useYarn ? 'yarn global add @temporalio/create' : 'npm i -g @temporalio/create')
      );
      console.log();
    }
    process.exit();
  } catch {
    // ignore error
  }
}

export function run(): void {
  start()
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
}
