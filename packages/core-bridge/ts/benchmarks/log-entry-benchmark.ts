/**
 * Quick-and-dirty benchmark comparing Neon object construction vs JSON serialization
 * for `LogEntry`. Intended for temporary local use only.
 *
 * Usage:
 *   npm run build-rust
 *   npx ts-node ts/benchmarks/log-entry-benchmark.ts
 */

import { performance } from 'node:perf_hooks';
import type * as NativeTypes from '..';

const { native } = require('../../index') as { native: typeof NativeTypes.native };

const ITERATIONS = 1_000;
const EXPECTED_BATCH_SIZE = 10;

type BenchmarkStats = {
  durationMs: number;
  checksum: number;
};

function warmUp(): void {
  native.generateBenchmarkLogEntries('direct');
  native.generateBenchmarkLogEntries('json');
}

function measureDirect(iterations: number): BenchmarkStats {
  let checksum = 0;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const result = native.generateBenchmarkLogEntries('direct');
    const entries = result.direct;
    if (!entries || entries.length !== EXPECTED_BATCH_SIZE) {
      throw new Error(`unexpected direct batch size: ${entries?.length ?? 0}`);
    }
    for (const entry of entries) {
      checksum += entry.message.length + entry.level.length;
      checksum += entry.spanContexts.length;
    }
  }
  return { durationMs: performance.now() - start, checksum };
}

function measureJson(iterations: number): BenchmarkStats {
  let checksum = 0;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const result = native.generateBenchmarkLogEntries('json');
    if (!result.json) {
      throw new Error('expected JSON payload but received null');
    }
    const parsed = JSON.parse(result.json);
    if (!Array.isArray(parsed) || parsed.length !== EXPECTED_BATCH_SIZE) {
      throw new Error(`unexpected JSON batch size: ${Array.isArray(parsed) ? parsed.length : 'non-array'}`);
    }
    for (const entry of parsed as { message?: string; level?: string; spanContexts?: unknown[] }[]) {
      checksum += (entry.message ?? '').length + (entry.level ?? '').length;
      if (Array.isArray(entry.spanContexts)) {
        checksum += entry.spanContexts.length;
      }
    }
  }
  return { durationMs: performance.now() - start, checksum };
}

function formatMs(value: number): string {
  return `${value.toFixed(3)} ms`;
}

function main(): void {
  warmUp();

  const direct = measureDirect(ITERATIONS);
  const json = measureJson(ITERATIONS);

  const directAvg = direct.durationMs / ITERATIONS;
  const jsonAvg = json.durationMs / ITERATIONS;

  console.log('LogEntry Benchmark');
  console.log('==================');
  console.log(`Direct (Neon) total: ${formatMs(direct.durationMs)} | per call (avg): ${formatMs(directAvg)}`);
  console.log(`JSON serialize total: ${formatMs(json.durationMs)} | per call (avg): ${formatMs(jsonAvg)}`);
  console.log('');
  console.log(`Checksums (ignore, just to anchor JIT): direct=${direct.checksum} json=${json.checksum}`);
}

void main();
