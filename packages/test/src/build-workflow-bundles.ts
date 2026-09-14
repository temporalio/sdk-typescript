import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '@temporalio/common';
import { bundleWorkflowCode } from '@temporalio/worker/lib/workflow/bundler';
import {
  getTestWorkflowBundleCatalog,
  workflowBundleCacheDirectory,
  workflowBundleCacheFilename,
  workflowBundleManifestPath,
} from './workflow-bundle-cache';

interface BundleReport {
  bundle: string;
  workflowsPath: string;
  workflowInterceptorModules?: string[];
  payloadConverterPath?: string;
  failureConverterPath?: string;
  preloadModules?: string[];
  durationMs: number;
  bytes: number;
}

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
  const started = Date.now();
  const catalog = getTestWorkflowBundleCatalog();
  const reports: BundleReport[] = [];

  rmSync(workflowBundleCacheDirectory, { force: true, recursive: true });
  mkdirSync(workflowBundleCacheDirectory, { recursive: true });

  console.log(`Prebuilding ${catalog.length} test Workflow bundles...`);
  for (const [index, options] of catalog.entries()) {
    const bundleStarted = Date.now();
    const { code } = await bundleWorkflowCode({ ...options, logger });
    const bundle = workflowBundleCacheFilename(options);
    writeFileSync(path.join(workflowBundleCacheDirectory, bundle), code);
    const report = {
      bundle,
      workflowsPath: displayPath(options.workflowsPath),
      workflowInterceptorModules: options.workflowInterceptorModules?.map(displayPath),
      payloadConverterPath: options.payloadConverterPath && displayPath(options.payloadConverterPath),
      failureConverterPath: options.failureConverterPath && displayPath(options.failureConverterPath),
      preloadModules: options.preloadModules?.map(displayPath),
      durationMs: Date.now() - bundleStarted,
      bytes: Buffer.byteLength(code),
    };
    reports.push(report);
    console.log(
      `[${index + 1}/${catalog.length}] ${report.workflowsPath} -> ${bundle} (${report.durationMs}ms, ${
        report.bytes
      } bytes)`
    );
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    bundleCount: reports.length,
    totalBytes: reports.reduce((total, report) => total + report.bytes, 0),
    bundles: reports,
  };
  writeFileSync(workflowBundleManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `Prebuilt ${manifest.bundleCount} test Workflow bundles in ${manifest.durationMs}ms (${manifest.totalBytes} bytes total).`
  );
  console.log(`Bundle timing report: ${workflowBundleManifestPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
