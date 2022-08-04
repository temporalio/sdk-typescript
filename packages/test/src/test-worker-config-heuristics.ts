import test, { ExecutionContext } from 'ava';
import * as sinon from 'sinon';
import { addDefaultWorkerOptions } from '@temporalio/worker/lib/worker-options';
import { GiB } from '@temporalio/worker/lib/utils';
import type * as V8Type from 'v8';
import type * as OsType from 'os';
import type * as FsType from 'fs';
import type * as ProcessType from 'process';

test.serial('maxCachedWorkflows heuristic without cgroups', (t) => {
  installMemoryStatsMocks(t, { totalMem: 4 * GiB });

  const defaultWorkerOptions = addDefaultWorkerOptions({ taskQueue: 'dummy ' });
  t.is(500, defaultWorkerOptions.maxCachedWorkflows);
});

test.serial('maxCachedWorkflows heuristic without cgroups - large', (t) => {
  installMemoryStatsMocks(t, {
    totalMem: 64 * GiB,
    heapSizeLimit: 1 * GiB,
  });

  const defaultWorkerOptions = addDefaultWorkerOptions({ taskQueue: 'dummy ' });
  t.is(15500, defaultWorkerOptions.maxCachedWorkflows);
});

test.serial('maxCachedWorkflows heuristic with cgroups v1 --memory and --memory-swap', (t) => {
  installMemoryStatsMocks(t, {
    totalMem: 64 * GiB,
    heapSizeLimit: 1 * GiB,
  });

  setupCgroupsV1EnvironmentMock(t, {
    memory: 4 * GiB,
    swap: 4 * GiB,
  });

  const defaultWorkerOptions = addDefaultWorkerOptions({ taskQueue: 'dummy ' });
  t.is(1500, defaultWorkerOptions.maxCachedWorkflows);
});

test.serial('maxCachedWorkflows heuristic with cgroups v2 --memory and --memory-swap', (t) => {
  installMemoryStatsMocks(t, {
    totalMem: 64 * GiB,
    heapSizeLimit: 1 * GiB,
  });

  setupCgroupsV2EnvironmentMock(t, {
    memory: 4 * GiB,
    swap: 4 * GiB,
  });

  const defaultWorkerOptions = addDefaultWorkerOptions({ taskQueue: 'dummy ' });
  t.is(1500, defaultWorkerOptions.maxCachedWorkflows);
});

function setupCgroupsV1EnvironmentMock(t: ExecutionContext, constraints: { memory?: number; swap?: number }) {
  installProcessPlatformMock(t, 'linux');
  const { mockFile } = installFileSystemMocks(t);

  mockFile(
    '/sys/fs/cgroup/memory/memory.limit_in_bytes',
    constraints.memory ? String(constraints.memory) : '9223372036854771712'
  );

  if (constraints.memory && constraints.swap)
    mockFile('/sys/fs/cgroup/memory/memory.memsw.limit_in_bytes', String(constraints.memory + constraints.swap));
}

function setupCgroupsV2EnvironmentMock(t: ExecutionContext, constraints: { memory?: number; swap?: number }) {
  installProcessPlatformMock(t, 'linux');
  const { mockFile } = installFileSystemMocks(t);

  mockFile('/sys/fs/cgroup/cgroup.controllers', 'cpu memory');
  mockFile('/sys/fs/cgroup/memory.max', constraints.memory ? String(constraints.memory) : 'max');

  if (constraints.memory && constraints.swap) mockFile('/sys/fs/cgroup/memory.swap.max', String(constraints.swap));
}

function installProcessPlatformMock(t: ExecutionContext, platform: NodeJS.Platform) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const process = require('process') as typeof ProcessType;
  const originalPlatform = process.platform;

  Object.defineProperty(process, 'platform', {
    value: platform,
  });

  t.teardown(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
    });
  });
}

function installFileSystemMocks(t: ExecutionContext) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof FsType;

  const readFileSyncStub = sinon.stub(fs, 'readFileSync');
  const existsSyncStub = sinon.stub(fs, 'existsSync');

  t.teardown(() => {
    readFileSyncStub.restore();
    existsSyncStub.restore();
  });

  return {
    mockFile(path: string, content: string) {
      readFileSyncStub.withArgs(path, { encoding: 'ascii' }).returns(content);
      existsSyncStub.withArgs(path).returns(true);
    },
  };
}

function installMemoryStatsMocks(t: ExecutionContext, mockedStats: { totalMem: number; heapSizeLimit?: number }) {
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
