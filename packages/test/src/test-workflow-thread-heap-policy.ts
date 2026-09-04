import test from 'ava';
import { getWorkflowHeapEvictionBatchSize } from '@temporalio/worker/lib/workflow/workflow-thread-heap-policy';

test('does not evict below the high watermark', (t) => {
  t.is(getWorkflowHeapEvictionBatchSize(799, 1000, 100), 0);
});

test('evicts a bounded batch toward the low watermark', (t) => {
  t.is(getWorkflowHeapEvictionBatchSize(800, 1000, 100), 13);
  t.is(getWorkflowHeapEvictionBatchSize(900, 1000, 100), 23);
});

test('evicts at least one idle Workflow and never more than are idle', (t) => {
  t.is(getWorkflowHeapEvictionBatchSize(800, 1000, 1), 1);
  t.is(getWorkflowHeapEvictionBatchSize(2000, 1000, 10), 7);
  t.is(getWorkflowHeapEvictionBatchSize(2000, 1000, 0), 0);
});
