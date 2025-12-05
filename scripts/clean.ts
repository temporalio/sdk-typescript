import { resolve } from 'node:path';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import arg from 'arg';
import { parse as parseJson5 } from 'json5';

const packagesPath = resolve(__dirname, '../packages');

function cleanTsGeneratedFiles() {
  for (const pkg of readdirSync(packagesPath)) {
    const packagePath = resolve(packagesPath, pkg);

    let files;
    try {
      files = readdirSync(packagePath);
    } catch (e: unknown) {
      // Skip over non-directory files like .DS_Store
      if ((e as NodeJS.ErrnoException)?.code === 'ENOTDIR') {
        continue;
      } else {
        throw e;
      }
    }

    for (const file of files) {
      if (/^tsconfig(.*).json$/.test(file)) {
        const filePath = resolve(packagePath, file);
        const tsconfig = parseJson5(readFileSync(filePath, 'utf8'));
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
  rmSync(resolve(protosOutputDir, 'json-module.js'), { force: true });
  rmSync(resolve(protosOutputDir, 'root.d.ts'), { force: true });
}

function cleanCompiledRustFiles() {
  const bridgeDir = resolve(packagesPath, 'core-bridge');
  console.log('Cleaning compiled rust files');
  rmSync(resolve(bridgeDir, 'releases'), { recursive: true, force: true });
  spawnSync('cargo', ['clean'], { cwd: bridgeDir, stdio: 'inherit' });
}

const { '--only': only } = arg({ '--only': [String] });
const components = new Set(only === undefined || only.length === 0 ? ['ts', 'proto', 'rust'] : only);
if (components.has('ts')) cleanTsGeneratedFiles();
if (components.has('proto')) cleanProtoGeneratedFiles();
if (components.has('rust')) cleanCompiledRustFiles();
