import { readFileSync } from 'node:fs';
import test from 'ava';
import { getPrebuiltPath, platformMapping, requirePrebuilt, targets } from '@temporalio/core-bridge/common';

test('requirePrebuilt loads the same native module as the path from getPrebuiltPath', (t) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  t.is(requirePrebuilt(), require(getPrebuiltPath()));
});

test('every shipped prebuilt target is required through a literal path that bundlers can follow', (t) => {
  const source = readFileSync(require.resolve('@temporalio/core-bridge/common'), 'utf8');
  const platforms = new Set(Object.values(platformMapping));
  const shipped = targets.filter((target) => platforms.has(target.slice(target.indexOf('-') + 1)));
  t.true(shipped.length > 0);
  for (const target of shipped) {
    t.true(source.includes(`require('./releases/${target}/index.node')`), `no literal require for ${target}`);
  }
});
