import test from 'ava';
import { splitProtoHostPort, normalizeGrpcEndpointAddress } from '@temporalio/common/lib/internal-non-workflow';

test('splitProtoHostPort', (t) => {
  t.deepEqual(splitProtoHostPort('127.0.0.1'), { scheme: undefined, hostname: '127.0.0.1', port: undefined });
  t.deepEqual(splitProtoHostPort('[::1]'), { scheme: undefined, hostname: '::1', port: undefined });
  t.deepEqual(splitProtoHostPort('myserver.com'), { scheme: undefined, hostname: 'myserver.com', port: undefined });

  t.deepEqual(splitProtoHostPort('127.0.0.1:7890'), { scheme: undefined, hostname: '127.0.0.1', port: 7890 });
  t.deepEqual(splitProtoHostPort('[::1]:7890'), { scheme: undefined, hostname: '::1', port: 7890 });
  t.deepEqual(splitProtoHostPort('myserver.com:7890'), { scheme: undefined, hostname: 'myserver.com', port: 7890 });

  t.deepEqual(splitProtoHostPort('http://127.0.0.1:8080'), { scheme: 'http', hostname: '127.0.0.1', port: 8080 });
  t.deepEqual(splitProtoHostPort('http://[::1]:1234'), { scheme: 'http', hostname: '::1', port: 1234 });
  t.deepEqual(splitProtoHostPort('http://myserver.com:5678'), { scheme: 'http', hostname: 'myserver.com', port: 5678 });
});

test('normalizeTemporalGrpcEndpointAddress', (t) => {
  const normalize = (s: string) => normalizeGrpcEndpointAddress(s, 7233);

  t.is(normalize('127.0.0.1'), '127.0.0.1:7233');
  t.is(normalize('127.0.0.1:7890'), '127.0.0.1:7890');
  t.is(normalize('[::1]'), '[::1]:7233');
  t.is(normalize('[::1]:7890'), '[::1]:7890');
  t.is(normalize('myserver.com'), 'myserver.com:7233');
  t.is(normalize('myserver.com:7890'), 'myserver.com:7890');

  t.throws(() => normalize('http://127.0.0.1'), { message: /Invalid/ });
  t.throws(() => normalize('::1'), { message: /Invalid/ });
});
