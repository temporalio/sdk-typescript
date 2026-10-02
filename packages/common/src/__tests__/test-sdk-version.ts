import { readFileSync } from 'fs';
import { join } from 'path';
import test from 'ava';
import { sdkVersion } from '../index';

const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { version: string };

test('sdkVersion exposes the package version', (t) => {
  t.is(sdkVersion, pkg.version);
  t.regex(sdkVersion, /^\d+\.\d+\.\d+/);
});
