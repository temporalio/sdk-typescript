import * as http from 'node:http';
import * as net from 'node:net';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { FetchPath } from './telemetry';
import { FetchTimeoutError, InvalidResponseError, LambdaExtensionStatusError } from './telemetry';

export const ENV_LAMBDA_EXTENSION_PORT = 'PARAMETERS_SECRETS_EXTENSION_HTTP_PORT';
const ENV_LAMBDA_FUNCTION_NAME = 'AWS_LAMBDA_FUNCTION_NAME';
const ENV_AWS_SESSION_TOKEN = 'AWS_SESSION_TOKEN';
const LAMBDA_EXTENSION_TOKEN_HEADER = 'X-Aws-Parameters-Secrets-Token';
const LAMBDA_EXTENSION_HOST = 'localhost';
const DEFAULT_LAMBDA_EXTENSION_PORT = 2773;
// Probing a local port is either accepted or refused almost immediately, so this only bounds
// pathological cases
const LAMBDA_EXTENSION_PROBE_TIMEOUT_MS = 100;

const AWS_SDK_PACKAGE = '@aws-sdk/client-secrets-manager';

/** Bounds each request made by the fetchers. */
export const FETCH_TIMEOUT_MS = 10_000;

/** A fetched secret value. */
export interface SecretValue {
  value: Buffer;
  versionId: string;
}

/** Fetches secret values by ID. */
export interface Fetcher {
  /**
   * The fetch_path metric label for this fetcher. May change during the first fetch, so must only
   * be read after a fetch has completed.
   */
  readonly path: FetchPath;
  fetch(secretId: string): Promise<SecretValue>;
}

/**
 * Returns a fetcher for the Lambda extension if it is detected, and otherwise an SDK fetcher with a
 * client created from the default AWS config.
 *
 * The extension doesn't set PARAMETERS_SECRETS_EXTENSION_HTTP_PORT in the function's environment
 * unless the user configured it, so if it is unset and running in Lambda, the extension's default
 * port is probed on the first fetch. Setting it to empty disables detection, for when another
 * service uses the default port.
 */
export function newDefaultFetcher(): Fetcher {
  const port = process.env[ENV_LAMBDA_EXTENSION_PORT];
  if (port === undefined) {
    // Only try to auto-detect the Lambda extension if we're in a Lambda function
    return process.env[ENV_LAMBDA_FUNCTION_NAME] ? new DetectingFetcher() : new SDKFetcher();
  }
  return port ? new LambdaExtensionFetcher(port) : new SDKFetcher();
}

