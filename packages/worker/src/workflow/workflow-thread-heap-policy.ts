export const WORKFLOW_HEAP_HIGH_WATERMARK = 0.8;
export const WORKFLOW_HEAP_LOW_WATERMARK = 0.7;

/** Return the size of the bounded LRU batch to evict at this heap-usage sample. */
export function getWorkflowHeapEvictionBatchSize(
  usedHeapSize: number,
  heapSizeLimit: number,
  idleWorkflowCount: number
): number {
  if (idleWorkflowCount === 0 || usedHeapSize < heapSizeLimit * WORKFLOW_HEAP_HIGH_WATERMARK) return 0;

  const fractionToEvict = Math.min(
    1,
    Math.max(1 / idleWorkflowCount, (usedHeapSize - heapSizeLimit * WORKFLOW_HEAP_LOW_WATERMARK) / usedHeapSize)
  );
  return Math.max(1, Math.ceil(idleWorkflowCount * fractionToEvict));
}
