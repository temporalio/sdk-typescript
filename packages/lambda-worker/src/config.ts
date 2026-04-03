import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ClientConnectConfig, type LoadClientProfileOptions, loadClientConnectConfig } from '@temporalio/envconfig';

/**
 * Load client connection config with Lambda-aware config file resolution.
 *
 * Resolution order:
 * 1. User-provided `configSource` in options (passthrough)
 * 2. `TEMPORAL_CONFIG_FILE` env var (handled by envconfig)
 * 3. `$LAMBDA_TASK_ROOT/temporal.toml`
 * 4. `process.cwd()/temporal.toml`
 * 5. Envconfig default (XDG paths / env-only)
 */
export function loadLambdaClientConnectConfig(options?: Partial<LoadClientProfileOptions>): ClientConnectConfig {
  const resolvedOptions: LoadClientProfileOptions = { ...options };

  // If the user provided a configSource or TEMPORAL_CONFIG_FILE is set, let envconfig handle it
  if (!resolvedOptions.configSource && !process.env['TEMPORAL_CONFIG_FILE']) {
    const lambdaConfigPath = findLambdaConfigFile();
    if (lambdaConfigPath) {
      resolvedOptions.configSource = { path: lambdaConfigPath };
    }
  }

  return loadClientConnectConfig(resolvedOptions);
}

function findLambdaConfigFile(): string | undefined {
  const candidates: string[] = [];

  const lambdaTaskRoot = process.env['LAMBDA_TASK_ROOT'];
  if (lambdaTaskRoot) {
    candidates.push(path.join(lambdaTaskRoot, 'temporal.toml'));
  }

  candidates.push(path.join(process.cwd(), 'temporal.toml'));

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      // File doesn't exist or isn't readable, try next
    }
  }

  return undefined;
}
