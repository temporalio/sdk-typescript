import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'ava';

const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
const typeRoots = [dirname(dirname(require.resolve('@types/node/package.json')))];

for (const [module, moduleResolution, extension] of [
  ['commonjs', 'node', 'cts'],
  ['node20', 'node16', 'cts'],
  ['node20', 'node16', 'mts'],
  ['preserve', 'bundler', 'ts'],
]) {
  test(`public duration types resolve with ${module}/${moduleResolution} in .${extension}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'temporal-duration-types-'));
    t.teardown(() => rmSync(directory, { recursive: true, force: true }));
    const scope = join(directory, 'node_modules/@temporalio');
    mkdirSync(scope, { recursive: true });
    symlinkSync(resolve(__dirname, '../..'), join(scope, 'common'), 'junction');

    const file = `consumer.${extension}`;
    writeFileSync(
      join(directory, file),
      `import type { Duration, StringValue } from '@temporalio/common';
import { msToNumber } from '@temporalio/common/time';
const text: StringValue = '1 month';
const duration: Duration = text;
const milliseconds: number = msToNumber(duration);
// @ts-expect-error Invalid units must still be rejected.
const invalid: StringValue = '1 fortnight';
void [milliseconds, invalid];
`
    );
    const config = join(directory, 'tsconfig.json');
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          module,
          moduleResolution,
          target: 'es2022',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: false,
          noEmit: true,
          types: ['node'],
          typeRoots,
        },
        files: [file],
      })
    );

    t.notThrows(() => execFileSync(process.execPath, [compiler, '-p', config], { stdio: 'pipe' }));
  });
}
