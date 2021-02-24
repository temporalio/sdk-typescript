/// Clean all typescript generated files
const { resolve } = require('path');
const { readdirSync } = require('fs');
const { removeSync, readFileSync } = require('fs-extra');
const JSON5 = require('json5');

// "clean": "TODO: find packages -name '*.tsbuildinfo' -delete && find . -name lib -maxdepth 2 | xargs rm -rf"
const packagesPath = resolve(__dirname, '../packages');
for (const package of readdirSync(packagesPath)) {
  const packagePath = resolve(packagesPath, package);
  for (const file of readdirSync(packagePath)) {
    if (/^tsconfig(.*).json$/.test(file)) {
      const filePath = resolve(packagePath, file);
      const tsconfig = JSON5.parse(readFileSync(filePath));
      const { outDir } = tsconfig.compilerOptions;
      if (outDir) {
        const outPath = resolve(packagePath, outDir);
        console.log(`Removing ${outPath}`);
        removeSync(outPath);
        const buildInfoPath = filePath.replace(/json$/, 'tsbuildinfo');
        console.log(`Removing ${buildInfoPath}`);
        removeSync(buildInfoPath);
      }
    }
  }
}
