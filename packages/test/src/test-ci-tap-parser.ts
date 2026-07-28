import test from 'ava';
import { parseTapOutput } from './ci/tap-parser';

// Single-file TAP output: AVA omits the file prefix entirely.
// This is the format produced by `runSingleFile`.

test('single file all passing', (t) => {
  const tap = `TAP version 13
ok 1 - msToTs converts to Timestamp
ok 2 - msToTs converts number to Timestamp

1..2
# tests 2
# pass 2
# fail 0`;

  const result = parseTapOutput(tap, ['lib/test-time.js']);
  t.deepEqual(result.passed, ['lib/test-time.js']);
  t.deepEqual(result.failed, []);
  t.deepEqual(result.failureDetails, {});
});

test('single file with failure', (t) => {
  const tap = `TAP version 13
ok 1 - cancellation works
not ok 2 - activity failure is propagated
  ---
  name: AssertionError
  message: expected error
  ...

1..2
# tests 2
# pass 1
# fail 1`;

  const result = parseTapOutput(tap, ['lib/test-worker.js']);
  t.deepEqual(result.passed, []);
  t.deepEqual(result.failed, ['lib/test-worker.js']);
  t.deepEqual(result.failureDetails, {
    'lib/test-worker.js': ['activity failure is propagated'],
  });
});

// Multi-file TAP output: AVA prefixes with a stripped name.
// "lib/test-time.js" becomes "time", "lib/test-enums-helpers.js" becomes "enums-helpers".
// Separator is ' › ' (U+203A).

test('multi-file mixed pass and fail', (t) => {
  const tap = `TAP version 13
ok 1 - time \u203a msToTs converts to Timestamp
ok 2 - time \u203a msToTs converts number to Timestamp
not ok 3 - worker \u203a activity failure is propagated
  ---
  name: AssertionError
  message: expected error
  ...
ok 4 - worker \u203a cancellation works
1..4
# tests 4
# pass 3
# fail 1`;

  const result = parseTapOutput(tap, ['lib/test-time.js', 'lib/test-worker.js']);
  t.deepEqual(result.passed, ['lib/test-time.js']);
  t.deepEqual(result.failed, ['lib/test-worker.js']);
  t.deepEqual(result.failureDetails, {
    'lib/test-worker.js': ['activity failure is propagated'],
  });
});

test('multi-file treats files with no output as failures', (t) => {
  const tap = `TAP version 13
ok 1 - time \u203a msToTs converts to Timestamp
1..1`;

  const result = parseTapOutput(tap, ['lib/test-time.js', 'lib/test-worker.js']);
  t.deepEqual(result.passed, ['lib/test-time.js']);
  t.deepEqual(result.failed, ['lib/test-worker.js']);
});

test('handles empty tap output', (t) => {
  const result = parseTapOutput('', ['lib/test-time.js']);
  t.deepEqual(result.passed, []);
  t.deepEqual(result.failed, ['lib/test-time.js']);
});

test('multi-file multiple failures in same file', (t) => {
  const tap = `TAP version 13
not ok 1 - worker \u203a test one
not ok 2 - worker \u203a test two
ok 3 - worker \u203a test three
1..3`;

  const result = parseTapOutput(tap, ['lib/test-worker.js']);
  t.deepEqual(result.failed, ['lib/test-worker.js']);
  t.deepEqual(result.failureDetails['lib/test-worker.js'], ['test one', 'test two']);
});

test('multi-file hyphenated name', (t) => {
  const tap = `TAP version 13
ok 1 - enums-helpers \u203a conversion works
1..1`;

  const result = parseTapOutput(tap, ['lib/test-enums-helpers.js']);
  t.deepEqual(result.passed, ['lib/test-enums-helpers.js']);
  t.deepEqual(result.failed, []);
});

test('single file no assertions attributed to wrong file with multiple expected', (t) => {
  // When there are multiple expected files but no separator,
  // we can't attribute the assertion, so it's dropped.
  const tap = `TAP version 13
ok 1 - some test
1..1`;

  const result = parseTapOutput(tap, ['lib/test-a.js', 'lib/test-b.js']);
  t.deepEqual(result.passed, []);
  t.deepEqual(result.failed, ['lib/test-a.js', 'lib/test-b.js']);
});

// TAP directives: # TODO and # SKIP
// Per TAP spec: "not ok" with # TODO is not a failure (known incomplete).
// "ok" with # SKIP means intentionally skipped.

test('single file todo tests are not failures', (t) => {
  const tap = `TAP version 13
not ok 1 - sets up server with extra args # TODO
not ok 2 - sets up server with specified port # TODO
ok 3 - populates address
ok 4 - sets up dev server

1..4
# tests 4
# pass 2
# skip 0
# todo 2
# fail 0`;

  const result = parseTapOutput(tap, ['lib/test-ephemeral-server.js']);
  t.deepEqual(result.passed, ['lib/test-ephemeral-server.js']);
  t.deepEqual(result.failed, []);
});

