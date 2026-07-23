import * as http2 from 'http2';
import type { AddressInfo } from 'net';

/**
 * A tiny protocol-level HTTP/2 (h2c) gRPC passthrough proxy that can gate a worker's `PollWorkflowTaskQueue`
 * calls on demand. Used by tests that need to route specific Workflow Tasks to specific workers
 * without shutting a worker down (which would evict its sticky cache).
 *
 * A worker points its `NativeConnection` at the proxy; the proxy forwards every gRPC call verbatim
 * to the real frontend, except that while "closed" it withholds `PollWorkflowTaskQueue`:
 *   - held polls are received but not forwarded (the worker simply has an outstanding long-poll);
 *   - opening releases held polls and forwards new ones, so a released poll immediately picks up
 *     any waiting task;
 *   - closing answers in-flight polls with an empty ("no task") response AND cancels the upstream
 *     poll so the server stops routing tasks to that worker. An empty OK answer (rather than an
 *     error/cancel toward the worker) is important: it is the normal "no task available" outcome,
 *     so the worker's poller does not back off and, once reopened, resumes instantly.
 *
 * Plaintext only (matches a local dev / test server); no TLS.
 */
export interface PollGateProxy {
  readonly port: number;
  /** Open (forward polls) or close (empty-answer in-flight + hold new polls) the worker behind this proxy. */
  setOpen(open: boolean): void;
  close(): Promise<void>;
}

export async function startPollGateProxy(upstreamHost: string, upstreamPort: number): Promise<PollGateProxy> {
  let open = false;
  const heldPolls = new Set<{ stream: http2.ServerHttp2Stream; headers: http2.IncomingHttpHeaders }>();
  const inflightPolls = new Set<PollPair>();

  let upstream: http2.ClientHttp2Session | undefined;
  const upstreamUrl = `http://${upstreamHost}:${upstreamPort}`;
  const getUpstream = () => {
    if (!upstream || upstream.closed || upstream.destroyed) {
      upstream = http2.connect(upstreamUrl);
      upstream.on('error', () => (upstream = undefined));
      upstream.on('close', () => (upstream = undefined));
    }
    return upstream;
  };

  const forward = (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    const path = headers[':path'];
    const isPoll = path === POLL_WFT_PATH;
    let up: http2.ClientHttp2Stream;
    try {
      up = getUpstream().request({
        ':method': headers[':method'] ?? 'POST',
        ':path': path,
        ':authority': headers[':authority'] ?? `${upstreamHost}:${upstreamPort}`,
        ':scheme': 'http',
        ...copyHeaders(headers),
      });
    } catch {
      try {
        stream.close(http2.constants.NGHTTP2_CONNECT_ERROR);
      } catch {
        /* ignore */
      }
      return;
    }

    const pair: PollPair | undefined = isPoll ? { up, stream, done: false } : undefined;
    if (pair) {
      inflightPolls.add(pair);
      up.on('close', () => inflightPolls.delete(pair));
    }

    stream.pipe(up);
    let pendingTrailers: Record<string, string | string[]> | undefined;
    up.on('response', (resHeaders) => {
      try {
        stream.respond(
          { ':status': resHeaders[':status'] ?? 200, ...copyHeaders(resHeaders) },
          { waitForTrailers: true }
        );
        stream.on('wantTrailers', () => {
          try {
            stream.sendTrailers(pendingTrailers ?? { 'grpc-status': '0' });
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* ignore */
      }
    });
    up.on('trailers', (trailers) => {
      pendingTrailers = copyHeaders(trailers);
    });
    up.pipe(stream);
    const killBoth = () => {
      if (pair?.done) return; // we already cleanly answered this poll
      try {
        up.close();
      } catch {
        /* ignore */
      }
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    };
    up.on('error', killBoth);
    stream.on('error', killBoth);
  };

  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    if (headers[':path'] === POLL_WFT_PATH && !open) {
      const entry = { stream, headers };
      heldPolls.add(entry);
      const drop = () => heldPolls.delete(entry);
      stream.on('close', drop);
      stream.on('error', drop);
      return;
    }
    forward(stream, headers);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    setOpen(o: boolean) {
      open = o;
      if (o) {
        for (const entry of heldPolls) forward(entry.stream, entry.headers);
        heldPolls.clear();
      } else {
        for (const pair of inflightPolls) {
          pair.done = true;
          try {
            pair.up.unpipe(pair.stream);
          } catch {
            /* ignore */
          }
          respondEmptyOk(pair.stream);
          try {
            pair.up.close(http2.constants.NGHTTP2_CANCEL);
          } catch {
            /* ignore */
          }
        }
        inflightPolls.clear();
      }
    },
    async close() {
      try {
        upstream?.close();
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const POLL_WFT_PATH = '/temporal.api.workflowservice.v1.WorkflowService/PollWorkflowTaskQueue';
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);
// Length-prefixed gRPC message with an empty protobuf body (1 compression byte + 4-byte length 0).
const EMPTY_GRPC_MESSAGE = Buffer.from([0, 0, 0, 0, 0]);

interface PollPair {
  up: http2.ClientHttp2Stream;
  stream: http2.ServerHttp2Stream;
  done: boolean;
}

function copyHeaders(headers: http2.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith(':') || HOP_BY_HOP.has(k) || v === undefined) continue;
    out[k] = v as string | string[];
  }
  return out;
}

function respondEmptyOk(stream: http2.ServerHttp2Stream): void {
  if (stream.headersSent || stream.closed || stream.destroyed) return;
  stream.respond(
    { ':status': 200, 'content-type': 'application/grpc', 'grpc-encoding': 'identity' },
    { waitForTrailers: true }
  );
  stream.once('wantTrailers', () => {
    try {
      stream.sendTrailers({ 'grpc-status': '0', 'grpc-message': '' });
    } catch {
      /* ignore */
    }
  });
  stream.end(EMPTY_GRPC_MESSAGE);
}