/** Whether the AWS SDK Secrets Manager client package can be loaded. */
export function awsSdkAvailable(): boolean {
  try {
    require.resolve(AWS_SDK_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

/** Error for when the AWS SDK is needed but can't be loaded. */
export function awsSdkMissingError(cause?: unknown): Error {
  return new Error(
    `fetching secrets directly from AWS Secrets Manager requires ${AWS_SDK_PACKAGE}, since the AWS Parameters ` +
      `and Secrets Lambda Extension was not detected (see ${ENV_LAMBDA_EXTENSION_PORT}). Install ` +
      `${AWS_SDK_PACKAGE}, or add the extension to your Lambda function`,
    { cause }
  );
}

let awsSdk: Promise<typeof import('@aws-sdk/client-secrets-manager')> | undefined;

function loadAwsSdk(): Promise<typeof import('@aws-sdk/client-secrets-manager')> {
  awsSdk ??= import(AWS_SDK_PACKAGE).catch((err) => {
    awsSdk = undefined;
    throw awsSdkMissingError(err);
  });
  return awsSdk;
}

/**
 * Fetches secrets directly from Secrets Manager. If no client is given, one is created from the
 * default AWS config on first use.
 */
export class SDKFetcher implements Fetcher {
  readonly path = 'sdk';

  constructor(private client?: SecretsManagerClient) {}

  async fetch(secretId: string): Promise<SecretValue> {
    // Imported lazily, since the AWS SDK is only needed for this fetcher
    const sdk = await loadAwsSdk();
    this.client ??= new sdk.SecretsManagerClient({});
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    let resp;
    try {
      resp = await this.client.send(new sdk.GetSecretValueCommand({ SecretId: secretId }), { abortSignal: signal });
    } catch (err) {
      throw signal.aborted ? timeoutError(err) : err;
    }
    return newSecretValue(resp.SecretString, resp.SecretBinary, resp.VersionId);
  }
}

/**
 * Fetches secrets through the AWS Parameters and Secrets Lambda Extension. See
 * https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets_lambda.html.
 */
export class LambdaExtensionFetcher implements Fetcher {
  readonly path = 'extension';

  constructor(private readonly port: string | number) {}

  fetch(secretId: string): Promise<SecretValue> {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      const fail = (err: unknown) => reject(signal.aborted ? timeoutError(err) : err);
      // node:http rather than fetch, so that HTTP(S)_PROXY env vars never apply to requests to the
      // local extension
      const req = http.get(
        {
          host: LAMBDA_EXTENSION_HOST,
          port: this.port,
          path: `/secretsmanager/get?secretId=${encodeURIComponent(secretId)}`,
          headers: { [LAMBDA_EXTENSION_TOKEN_HEADER]: process.env[ENV_AWS_SESSION_TOKEN] ?? '' },
          signal,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', fail);
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            if (res.statusCode !== 200) {
              reject(new LambdaExtensionStatusError(res.statusCode ?? 0, body));
              return;
            }
            try {
              resolve(parseLambdaExtensionResponse(body));
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on('error', fail);
    });
  }
}

function parseLambdaExtensionResponse(body: string): SecretValue {
  let out: any;
  try {
    // Same shape as the GetSecretValue response, with SecretBinary base64
    out = JSON.parse(body);
  } catch (err) {
    throw new InvalidResponseError(`failed decoding AWS Parameters and Secrets Lambda Extension response: ${err}`, {
      cause: err,
    });
  }
  if (out === null || typeof out !== 'object') {
    throw new InvalidResponseError(
      'failed decoding AWS Parameters and Secrets Lambda Extension response: not an object'
    );
  }
  const { SecretString, SecretBinary, VersionId } = out;
  if (
    (SecretString != null && typeof SecretString !== 'string') ||
    (SecretBinary != null && typeof SecretBinary !== 'string') ||
    (VersionId != null && typeof VersionId !== 'string')
  ) {
    throw new InvalidResponseError(
      'failed decoding AWS Parameters and Secrets Lambda Extension response: unexpected field types'
    );
  }
  return newSecretValue(SecretString, SecretBinary ? Buffer.from(SecretBinary, 'base64') : undefined, VersionId);
}

/**
 * Uses the Lambda extension if something is listening on its default port when first fetching, and
 * otherwise the AWS SDK.
 */
export class DetectingFetcher implements Fetcher {
  private detected?: Promise<Fetcher>;
  private resolved?: Fetcher;

  constructor(private readonly port = DEFAULT_LAMBDA_EXTENSION_PORT) {}

  get path(): FetchPath {
    return this.resolved?.path ?? 'sdk';
  }

  async fetch(secretId: string): Promise<SecretValue> {
    this.detected ??= probe(this.port).then((listening) => {
      this.resolved = listening ? new LambdaExtensionFetcher(this.port) : new SDKFetcher();
      return this.resolved;
    });
    return (await this.detected).fetch(secretId);
  }
}

/** Whether something accepts connections on the given local port. */
export function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: LAMBDA_EXTENSION_HOST, port });
    const done = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(LAMBDA_EXTENSION_PROBE_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function timeoutError(cause: unknown): FetchTimeoutError {
  return new FetchTimeoutError(`AWS Secrets Manager secret fetch timed out after ${FETCH_TIMEOUT_MS}ms`, { cause });
}

function newSecretValue(
  secretString: string | null | undefined,
  secretBinary: Uint8Array | null | undefined,
  versionId: string | null | undefined
): SecretValue {
  let value: Buffer;
  if (secretString != null) {
    value = Buffer.from(secretString);
  } else if (secretBinary?.length) {
    value = Buffer.from(secretBinary);
  } else {
    throw new InvalidResponseError('secret has no value');
  }
  return { value, versionId: versionId ?? '' };
}
