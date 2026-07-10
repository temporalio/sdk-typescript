import test from 'ava';
import {
  base64URLEncodeNoPadding,
  generateUpdateWorkflowOperationToken,
  generateWorkflowRunOperationToken,
  loadOperationToken,
  loadUpdateWorkflowOperationToken,
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
  const invalidTypeToken = base64URLEncodeNoPadding('{"t":2,"ns":"ns"}');
  t.throws(() => loadWorkflowRunOperationToken(invalidTypeToken), {
    // This currently fails on unknown token type as there are no other existing token types.
    // When new token types are added this regex will need to be updated to
    //  /invalid workflow token type: 2/
    message: /invalid operation token: unknown token type: 2/,
  });

  const missingWIDToken = base64URLEncodeNoPadding('{"t":1,"ns":"ns"}');
  t.throws(() => loadWorkflowRunOperationToken(missingWIDToken), {
    message: /invalid workflow run token: missing workflow ID \(wid\)/,
  });
});

test('encode and decode update workflow Operation token', (t) => {
  const expected = {
    t: 3,
    ns: 'ns',
    wid: 'w',
    rid: 'r',
    uid: 'u',
  };
  const token = generateUpdateWorkflowOperationToken('ns', 'w', 'r', 'u');
  const decoded = loadUpdateWorkflowOperationToken(token);
  t.deepEqual(decoded, expected);
});

test('update workflow Operation token matches Go wire format byte-for-byte', (t) => {
  // Field order and names must match the Go SDK's json.Marshal output: t, ns, wid, rid, uid.
  // The version field ("v") must be absent.
  const token = generateUpdateWorkflowOperationToken('ns', 'w', 'r', 'u');
  const decodedJSON = Buffer.from(token, 'base64url').toString('utf-8');
  t.is(decodedJSON, '{"t":3,"ns":"ns","wid":"w","rid":"r","uid":"u"}');
});

test('encode update workflow Operation token with empty runId omits rid', (t) => {
  const token = generateUpdateWorkflowOperationToken('ns', 'w', '', 'u');
  const decodedJSON = Buffer.from(token, 'base64url').toString('utf-8');
  // `rid` is optional: it must be omitted entirely rather than emitted as an empty string.
  t.is(decodedJSON, '{"t":3,"ns":"ns","wid":"w","uid":"u"}');

  const parsed = JSON.parse(decodedJSON);
  t.false('rid' in parsed);

  // Round-trips: the load side tolerates an absent rid, yielding no pinned run.
  const decoded = loadUpdateWorkflowOperationToken(token);
  t.deepEqual(decoded, { t: 3, ns: 'ns', wid: 'w', uid: 'u' });
  t.is(decoded.rid, undefined);
});

test('load update workflow Operation token tolerates legacy empty rid', (t) => {
  // Legacy tokens may carry rid:"" explicitly; it must be accepted and treated as no pinned run.
  const legacyToken = base64URLEncodeNoPadding('{"t":3,"ns":"ns","wid":"w","rid":"","uid":"u"}');
  const decoded = loadUpdateWorkflowOperationToken(legacyToken);
  t.deepEqual(decoded, { t: 3, ns: 'ns', wid: 'w', rid: '', uid: 'u' });
});

test('generate update workflow Operation token validates required params', (t) => {
  t.throws(() => generateUpdateWorkflowOperationToken('', 'w', 'r', 'u'), { message: /namespace/ });
  t.throws(() => generateUpdateWorkflowOperationToken('ns', '', 'r', 'u'), { message: /workflow ID/ });
  t.throws(() => generateUpdateWorkflowOperationToken('ns', 'w', 'r', ''), { message: /update ID/ });
});

test('decode update workflow Operation token errors', (t) => {
  const wrongTypeToken = base64URLEncodeNoPadding('{"t":1,"ns":"ns","wid":"w"}');
  t.throws(() => loadUpdateWorkflowOperationToken(wrongTypeToken), {
    message: /invalid update workflow token type: 1, expected: 3/,
  });

  const missingWIDToken = base64URLEncodeNoPadding('{"t":3,"ns":"ns","uid":"u"}');
  t.throws(() => loadUpdateWorkflowOperationToken(missingWIDToken), {
    message: /invalid update workflow token: missing workflow ID \(wid\)/,
  });

  const missingUIDToken = base64URLEncodeNoPadding('{"t":3,"ns":"ns","wid":"w"}');
  t.throws(() => loadUpdateWorkflowOperationToken(missingUIDToken), {
    message: /invalid update workflow token: missing update ID \(uid\)/,
  });
});
