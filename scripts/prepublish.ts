import fs from 'node:fs/promises';
import path, { resolve } from 'node:path';
import { version } from '../lerna.json';

async function main() {
  const rootPath = resolve(__dirname, '..');
  const packagesPath = path.join(rootPath, 'packages');

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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
