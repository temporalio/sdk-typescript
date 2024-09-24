import fs from 'node:fs/promises';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const rootPath = fileURLToPath(new URL('..', import.meta.url));
const packagesPath = path.join(rootPath, 'packages');
const lernaJsonPath = path.join(rootPath, 'lerna.json');

const { version } = JSON.parse(await fs.readFile(lernaJsonPath, 'utf8'));

const packages = await fs.readdir(packagesPath);
for (const dir of packages) {
  const packageJsonPath = path.join(packagesPath, dir, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  for (const depType of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const dep of Object.keys(packageJson[depType] ?? {})) {
      if (dep.startsWith('@temporalio/')) {
        packageJson[depType][dep] = `${version}`;
      }
    }
  }
  const replacedContent = JSON.stringify(packageJson, null, 2);
  await fs.writeFile(packageJsonPath, replacedContent + '\n');
}
