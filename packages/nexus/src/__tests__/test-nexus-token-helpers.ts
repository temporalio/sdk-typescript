import test from 'ava';
import {
  base64URLEncodeNoPadding,
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
