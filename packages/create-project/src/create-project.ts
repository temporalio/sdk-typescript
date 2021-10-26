// Modified from: https://github.com/vercel/next.js/blob/2425f4703c4c6164cecfdb6aa8f80046213f0cc6/packages/create-next-app/create-app.ts
import retry from 'async-retry';
import chalk from 'chalk';
import path from 'path';
import prompts from 'prompts';
import { access } from 'fs/promises';
import {
  downloadAndExtractSample,
  downloadAndExtractRepo,
  getRepoInfo,
  hasSample,
  checkForPackageJson,
  RepoInfo,
} from './helpers/samples';
import { makeDir } from './helpers/make-dir';
import { tryGitInit } from './helpers/git';
import { install, updateNodeVersion, replaceTemporalVersion } from './helpers/install';
import { testIfThisComputerIsOnline } from './helpers/is-online';
import { isWriteable } from './helpers/is-writeable';
import { getErrorCode } from './helpers/get-error-code';
import { stripSnipComments } from './helpers/strip-snip-comments';

export class DownloadError extends Error {}

export async function createApp({
  appPath,
  useYarn,
  gitInit,
  temporalioVersion,
  sample,
  samplePath,
}: {
  appPath: string;
  useYarn: boolean;
  gitInit?: boolean;
  temporalioVersion?: string;
  sample: string;
  samplePath?: string;
}): Promise<void> {
  let repoInfo: RepoInfo | undefined;
  let repoUrl: URL | undefined;

  const isOnline = await testIfThisComputerIsOnline();
  if (!isOnline) {
    console.error(`Unable to reach ${chalk.bold(`github.com`)}. Perhaps you are not connected to the internet?`);
    process.exit(1);
  }

  try {
    repoUrl = new URL(sample);
  } catch (error) {
    if (getErrorCode(error) !== 'ERR_INVALID_URL') {
      console.error(error);
      process.exit(1);
    }
  }

  if (repoUrl) {
    if (repoUrl.origin !== 'https://github.com') {
      console.error(
        `Invalid URL: ${chalk.red(
          `"${sample}"`
        )}. Only GitHub repositories are supported. Please use a GitHub URL and try again.`
      );
      process.exit(1);
    }

    try {
      repoInfo = await getRepoInfo(repoUrl, samplePath);
      await checkForPackageJson(repoInfo);
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  } else if (sample !== '__internal-testing-retry') {
    const found = await hasSample(sample);

    if (!found) {
      console.error(
        `Could not locate a sample named ${chalk.red(`"${sample}"`)}. It could be due to the following:\n`,
        `1. Your spelling of sample ${chalk.red(`"${sample}"`)} might be incorrect.\n`,
        `2. You might not be connected to the internet.`
      );
      process.exit(1);
    }
  }

  const root = path.resolve(appPath);

  if (!(await isWriteable(path.dirname(root)))) {
    console.error('The application path is not writable, please check folder permissions and try again.');
    console.error('It is likely you do not have write permissions for this folder.');
    process.exit(1);
  }

  const appName = path.basename(root);

  const originalDirectory = process.cwd();

  const displayedCommand = useYarn ? 'yarn' : 'npm';
  console.log(`Creating a new Temporal project in ${chalk.green(root)}/`);
  console.log();

  let directoryExists = true;

  try {
    await access(root);
  } catch (error: any) {
    const code = getErrorCode(error);

    if (code === 'ENOENT') {
      directoryExists = false;
    } else if (code === 'EACCES') {
      console.error(`Unable to access directory ${chalk.bold(root + '/')} (Error: permission denied)`);
      process.exit(1);
    } else {
      throw error;
    }
  }

  if (directoryExists) {
    const res = await prompts({
      type: 'confirm',
      name: 'shouldReplace',
      message: `Directory ${chalk.green(root + '/')} already exists. Would you like to replace it?`,
    });

    if (!res.shouldReplace) {
      console.error('Exiting. You can re-run this command with a different project name.');
      process.exit(1);
    }
  }

  try {
    await makeDir(root);
  } catch (error) {
    if (getErrorCode(error) === 'EACCES') {
      console.error(`Unable to cd into directory ${chalk.bold(root + '/')} (Error: permission denied)`);
      process.exit(1);
    } else {
      throw error;
    }
  }

  /**
   * If a sample repository is provided, clone it.
   */
  try {
    if (repoInfo) {
      const repoInfo2 = repoInfo;
      console.log(`Downloading files from repo ${chalk.cyan(sample)}. This might take a moment.`);
      console.log();
      await retry(() => downloadAndExtractRepo(root, repoInfo2), {
        retries: 3,
      });
    } else {
      console.log(`Downloading files for sample ${chalk.cyan(sample)}. This might take a moment.`);
      console.log();
      await retry(() => downloadAndExtractSample(root, sample), {
        retries: 3,
      });
      await stripSnipComments(root);
    }
  } catch (reason) {
    let message = 'Unable to download';
    if (reason instanceof Error) {
      message = reason.message;
    }

    throw new DownloadError(message);
  }

  console.log('Installing packages. This might take a couple of minutes.');
  console.log();

  await updateNodeVersion({ root });
  if (temporalioVersion) {
    await replaceTemporalVersion({ root, useYarn, temporalioVersion });
  }

  await install({ root, useYarn });

  console.log();

  if (await tryGitInit(root, gitInit)) {
    console.log('Initialized a git repository.');
    console.log();
  }

  let cdpath: string;
  if (path.join(originalDirectory, appName) === appPath) {
    cdpath = appName;
  } else {
    cdpath = appPath;
  }

  console.log(`${chalk.green('Success!')} Created ${chalk.bold(appName)} at ${chalk.bold(appPath + '/')}`);
  console.log();
  console.log('Inside that directory, you can run several commands:');
  console.log();
  console.log(chalk.cyan(`  ${displayedCommand} ${useYarn ? '' : 'run '}build`));
  console.log('    Builds all the code.');
  console.log();
  console.log(chalk.cyan(`  ${displayedCommand} start`));
  console.log('    Runs the built Worker.');
  console.log();
  console.log(chalk.cyan(`  ${displayedCommand} ${useYarn ? '' : 'run '}workflow`));
  console.log('    Starts a Workflow.');
  console.log();
  console.log('To begin development, start Temporal Server:');
  console.log();
  console.log(chalk.cyan('  cd'), '~/path/to/temporal/docker-compose/');
  console.log(`  ${chalk.cyan('docker-compose up')}`);
  console.log();
  console.log(
    chalk.dim.italic(
      `If you haven't run Temporal Server before, visit:\nhttps://docs.temporal.io/docs/typescript/getting-started/`
    )
  );
  console.log();
  console.log(`Then, in the ${chalk.bold(cdpath + '/')} directory, using two other shells, run these commands:`);
  console.log();
  console.log(`  ${chalk.cyan(`${displayedCommand} ${useYarn ? '' : 'run '}start.watch`)}`);
  console.log(`  ${chalk.cyan(`${displayedCommand} ${useYarn ? '' : 'run '}workflow`)}`);
  console.log();
}
