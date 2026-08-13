/**
 * Tracks which SDK test files are ready to run against Temporal Cloud.
 *
 * Files with a suffix listed in `cloudExclusions` are omitted from the Cloud run. All other test
 * files are Cloud candidates. By default this script prints the exclusion inventory;
 * `--cloud-files` prints the corresponding compiled paths for CI to pass to AVA.
 */
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const testRoot = join(__dirname, '..', 'packages', 'test', 'src');

interface CloudExclusion {
  reason: string;
  suffix: string;
}

// Files without one of these suffixes are assumed to be ready for Cloud.
const cloudExclusions: readonly CloudExclusion[] = [
  { reason: 'Local only', suffix: '.local.ts' },
  { reason: 'Cloud unavailable', suffix: '.cloud-unavailable.ts' },
  { reason: 'Needs Cloud adaptation', suffix: '.cloud-pending.ts' },
];

async function findTestFiles(directory: string): Promise<string[]> {
  const testFiles: string[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      testFiles.push(...(await findTestFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.startsWith('test-') && entry.name.endsWith('.ts')) {
      testFiles.push(fullPath);
    }
  }

  return testFiles;
}

function isCloudReady(file: string): boolean {
  return !cloudExclusions.some(({ suffix }) => file.endsWith(suffix));
}

function toCompiledTestPath(file: string): string {
  const sourcePath = relative(testRoot, file).replaceAll('\\', '/');
  return `./lib/${sourcePath.replace(/\.ts$/, '.js')}`;
}

/** Return the compiled AVA paths for every Cloud-eligible test file. */
export async function findCloudTestFiles(): Promise<string[]> {
  const testFiles = (await findTestFiles(testRoot)).sort();
  const cloudFiles = testFiles.filter(isCloudReady).map(toCompiledTestPath);

  if (cloudFiles.length === 0) throw new Error('No Cloud test files found');
  return cloudFiles;
}

async function main(): Promise<void> {
  const [option, ...unexpectedArguments] = process.argv.slice(2);
  if (unexpectedArguments.length > 0 || (option !== undefined && option !== '--cloud-files')) {
    throw new Error('Usage: cloud-test-inventory.ts [--cloud-files]');
  }

  const testFiles = (await findTestFiles(testRoot)).sort();
  const cloudFiles = testFiles.filter(isCloudReady);

  if (option === '--cloud-files') {
    if (cloudFiles.length === 0) throw new Error('No Cloud test files found');
    console.log(cloudFiles.map(toCompiledTestPath).join('\n'));
    return;
  }

  console.log(`Cloud candidates: ${cloudFiles.length}`);
  console.log('Tests not ready for Cloud:');

  for (const exclusion of cloudExclusions) {
    const excludedFiles = testFiles.filter((file) => file.endsWith(exclusion.suffix));
    console.log(`  ${exclusion.reason} (${excludedFiles.length})`);

    for (const file of excludedFiles) {
      console.log(`    ${relative(process.cwd(), file)}`);
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
