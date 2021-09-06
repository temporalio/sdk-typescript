import retry from 'async-retry';
import chalk from 'chalk';
import path from 'path';
import {
  downloadAndExtractExample,
  downloadAndExtractRepo,
  getRepoInfo,
  hasExample,
  hasRepo,
  RepoInfo,
} from './helpers/examples';
import { makeDir } from './helpers/make-dir';
import { tryGitInit } from './helpers/git';
import { install } from './helpers/install';
import { isFolderEmpty } from './helpers/is-folder-empty';
import { getOnline } from './helpers/is-online';
// import { shouldUseYarn } from './helpers/should-use-yarn';
import { isWriteable } from './helpers/is-writeable';

export class DownloadError extends Error {}

export async function createApp({
  appPath,
  useYarn,
  example,
  examplePath,
}: {
  appPath: string;
  useYarn: boolean;
  example: string;
  examplePath?: string;
}): Promise<void> {
  let repoInfo: RepoInfo | undefined;

  if (example) {
    let repoUrl: URL | undefined;

    try {
      repoUrl = new URL(example);
    } catch (error: any) {
      if (error.code !== 'ERR_INVALID_URL') {
        console.error(error);
        process.exit(1);
      }
    }

    if (repoUrl) {
      if (repoUrl.origin !== 'https://github.com') {
        console.error(
          `Invalid URL: ${chalk.red(
            `"${example}"`
          )}. Only GitHub repositories are supported. Please use a GitHub URL and try again.`
        );
        process.exit(1);
      }

      repoInfo = await getRepoInfo(repoUrl, examplePath);

      if (!repoInfo) {
        console.error(`Found invalid GitHub URL: ${chalk.red(`"${example}"`)}. Please fix the URL and try again.`);
        process.exit(1);
      }

      const found = await hasRepo(repoInfo);

      if (!found) {
        console.error(
          `Could not locate the repository for ${chalk.red(
            `"${example}"`
          )}. Please check that the repository exists and try again.`
        );
        process.exit(1);
      }
    } else if (example !== '__internal-testing-retry') {
      const found = await hasExample(example);

      if (!found) {
        console.error(
          `Could not locate an example named ${chalk.red(`"${example}"`)}. It could be due to the following:\n`,
          `1. Your spelling of example ${chalk.red(`"${example}"`)} might be incorrect.\n`,
          `2. You might not be connected to the internet.`
        );
        process.exit(1);
      }
    }
  }

  const root = path.resolve(appPath);

  if (!(await isWriteable(path.dirname(root)))) {
    console.error('The application path is not writable, please check folder permissions and try again.');
    console.error('It is likely you do not have write permissions for this folder.');
    process.exit(1);
  }

  const appName = path.basename(root);

  await makeDir(root);
  if (!isFolderEmpty(root, appName)) {
    process.exit(1);
  }

  const isOnline = !useYarn || (await getOnline());
  const originalDirectory = process.cwd();

  const displayedCommand = useYarn ? 'yarn' : 'npm';
  console.log(`Creating a new Temporal project in ${chalk.green(root)}/.`);
  console.log();

  await makeDir(root);
  process.chdir(root);

  /**
   * If an example repository is provided, clone it.
   */
  try {
    if (repoInfo) {
      const repoInfo2 = repoInfo;
      console.log(`Downloading files from repo ${chalk.cyan(example)}. This might take a moment.`);
      console.log();
      await retry(() => downloadAndExtractRepo(root, repoInfo2), {
        retries: 3,
      });
    } else {
      console.log(`Downloading files for example ${chalk.cyan(example)}. This might take a moment.`);
      console.log();
      await retry(() => downloadAndExtractExample(root, example), {
        retries: 3,
      });
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

  await install(root, null, { useYarn, isOnline });
  console.log();

  if (tryGitInit(root)) {
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
      `If you haven't run Temporal Server before, visit:\nhttps://docs.temporal.io/docs/node/getting-started/`
    )
  );
  console.log();
  console.log(`Then, in the ${chalk.bold(cdpath + '/')} directory, using three other shells, run these commands:`);
  console.log();
  console.log(`  ${chalk.cyan(`${displayedCommand} ${useYarn ? '' : 'run '}build.watch`)}`);
  console.log(`  ${chalk.cyan(`${displayedCommand} ${useYarn ? '' : 'run '}start.watch`)}`);
  console.log(`  ${chalk.cyan(`${displayedCommand} ${useYarn ? '' : 'run '}workflow`)}`);
  console.log();
}
