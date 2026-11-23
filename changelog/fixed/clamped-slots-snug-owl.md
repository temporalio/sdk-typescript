Fix `maxConcurrentWorkflowTaskExecutions` not being capped to `maxCachedWorkflows` (or raised to a minimum of 2) when the cache is enabled; the worker previously started with the raw value.
