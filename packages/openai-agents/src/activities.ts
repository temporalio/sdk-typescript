import type { ModelProvider, ModelResponse } from '@openai/agents-core';
import { ApplicationFailure } from '@temporalio/common';
import { heartbeat, activityInfo } from '@temporalio/activity';
import type { ActivityModelInput } from './model-stub';

function getStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as any;
  if (typeof e.status === 'number') return e.status;
  if (e.response && typeof e.response.status === 'number') return e.response.status;
  return undefined;
}

function getHeader(error: unknown, name: string): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as any;
  const h1 = e.headers;
  if (h1) {
    if (typeof h1.get === 'function') {
      const v = h1.get(name);
      if (typeof v === 'string') return v;
    } else if (typeof h1 === 'object' && typeof h1[name] === 'string') {
      return h1[name];
    }
  }
  const h2 = e.response?.headers;
  if (h2) {
    if (typeof h2.get === 'function') {
      const v = h2.get(name);
      if (typeof v === 'string') return v;
    } else if (typeof h2 === 'object' && typeof h2[name] === 'string') {
      return h2[name];
    }
  }
  return undefined;
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const shouldRetry = getHeader(error, 'x-should-retry');
  if (shouldRetry === 'true') return true;
  if (shouldRetry === 'false') return false;

  const status = getStatus(error);
  if (status === undefined) {
    return (error as any).response !== undefined;
  }
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return true;
  }
  return false;
}

function errorTypeFromStatus(status: number | undefined): string {
  if (status === undefined) return 'ModelInvocationError';
  if (status === 429) return 'ModelInvocationError.RateLimit';
  if (status === 401 || status === 403) return 'ModelInvocationError.Authentication';
  if (status === 408) return 'ModelInvocationError.Timeout';
  if (status === 409) return 'ModelInvocationError.Conflict';
  if (status >= 400 && status < 500) return 'ModelInvocationError.BadRequest';
  if (status >= 500) return 'ModelInvocationError.ServerError';
  return 'ModelInvocationError';
}

function getRetryAfterMs(error: unknown): number | undefined {
  const ms = getHeader(error, 'retry-after-ms');
  if (ms) {
    const parsed = parseFloat(ms);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const s = getHeader(error, 'retry-after');
  if (s) {
    const parsed = parseFloat(s);
    if (!Number.isNaN(parsed)) return parsed * 1000;
  }
  return undefined;
}

// NOTE: Temporal's default payload converter serializes via JSON.stringify.
// Date objects become ISO strings, class instances become plain objects.
// @openai/agents-core's ModelResponse uses plain JSON-safe types by default,
// so this is typically not a concern. Custom ModelProviders that emit Dates
// or class instances should pre-serialize them.

/**
 * Creates the model activity functions to be registered with the Worker.
 * The returned activities use the provided ModelProvider to resolve models
 * and execute real LLM calls.
 */
export function createModelActivity(modelProvider: ModelProvider): {
  invokeModelActivity: (input: ActivityModelInput) => Promise<ModelResponse>;
} {
  return {
    /**
     * Activity that invokes a model. Called by TemporalModelStub from workflow context.
     * Handles auto-heartbeating for long-running LLM calls and classifies errors
     * as retryable or non-retryable for Temporal's retry policy.
     */
    async invokeModelActivity(input: ActivityModelInput): Promise<ModelResponse> {
      const model = await Promise.resolve(modelProvider.getModel(input.modelName));

      // Auto-heartbeat: send heartbeats at half the timeout interval
      // to keep the activity alive during long LLM calls (30-60+ seconds)
      const info = activityInfo();
      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      if (info.heartbeatTimeoutMs && info.heartbeatTimeoutMs > 0) {
        const interval = info.heartbeatTimeoutMs / 2;
        const scheduleHeartbeat = () => {
          heartbeatTimer = setTimeout(() => {
            if (stopped) return;
            try {
              heartbeat();
            } catch {
              // Activity might be cancelled — ignore heartbeat errors
            }
            scheduleHeartbeat();
          }, interval);
        };
        scheduleHeartbeat();
      }

      try {
        return await model.getResponse(input.request as any);
      } catch (error) {
        const retryable = isRetryableError(error);
        const message = error instanceof Error ? error.message : String(error);
        const retryAfterMs = getRetryAfterMs(error);

        throw ApplicationFailure.create({
          message: `Model invocation failed: ${message}`,
          type: errorTypeFromStatus(getStatus(error)),
          nonRetryable: !retryable,
          cause: error instanceof Error ? error : new Error(String(error)),
          ...(retryAfterMs !== undefined ? { nextRetryDelay: retryAfterMs } : {}),
        });
      } finally {
        stopped = true;
        if (heartbeatTimer) {
          clearTimeout(heartbeatTimer);
        }
      }
    },
  };
}
