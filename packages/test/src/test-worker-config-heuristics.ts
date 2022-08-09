import test, { ExecutionContext } from 'ava';
import * as sinon from 'sinon';
import { addDefaultWorkerOptions } from '@temporalio/worker/lib/worker-options';
import { GiB } from '@temporalio/worker/lib/utils';
import type * as V8Type from 'v8';
import type * as OsType from 'os';

test.serial('maxCachedWorkflows heuristic', (t) => {
  mockMachineEnvironment(t, { totalMem: 4 * GiB });
  t.is(250, addDefaultWorkerOptions({ taskQueue: 'dummy ' }).maxCachedWorkflows);
});

test.serial('maxCachedWorkflows heuristic - large', (t) => {
  mockMachineEnvironment(t, { totalMem: 64 * GiB, heapSizeLimit: 4 * GiB });
  t.is(750, addDefaultWorkerOptions({ taskQueue: 'dummy ' }).maxCachedWorkflows);
});

function mockMachineEnvironment(t: ExecutionContext, mockedStats: { totalMem: number; heapSizeLimit?: number }) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const v8 = require('v8') as typeof V8Type;
  const getHeapStatisticsStub = sinon.stub(v8, 'getHeapStatistics').returns({
    ...v8.getHeapStatistics(),

    // NodeJS defaults to 25% of the computer total memory (ie. not the container's memory limit)
    heap_size_limit: mockedStats.heapSizeLimit ?? Math.floor(mockedStats.totalMem * 0.25),
  });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require('os') as typeof OsType;
  const totalMemStub = sinon.stub(os, 'totalmem').returns(mockedStats.totalMem);

  t.teardown(() => {
    getHeapStatisticsStub.restore();
    totalMemStub.restore();
  });
}
