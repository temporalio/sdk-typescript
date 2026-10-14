import test from 'ava';
import { version } from '../index';

test('version is exported and looks like a semver SDK version', (t) => {
  t.regex(version, /^\d+\.\d+\.\d+/);
});
