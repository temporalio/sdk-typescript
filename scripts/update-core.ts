import { resolve } from 'node:path';
import { changelogTool, corePath, repoRoot } from './changelog';
import { ChildProcessError, run } from './utils';

const args = process.argv.slice(2);
const cwd = resolve(repoRoot, 'packages/core-bridge');
const cargo = run({ command: 'cargo', cwd, stdio: 'inherit' });

if (args.includes('--help') || args.includes('-h')) {
  changelogTool`update-core --help`;
} else {
  changelogTool`update-core --submodule ${corePath} ${args}`;
  try {
    cargo`fetch`;
  } catch (error) {
    if (error instanceof ChildProcessError) {
      throw new Error(`Bridge lockfile refresh failed (${error.code ?? error.signal})`);
    }
    throw error;
  }
}
