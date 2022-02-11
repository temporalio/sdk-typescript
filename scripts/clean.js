const { resolve } = require('path');
const { readdirSync } = require('fs');
const { spawnSync } = require('child_process');
const { removeSync, readFileSync } = require('fs-extra');
const arg = require('arg');
const JSON5 = require('json5');

const packagesPath = resolve(__dirname, '../packages');
const workerDir = resolve(packagesPath, 'worker');
const bridgeDir = resolve(packagesPath, 'core-bridge');

function cleanTsGeneratedFiles() {
  for (const package of readdirSync(packagesPath)) {
    const packagePath = resolve(packagesPath, package);

    let files;
    try {
      files = readdirSync(packagePath);
    } catch (e) {
      // Skip over non-directory files like .DS_Store
      if (e?.code === 'ENOTDIR') {
        continue;
      } else {
        throw e;
      }
    }

    for (const file of files) {
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
  const protosOutputDir = resolve(packagesPath, 'proto/lib');
  console.log(`Removing generated files in ${protosOutputDir}`);
  removeSync(resolve(protosOutputDir, 'coresdk.js'));
  removeSync(resolve(protosOutputDir, 'coresdk.d.ts'));
  removeSync(resolve(protosOutputDir, 'temporal.js'));
  removeSync(resolve(protosOutputDir, 'temporal.d.ts'));
}

function cleanCompiledRustFiles() {
  console.log('Cleaning compiled rust files');
  removeSync(resolve(bridgeDir, 'releases'));
  removeSync(resolve(bridgeDir, 'index.node'));
  spawnSync('cargo', ['clean'], { cwd: bridgeDir, stdio: 'inherit' });
}

const { '--only': only } = arg({ '--only': [String] });
const components = new Set(only === undefined || only.length === 0 ? ['ts', 'proto', 'rust', 'cpp'] : only);
if (components.has('ts')) cleanTsGeneratedFiles();
if (components.has('proto')) cleanProtoGeneratedFiles();
if (components.has('rust')) cleanCompiledRustFiles();
