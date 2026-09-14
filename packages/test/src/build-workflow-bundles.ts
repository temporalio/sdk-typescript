import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '@temporalio/common';
import { bundleWorkflowCode } from '@temporalio/worker/lib/workflow/bundler';
import {
  getTestWorkflowBundleCatalog,
  workflowBundleCacheDirectory,
  workflowBundleCacheFilename,
} from './workflow-bundle-cache';

const logger: Logger = {
  log: () => undefined,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: (message, meta) => console.warn(message, meta ?? ''),
  error: (message, meta) => console.error(message, meta ?? ''),
};

function displayPath(modulePath: string): string {
  const relativePath = path.relative(__dirname, modulePath);
  return relativePath.startsWith('..') ? modulePath : relativePath;
}

async function main(): Promise<void> {
  const catalog = getTestWorkflowBundleCatalog();

  rmSync(workflowBundleCacheDirectory, { force: true, recursive: true });
  mkdirSync(workflowBundleCacheDirectory, { recursive: true });

  console.log(`Prebuilding ${catalog.length} test Workflow bundles...`);
  for (const [index, options] of catalog.entries()) {
    const { code } = await bundleWorkflowCode({ ...options, logger });
    const bundle = workflowBundleCacheFilename(options);
    writeFileSync(path.join(workflowBundleCacheDirectory, bundle), code);
    console.log(`[${index + 1}/${catalog.length}] ${displayPath(options.workflowsPath)} -> ${bundle}`);
  }

  console.log(`Prebuilt ${catalog.length} test Workflow bundles.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