test('multi-file todo tests are not failures', (t) => {
  const tap = `TAP version 13
not ok 1 - ephemeral-server \u203a sets up test server with extra args # TODO
not ok 2 - ephemeral-server \u203a sets up test server with specified port # TODO
ok 3 - ephemeral-server \u203a populates address
ok 4 - time \u203a msToTs converts to Timestamp
1..4`;

  const result = parseTapOutput(tap, ['lib/test-ephemeral-server.js', 'lib/test-time.js']);
  t.deepEqual(result.passed, ['lib/test-ephemeral-server.js', 'lib/test-time.js']);
  t.deepEqual(result.failed, []);
});

test('single file skip tests are not failures', (t) => {
  const tap = `TAP version 13
ok 1 - runs on node # SKIP
ok 2 - another test

1..2
# tests 2
# pass 1
# skip 1
# fail 0`;

  const result = parseTapOutput(tap, ['lib/test-worker.js']);
  t.deepEqual(result.passed, ['lib/test-worker.js']);
  t.deepEqual(result.failed, []);
});

test('real failure alongside todo is still a failure', (t) => {
  const tap = `TAP version 13
not ok 1 - sets up server with extra args # TODO
not ok 2 - actual broken test
ok 3 - populates address

1..3`;

  const result = parseTapOutput(tap, ['lib/test-ephemeral-server.js']);
  t.deepEqual(result.passed, []);
  t.deepEqual(result.failed, ['lib/test-ephemeral-server.js']);
  t.deepEqual(result.failureDetails['lib/test-ephemeral-server.js'], ['actual broken test']);
});

test('file with only todo tests is a pass', (t) => {
  const tap = `TAP version 13
not ok 1 - future feature one # TODO
not ok 2 - future feature two # TODO

1..2
# tests 2
# todo 2
# fail 0`;

  const result = parseTapOutput(tap, ['lib/test-future.js']);
  t.deepEqual(result.passed, ['lib/test-future.js']);
  t.deepEqual(result.failed, []);
});

// AVA emits "No tests found in $FILE" when all tests are conditionally
// skipped at registration time (e.g. platform-gated tests on Linux ARM).

test('no tests found is not a failure', (t) => {
  const tap = `TAP version 13
not ok 1 - No tests found in lib/test-testenvironment.js

1..1
# tests 1
# pass 0
# fail 1`;

  const result = parseTapOutput(tap, ['lib/test-testenvironment.js']);
  t.deepEqual(result.passed, ['lib/test-testenvironment.js']);
  t.deepEqual(result.failed, []);
});

test('no tests found alongside real tests in multi-file', (t) => {
  const tap = `TAP version 13
not ok 1 - testenvironment \u203a No tests found in lib/test-testenvironment.js
ok 2 - time \u203a msToTs converts to Timestamp
1..2`;

  const result = parseTapOutput(tap, ['lib/test-testenvironment.js', 'lib/test-time.js']);
  t.deepEqual(result.passed, ['lib/test-testenvironment.js', 'lib/test-time.js']);
  t.deepEqual(result.failed, []);
});

// Windows: AVA uses » (U+00BB) instead of › (U+203A) as the separator.

test('windows separator multi-file', (t) => {
  const tap = `TAP version 13
ok 1 - time \u00bb msToTs converts to Timestamp
ok 2 - time \u00bb msToTs converts number to Timestamp
not ok 3 - worker \u00bb activity failure is propagated
ok 4 - worker \u00bb cancellation works
1..4`;

  const result = parseTapOutput(tap, ['lib/test-time.js', 'lib/test-worker.js']);
  t.deepEqual(result.passed, ['lib/test-time.js']);
  t.deepEqual(result.failed, ['lib/test-worker.js']);
  t.deepEqual(result.failureDetails, {
    'lib/test-worker.js': ['activity failure is propagated'],
  });
});

test('windows separator todo not a failure', (t) => {
  const tap = `TAP version 13
not ok 1 - ephemeral-server \u00bb sets up server # TODO
ok 2 - ephemeral-server \u00bb populates address
1..2`;

  const result = parseTapOutput(tap, ['lib/test-ephemeral-server.js']);
  t.deepEqual(result.passed, ['lib/test-ephemeral-server.js']);
  t.deepEqual(result.failed, []);
});

test('windows backslash paths in resolveFile', (t) => {
  const tap = `TAP version 13
ok 1 - time \u00bb converts
1..1`;

  const result = parseTapOutput(tap, ['lib\\test-time.js']);
  t.deepEqual(result.passed, ['lib\\test-time.js']);
  t.deepEqual(result.failed, []);
});
