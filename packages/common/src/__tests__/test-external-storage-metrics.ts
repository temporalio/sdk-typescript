import test from 'ava';

import { ExternalStorageMetricsAccumulator } from '../internal-non-workflow/external-storage-metrics';

/** Milliseconds encoded in a proto Duration. */
function durationMs(metrics: ReturnType<ExternalStorageMetricsAccumulator['toProto']>): number {
  const d = metrics!.totalDuration!;
  return (d.seconds as { toNumber(): number }).toNumber() * 1000 + (d.nanos ?? 0) / 1e6;
}

test('empty accumulator yields no metrics', (t) => {
  t.is(new ExternalStorageMetricsAccumulator().toProto(), undefined);
});

test('aggregates count, size, and driver names', (t) => {
  const acc = new ExternalStorageMetricsAccumulator();
  acc.record('s3', 2, 1024, 0, 100);
  acc.record('gcs', 3, 2048, 0, 100);
  acc.record('s3', 1, 512, 0, 100); // same driver again -> deduped in names
  const m = acc.toProto()!;
  t.is(m.payloadCount!.toNumber(), 6);
  t.is(m.totalSizeBytes!.toNumber(), 3584);
  t.deepEqual(m.driverNames, ['gcs', 's3']); // sorted
});

test('duration counts overlapping operations once (no double-count)', (t) => {
  const acc = new ExternalStorageMetricsAccumulator();
  // Two fully-concurrent 100ms operations. Summing segments would give 200ms; the real
  // wall-clock is 150ms.
  acc.record('s3', 1, 1, 0, 100);
  acc.record('gcs', 1, 1, 50, 150);
  t.is(durationMs(acc.toProto()), 150);
});

test('duration sums genuinely-disjoint operations', (t) => {
  const acc = new ExternalStorageMetricsAccumulator();
  acc.record('s3', 1, 1, 0, 100);
  acc.record('s3', 1, 1, 200, 300); // gap between ops is not counted
  t.is(durationMs(acc.toProto()), 200);
});

test('duration merges adjacent and nested operations', (t) => {
  const acc = new ExternalStorageMetricsAccumulator();
  acc.record('s3', 1, 1, 0, 100);
  acc.record('s3', 1, 1, 100, 200); // adjacent
  acc.record('s3', 1, 1, 120, 180); // nested inside the merged span
  t.is(durationMs(acc.toProto()), 200);
});
