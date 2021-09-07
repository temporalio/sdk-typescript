/* eslint-disable no-empty */
// Modified from: https://github.com/vercel/next.js/blob/2425f4703c4c6164cecfdb6aa8f80046213f0cc6/packages/create-next-app/helpers/git.ts
import { execSync } from 'child_process';
import path from 'path';
import rimraf from 'rimraf';

const NOT_A_GIT_REPOSITORY_STATUS_CODE = 128;

function isInGitRepository(): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
    return true;
  } catch (error: any) {
    if (error.status === NOT_A_GIT_REPOSITORY_STATUS_CODE) {
      return false;
    } else {
      // Unknown error. To be safe, assume we're in a repo.
      return true;
    }
  }
}

const HG_ERROR_STATUS_CODE = 255;

function isInMercurialRepository(): boolean {
  try {
    execSync('hg --cwd . root', { stdio: 'ignore' });
    return true;
  } catch (error: any) {
    // There isn't anything more specific about `error` that we can pattern match against
    if (error.status === HG_ERROR_STATUS_CODE && /Command failed/.test(error.message)) {
      return false;
    } else {
      // Unknown error. To be safe, assume we're in a repo.
      return true;
    }
  }
}

export function tryGitInit(root: string): boolean {
  let didInit = false;
  try {
    execSync('git --version', { stdio: 'ignore' });
    if (isInGitRepository() || isInMercurialRepository()) {
      return false;
    }

    execSync('git init', { stdio: 'ignore' });
    didInit = true;

    execSync('git checkout -b main', { stdio: 'ignore' });

    execSync('git add -A', { stdio: 'ignore' });
    execSync('git commit -m "Initial commit from @temporalio/create"', {
      stdio: 'ignore',
    });
    return true;
  } catch (e) {
    if (didInit) {
      try {
        rimraf.sync(path.join(root, '.git'));
      } catch (_) {}
    }
    return false;
  }
}
