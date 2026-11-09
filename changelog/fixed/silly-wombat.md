Preserve the primary error that terminated `Worker.run()` when shutdown finalization fails, logging the cleanup error instead of masking the root cause with `IllegalStateError`.
