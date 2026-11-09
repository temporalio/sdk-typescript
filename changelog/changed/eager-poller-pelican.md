Workers that set no poller options and aren't auto-enrolled now default to a 5-poller maximum instead of `min(10, maxConcurrent*Executions)`, matching the other SDKs.
