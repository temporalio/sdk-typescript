Workers that set no poller options and are not auto-enrolled now use core's default of a 5-poller maximum instead of `min(10, maxConcurrent*Executions)`, matching the other SDKs.
