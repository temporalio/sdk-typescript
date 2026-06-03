import test from 'ava';
import {
  assertActivityOperationToken,
  base64URLEncodeNoPadding,
  generateActivityOperationToken,
  generateWorkflowRunOperationToken,
  loadOperationToken,
  loadWorkflowRunOperationToken,
} from '../token';

test('encode and decode workflow run Operation token', (t) => {
  const expected = {
    t: 1,
    ns: 'ns',
    wid: 'w',
  };
  const token = generateWorkflowRunOperationToken('ns', 'w');
  const decoded = loadWorkflowRunOperationToken(token);
  t.deepEqual(decoded, expected);
});

test('encode and decode activity Operation token', (t) => {
  const expected = {
    t: 2,
    ns: 'ns',
    aid: 'a',
    rid: 'r',
  };
  const token = generateActivityOperationToken('ns', 'a', 'r');
  const decoded = loadOperationToken(token);
  assertActivityOperationToken(decoded);
  t.deepEqual(decoded, expected);
});

test('decode Operation token errors', (t) => {
  t.throws(() => loadOperationToken(''), { message: /invalid operation token: token is empty/ });

  t.throws(() => loadOperationToken('not-base64!@#$'), { message: /failed to decode token/ });

  const invalidJSONToken = base64URLEncodeNoPadding('invalid json');
  t.throws(() => loadOperationToken(invalidJSONToken), {
    message: /failed to unmarshal Operation token/,
  });

  const versionedToken = base64URLEncodeNoPadding('{"v":1, "t":1,"wid": "workflow-id"}');
  t.throws(() => loadOperationToken(versionedToken), {
    message: /invalid operation token: "v" field should not be present/,
  });
});

test('decode workflow run Operation token errors', (t) => {
  const invalidTypeToken = base64URLEncodeNoPadding('{"t":99,"ns":"ns"}');
  t.throws(() => loadWorkflowRunOperationToken(invalidTypeToken), {
    // This currently fails on unknown token type as there are no other existing token types.
    // When new token types are added this regex will need to be updated to
    message: /invalid operation token: unknown token type: 99/,
  });

  const missingWIDToken = base64URLEncodeNoPadding('{"t":1,"ns":"ns"}');
  t.throws(() => loadWorkflowRunOperationToken(missingWIDToken), {
    message: /invalid workflow run token: missing workflow ID \(wid\)/,
  });
});

test('decode activity Operation token errors', (t) => {
  const missingAIDToken = base64URLEncodeNoPadding('{"t":2,"ns":"ns","rid":"r"}');
  t.throws(() => assertActivityOperationToken(loadOperationToken(missingAIDToken)), {
    message: /invalid activity token: missing activity ID \(aid\)/,
  });

  const missingRIDToken = base64URLEncodeNoPadding('{"t":2,"ns":"ns","aid":"a"}');
  t.throws(() => assertActivityOperationToken(loadOperationToken(missingRIDToken)), {
    message: /invalid activity token: missing activity run ID \(rid\)/,
  });
});

test('loadWorkflowRunOperationToken rejects activity token', (t) => {
  const activityToken = generateActivityOperationToken('ns', 'a', 'r');
  t.throws(() => loadWorkflowRunOperationToken(activityToken), {
    message: /invalid workflow token type: 2, expected: 1/,
  });
});
