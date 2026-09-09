import { createRequire } from 'node:module';
import test from 'ava';

const requireCommon = createRequire(__filename);
const commonPath = requireCommon.resolve('@temporalio/core-bridge/common.js');

interface CommonModule {
  getPrebuiltTargetName(): string;
}

interface ProcessReportStub {
  getReport(): unknown;
}

// common.js reads os.platform() through require('os'); an ESM namespace import compiles to a
// getter-only view under esModuleInterop, so stubbing must go through the mutable CommonJS
// module object instead.
const nodeOs = requireCommon('node:os') as { platform(): NodeJS.Platform };

// process.report is defined as a getter-only accessor; stubbing it requires redefining the
// property, and restoring it requires the original descriptor.
const reportDescriptor = Object.getOwnPropertyDescriptor(process, 'report');

function targetNameWith(platform: NodeJS.Platform, report: ProcessReportStub | undefined): string {
  const originalPlatform = nodeOs.platform;
  try {
    nodeOs.platform = () => platform;
    if (report === undefined) {
      Reflect.deleteProperty(process, 'report');
    } else {
      Object.defineProperty(process, 'report', { value: report, enumerable: true, configurable: true });
    }
    delete requireCommon.cache[commonPath];
    const { getPrebuiltTargetName } = requireCommon(commonPath) as CommonModule;
    return getPrebuiltTargetName();
  } finally {
    nodeOs.platform = originalPlatform;
    Reflect.deleteProperty(process, 'report');
    if (reportDescriptor !== undefined) {
      Object.defineProperty(process, 'report', reportDescriptor);
    }
    delete requireCommon.cache[commonPath];
  }
}

test.serial('getPrebuiltTargetName resolves the glibc prebuild on glibc Linux', (t) => {
  const report = { getReport: () => ({ header: { glibcVersionRuntime: '2.31' } }) };
  t.true(targetNameWith('linux', report).endsWith('-unknown-linux-gnu'));
});

test.serial('getPrebuiltTargetName resolves the musl prebuild on musl Linux', (t) => {
  const report = { getReport: () => ({ header: {} }) };
  t.true(targetNameWith('linux', report).endsWith('-unknown-linux-musl'));
});

test.serial('getPrebuiltTargetName falls back to the glibc prebuild without process report support', (t) => {
  t.true(targetNameWith('linux', undefined).endsWith('-unknown-linux-gnu'));
});

test.serial('getPrebuiltTargetName ignores the libc check outside Linux', (t) => {
  const report = { getReport: () => ({ header: {} }) };
  t.true(targetNameWith('darwin', report).endsWith('-apple-darwin'));
});
