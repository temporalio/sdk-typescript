import fs from 'fs/promises';
import path from 'path';
import { URL, fileURLToPath } from 'url';

const rootPath = fileURLToPath(new URL('..', import.meta.url));
const packagesPath = path.join(rootPath, 'packages');
const lernaJsonPath = path.join(rootPath, 'lerna.json');

const { version } = JSON.parse(await fs.readFile(lernaJsonPath, 'utf8'));

const packages = await fs.readdir(packagesPath);
for (const dir of packages) {
  const packageJsonPath = path.join(packagesPath, dir, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  for (const dep of Object.keys(packageJson.dependencies)) {
    if (dep.startsWith('@temporalio/')) {
      packageJson.dependencies[dep] = `~${version}`;
    }
  }
  const replacedContent = JSON.stringify(packageJson, null, 2);
  await fs.writeFile(packageJsonPath, replacedContent + '\n');
}
