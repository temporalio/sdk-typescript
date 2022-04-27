import { resolve } from 'node:path';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { URL, fileURLToPath } from 'node:url';
import arg from 'arg';
import JSON5 from 'json5';
import * as testing from '../packages/testing/scripts/common.mjs';

const packagesPath = fileURLToPath(new URL('../packages', import.meta.url));

function cleanTsGeneratedFiles() {
  for (const pkg of readdirSync(packagesPath)) {
    const packagePath = resolve(packagesPath, pkg);

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
          rmSync(outPath, { recursive: true, force: true });
          const buildInfoPath = filePath.replace(/json$/, 'tsbuildinfo');
          console.log(`Removing ${buildInfoPath}`);
          rmSync(buildInfoPath, { recursive: true, force: true });
        }
      }
    }
  }
}

function cleanProtoGeneratedFiles() {
  const protosOutputDir = resolve(packagesPath, 'proto/protos');
  console.log(`Removing generated files in ${protosOutputDir}`);
  rmSync(resolve(protosOutputDir, 'json-module.js'));
  rmSync(resolve(protosOutputDir, 'root.d.ts'));
}

function cleanCompiledRustFiles() {
  const bridgeDir = resolve(packagesPath, 'core-bridge');
  console.log('Cleaning compiled rust files');
  rmSync(resolve(bridgeDir, 'releases'), { recursive: true, force: true });
  spawnSync('cargo', ['clean'], { cwd: bridgeDir, stdio: 'inherit' });
}

function cleanTestServer() {
  console.log(`Removing test server executable at ${testing.outputPath}`);
  rmSync(testing.outputPath, { force: true });
  const protosOutputDir = resolve(packagesPath, 'testing/generated-protos');
  console.log(`Removing generated files in ${protosOutputDir}`);
  rmSync(protosOutputDir, { recursive: true, force: true });
}

const { '--only': only } = arg({ '--only': [String] });
const components = new Set(only === undefined || only.length === 0 ? ['ts', 'proto', 'rust', 'test-server'] : only);
if (components.has('ts')) cleanTsGeneratedFiles();
if (components.has('proto')) cleanProtoGeneratedFiles();
if (components.has('rust')) cleanCompiledRustFiles();
if (components.has('test-server')) cleanTestServer();
