const { resolve } = require('path');
const { readdirSync } = require('fs');
const { spawnSync } = require('child_process');
const { removeSync, readFileSync } = require('fs-extra');
const JSON5 = require('json5');

const packagesPath = resolve(__dirname, '../packages');
const workerDir = resolve(packagesPath, 'worker');

function cleanTsGeneratedFiles() {
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
}

function cleanProtoGeneratedFiles() {
  const protosOutputDir = resolve(packagesPath, 'proto');
  const commonjsOutputDir = resolve(protosOutputDir, 'commonjs');
  const es2020OutputDir = resolve(protosOutputDir, 'es2020');
  console.log(`Removing ${commonjsOutputDir}`);
  removeSync(commonjsOutputDir);
  console.log(`Removing ${es2020OutputDir}`);
  removeSync(es2020OutputDir);
}

function cleanCompiledRustFiles() {
  console.log('Cleaning compiled rust files');
  removeSync(resolve(workerDir, 'native/releases'));
  removeSync(resolve(workerDir, 'native/index.node'));
  spawnSync('cargo', ['clean'], { cwd: resolve(workerDir, 'native'), stdio: 'inherit' });
}

function cleanCompiledCppFiles() {
  console.log('Cleaning compiled C++ files');
  spawnSync('node-gyp', ['clean'], { cwd: workerDir, stdio: 'inherit' });
}

cleanTsGeneratedFiles();
cleanProtoGeneratedFiles();
cleanCompiledRustFiles();
cleanCompiledCppFiles();
