import 'abort-controller/polyfill'; // eslint-disable-line import/no-unassigned-import
import { Duration, SearchAttributeType } from '@temporalio/common';
import { msToNumber } from '@temporalio/common/lib/time';
import { native } from '@temporalio/core-bridge';
import { SearchAttributeKey } from '@temporalio/common/lib/search-attributes';
import pkg from './pkg';

/**
 * Configuration for the Temporal CLI Dev Server.
 */
export interface DevServerConfig {
  type: 'dev-server';

  executable?: EphemeralServerExecutable;

  /**
   * Sqlite DB filename if persisting or non-persistent if none (default).
   */
  dbFilename?: string;

  /**
   * Namespace to use - created at startup.
   *
   * @default "default"
   */
  namespace?: string;

  /**
   * IP to bind to.
   *
   * @default localhost
   */
  ip?: string;

  /**
   * Port to listen on; defaults to find a random free port.
   */
  port?: number;

  /**
   * Whether to enable the UI.
   *
   * @default true if `uiPort` is set; defaults to `false` otherwise.
   */
  ui?: boolean;

  /**
   * Port to listen on for the UI; if `ui` is true, defaults to `port + 1000`.
   */
  uiPort?: number;

  /**
   * Log format and level
   * @default { format: "pretty", level" "warn" }
   */
  log?: { format: string; level: string };

  /**
   * Extra args to pass to the executable command.
   *
   * Note that the Dev Server implementation may be changed to another one in the future. Therefore, there is no
   * guarantee that Dev Server options, and particularly those provided through the `extraArgs` array, will continue to
   * be supported in the future.
   */
  extraArgs?: string[];

  /**
   * Search attributes to be registered with the dev server.
   */
  searchAttributes?: SearchAttributeKey<SearchAttributeType>[];
}

/**
 * Configuration for the time-skipping test server.
 */
export interface TimeSkippingServerConfig {
  type: 'time-skipping';

  executable?: EphemeralServerExecutable;

  /**
   * Optional port to listen on, defaults to find a random free port.
   */
  port?: number;

  /**
   * Extra args to pass to the executable command.
   *
   * Note that the Test Server implementation may be changed to another one in the future. Therefore, there is
   * no guarantee that server options, and particularly those provided through the `extraArgs` array, will continue to
   * be supported in the future.
   */
  extraArgs?: string[];
}

/**
 * Which version of the executable to run.
 */
export type EphemeralServerExecutable =
  | {
      type: 'cached-download';
      /**
       * Download destination directory or the system's temp directory if none set.
       */
      downloadDir?: string;
      /**
       * Optional version, can be set to a specific server release or "default" or "latest".
       *
       * At the time of writing the the server is released as part of the
       * Java SDK - (https://github.com/temporalio/sdk-java/releases).
       *
       * @default "default" - get the best version for the current SDK version.
       */
      version?: string;

      /** How long to cache the download for. Default to 1 day. */
      ttl?: Duration;
    }
  | {
      type: 'existing-path';
      /** Path to executable */
      path: string;
    };

/**
 * @internal
 */
export function toNativeEphemeralServerConfig(
  server: DevServerConfig | TimeSkippingServerConfig
): native.EphemeralServerConfig {
  switch (server.type) {
    case 'dev-server':
      return {
        type: 'dev-server',
        exe: toNativeEphemeralServerExecutableConfig(server.executable),
        ip: server.ip ?? '127.0.0.1',
        port: server.port ?? null,
        ui: server.ui ?? false,
        uiPort: server.uiPort ?? null,
        namespace: server.namespace ?? 'default',
        dbFilename: server.dbFilename ?? null,
        log: server.log ?? { format: 'pretty', level: 'warn' },
        extraArgs: server.extraArgs ?? [],
      };

    case 'time-skipping':
      return {
        type: 'time-skipping',
        exe: toNativeEphemeralServerExecutableConfig(server.executable),
        port: server.port ?? null,
        extraArgs: server.extraArgs ?? [],
      };

    default:
      throw new TypeError(`Unsupported server type: ${String((server as any).type)}`);
  }
}

/**
 * @internal
 */
function toNativeEphemeralServerExecutableConfig(
  executable: EphemeralServerExecutable = { type: 'cached-download' }
): native.EphemeralServerExecutableConfig {
  switch (executable.type) {
    case 'cached-download':
      return {
        type: 'cached-download',
        downloadDir: executable.downloadDir ?? null,
        version: executable.version ?? 'default',
        ttl: msToNumber(executable.ttl ?? '1d'),
        sdkName: 'sdk-typescript',
        sdkVersion: pkg.version,
      };

    case 'existing-path':
      return {
        type: 'existing-path',
        path: executable.path,
      };

    default:
      throw new TypeError(`Unsupported server executable type: ${String((executable as any).type)}`);
  }
}
