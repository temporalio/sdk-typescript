import test from 'ava';
import { base64URLEncodeNoPadding, generateWorkflowRunOperationToken, loadWorkflowRunOperationToken } from '../token';

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

test('decode workflow run Operation token errors', (t) => {
  t.throws(() => loadWorkflowRunOperationToken(''), { message: /invalid workflow run token: token is empty/ });

  t.throws(() => loadWorkflowRunOperationToken('not-base64!@#$'), { message: /failed to decode token/ });

  const invalidJSONToken = base64URLEncodeNoPadding('invalid json');
  t.throws(() => loadWorkflowRunOperationToken(invalidJSONToken), {
    message: /failed to unmarshal workflow run Operation token/,
  });

  const invalidTypeToken = base64URLEncodeNoPadding('{"t":2}');
  t.throws(() => loadWorkflowRunOperationToken(invalidTypeToken), {
    message: /invalid workflow token type: 2, expected: 1/,
  });

  const missingWIDToken = base64URLEncodeNoPadding('{"t":1}');
  t.throws(() => loadWorkflowRunOperationToken(missingWIDToken), {
    message: /invalid workflow run token: missing workflow ID \(wid\)/,
  });

  const versionedToken = base64URLEncodeNoPadding('{"v":1, "t":1,"wid": "workflow-id"}');
  t.throws(() => loadWorkflowRunOperationToken(versionedToken), {
    message: /invalid workflow run token: "v" field should not be present/,
  });
});
