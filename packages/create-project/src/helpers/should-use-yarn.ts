import { execSync } from 'child_process';

const COMMAND_NOT_FOUND_SH_CODE = 127;

export function shouldUseYarn(): boolean {
  try {
    const userAgent = process.env.npm_config_user_agent;
    if (userAgent) {
      return Boolean(userAgent && userAgent.startsWith('yarn'));
    }

    execSync('yarnpkg --version', { stdio: 'ignore' });
    return true;
  } catch (e: any) {
    if (e.status === COMMAND_NOT_FOUND_SH_CODE || /not found/i.test(e.message)) {
      return false;
    }

    throw e;
  }
}
