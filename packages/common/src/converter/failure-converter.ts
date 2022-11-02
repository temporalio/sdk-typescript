import {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  ChildWorkflowFailure,
  FAILURE_SOURCE,
  ProtoFailure,
  RetryState,
  ServerFailure,
  TemporalFailure,
  TerminatedFailure,
  TimeoutFailure,
  TimeoutType,
} from '../failure';
import { hasOwnProperties, isRecord } from '../type-helpers';
import { arrayFromPayloads, fromPayloadsAtIndex, PayloadConverter, toPayloads } from './payload-converter';

/**
 * Stack traces will be cutoff when on of these patterns is matched
 */
const CUTOFF_STACK_PATTERNS = [
  /** Activity execution */
  /\s+at Activity\.execute \(.*[\\/]worker[\\/](?:src|lib)[\\/]activity\.[jt]s:\d+:\d+\)/,
  /** Workflow activation */
  /\s+at Activator\.\S+NextHandler \(.*[\\/]workflow[\\/](?:src|lib)[\\/]internals\.[jt]s:\d+:\d+\)/,
  /** Workflow run anything in context */
  /\s+at Script\.runInContext \((?:node:vm|vm\.js):\d+:\d+\)/,
];

/**
 * Cuts out the framework part of a stack trace, leaving only user code entries
 */
export function cutoffStackTrace(stack?: string): string {
  const lines = (stack ?? '').split(/\r?\n/);
  const acc = Array<string>();
  lineLoop: for (const line of lines) {
    for (const pattern of CUTOFF_STACK_PATTERNS) {
      if (pattern.test(line)) break lineLoop;
    }
    acc.push(line);
  }
  return acc.join('\n');
}

/**
 * A `FailureConverter` is responsible for converting from proto `Failure` instances to JS `Errors` and back.
 *
 * We recommended using the {@link DefaultFailureConverter} instead of customizing the default implementation in order
 * to maintain cross-language Failure serialization compatibility.
 *
 * @experimental
 */
export interface FailureConverter {
  /**
   * Converts a caught error to a Failure proto message.
   */
  errorToFailure(err: unknown, payloadConverter: PayloadConverter): ProtoFailure;
  /**
   * Converts a Failure proto message to a JS Error object.
   */
  failureToError(err: ProtoFailure, payloadConverter: PayloadConverter): Error;
}

/**
 * The "shape" of the attributes set as the {@link ProtoFailure.encodedAttributes} payload in case
 * {@link DefaultEncodedFailureAttributes.encodeCommonAttributes} is set to `true`.
 */
export interface DefaultEncodedFailureAttributes {
  message: string;
  stack_trace: string;
}

/**
 * Options for the {@link DefaultFailureConverter} constructor.
 */
export interface DefaultFailureConverterOptions {
  /**
   * Whether to encode error messages and stack traces (for encrypting these attributes use a {@link PayloadCodec}).
   */
  encodeCommonAttributes: boolean;
}

/**
 * Default, cross-language-compatible Failure converter.
 *
 * By default, it will leave error messages and stack traces as plain text. In order to encrypt them, set
 * `encodeCommonAttributes` to `true` in the constructor options and use a {@link PayloadCodec} that can encrypt /
 * decrypt Payloads in your {@link WorkerOptions.dataConverter | Worker} and
 * {@link ClientOptions.dataConverter | Client options}.
 *
 * @experimental
 */
export class DefaultFailureConverter implements FailureConverter {
  public readonly options: DefaultFailureConverterOptions;

  constructor(options?: Partial<DefaultFailureConverterOptions>) {
    const { encodeCommonAttributes } = options ?? {};
    this.options = {
      encodeCommonAttributes: encodeCommonAttributes ?? false,
    };
  }

  /**
   * Converts a Failure proto message to a JS Error object.
   *
   * Does not set common properties, that is done in {@link failureToError}.
   */
  failureToErrorInner(failure: ProtoFailure, payloadConverter: PayloadConverter): TemporalFailure {
    if (failure.applicationFailureInfo) {
      return new ApplicationFailure(
        failure.message ?? undefined,
        failure.applicationFailureInfo.type,
        Boolean(failure.applicationFailureInfo.nonRetryable),
        arrayFromPayloads(payloadConverter, failure.applicationFailureInfo.details?.payloads),
        this.optionalFailureToOptionalError(failure.cause, payloadConverter)
      );
    }
    if (failure.serverFailureInfo) {
      return new ServerFailure(
        failure.message ?? undefined,
        Boolean(failure.serverFailureInfo.nonRetryable),
        this.optionalFailureToOptionalError(failure.cause, payloadConverter)
      );
    }
    if (failure.timeoutFailureInfo) {
      return new TimeoutFailure(
        failure.message ?? undefined,
        fromPayloadsAtIndex(payloadConverter, 0, failure.timeoutFailureInfo.lastHeartbeatDetails?.payloads),
        failure.timeoutFailureInfo.timeoutType ?? TimeoutType.TIMEOUT_TYPE_UNSPECIFIED
      );
    }
    if (failure.terminatedFailureInfo) {
      return new TerminatedFailure(
        failure.message ?? undefined,
        this.optionalFailureToOptionalError(failure.cause, payloadConverter)
      );
    }
    if (failure.canceledFailureInfo) {
      return new CancelledFailure(
        failure.message ?? undefined,
        arrayFromPayloads(payloadConverter, failure.canceledFailureInfo.details?.payloads),
        this.optionalFailureToOptionalError(failure.cause, payloadConverter)
      );
    }
    if (failure.resetWorkflowFailureInfo) {
      return new ApplicationFailure(
        failure.message ?? undefined,
        'ResetWorkflow',
        false,
        arrayFromPayloads(payloadConverter, failure.resetWorkflowFailureInfo.lastHeartbeatDetails?.payloads),
        this.optionalFailureToOptionalError(failure.cause, payloadConverter)
      );
    }
    if (failure.childWorkflowExecutionFailureInfo) {
      const { namespace, workflowType, workflowExecution, retryState } = failure.childWorkflowExecutionFailureInfo;
      if (!(workflowType?.name && workflowExecution)) {
        throw new TypeError('Missing attributes on childWorkflowExecutionFailureInfo');
      }
      return new ChildWorkflowFailure(
        namespace ?? undefined,
        workflowExecution,
        workflowType.name,
        retryState ?? RetryState.RETRY_STATE_UNSPECIFIED,
        this.optionalFailureToOptionalError(failure.cause, payloadConverter)
      );
    }
    if (failure.activityFailureInfo) {
      if (!failure.activityFailureInfo.activityType?.name) {
        throw new TypeError('Missing activityType?.name on activityFailureInfo');
      }
      return new ActivityFailure(
        failure.message ?? undefined,
        failure.activityFailureInfo.activityType.name,
        failure.activityFailureInfo.activityId ?? undefined,
        failure.activityFailureInfo.retryState ?? RetryState.RETRY_STATE_UNSPECIFIED,
        failure.activityFailureInfo.identity ?? undefined,
        this.optionalFailureToOptionalError(failure.cause, payloadConverter)
      );
    }
    return new TemporalFailure(
      failure.message ?? undefined,
      this.optionalFailureToOptionalError(failure.cause, payloadConverter)
    );
  }

  failureToError(failure: ProtoFailure, payloadConverter: PayloadConverter): Error {
    if (failure.encodedAttributes) {
      const attrs = payloadConverter.fromPayload<DefaultEncodedFailureAttributes>(failure.encodedAttributes);
      // Don't apply encodedAttributes unless they conform to an expected schema
      if (typeof attrs === 'object' && attrs !== null) {
        const { message, stack_trace } = attrs;
        // Avoid mutating the argument
        failure = { ...failure };
        if (typeof message === 'string') {
          failure.message = message;
        }
        if (typeof stack_trace === 'string') {
          failure.stackTrace = stack_trace;
        }
      }
    }
    const err = this.failureToErrorInner(failure, payloadConverter);
    err.stack = failure.stackTrace ?? '';
    err.failure = failure;
    return err;
  }

  errorToFailure(err: unknown, payloadConverter: PayloadConverter): ProtoFailure {
    const failure = this.errorToFailureInner(err, payloadConverter);
    if (this.options.encodeCommonAttributes) {
      const { message, stackTrace } = failure;
      failure.message = 'Encoded failure';
      failure.stackTrace = '';
      failure.encodedAttributes = payloadConverter.toPayload({ message, stack_trace: stackTrace });
    }
    return failure;
  }

  errorToFailureInner(err: unknown, payloadConverter: PayloadConverter): ProtoFailure {
    if (err instanceof TemporalFailure) {
      if (err.failure) return err.failure;
      const base = {
        message: err.message,
        stackTrace: cutoffStackTrace(err.stack),
        cause: this.optionalErrorToOptionalFailure(err.cause, payloadConverter),
        source: FAILURE_SOURCE,
      };

      if (err instanceof ActivityFailure) {
        return {
          ...base,
          activityFailureInfo: {
            ...err,
            activityType: { name: err.activityType },
          },
        };
      }
      if (err instanceof ChildWorkflowFailure) {
        return {
          ...base,
          childWorkflowExecutionFailureInfo: {
            ...err,
            workflowExecution: err.execution,
            workflowType: { name: err.workflowType },
          },
        };
      }
      if (err instanceof ApplicationFailure) {
        return {
          ...base,
          applicationFailureInfo: {
            type: err.type,
            nonRetryable: err.nonRetryable,
            details:
              err.details && err.details.length
                ? { payloads: toPayloads(payloadConverter, ...err.details) }
                : undefined,
          },
        };
      }
      if (err instanceof CancelledFailure) {
        return {
          ...base,
          canceledFailureInfo: {
            details:
              err.details && err.details.length
                ? { payloads: toPayloads(payloadConverter, ...err.details) }
                : undefined,
          },
        };
      }
      if (err instanceof TimeoutFailure) {
        return {
          ...base,
          timeoutFailureInfo: {
            timeoutType: err.timeoutType,
            lastHeartbeatDetails: err.lastHeartbeatDetails
              ? { payloads: toPayloads(payloadConverter, err.lastHeartbeatDetails) }
              : undefined,
          },
        };
      }
      if (err instanceof TerminatedFailure) {
        return {
          ...base,
          terminatedFailureInfo: {},
        };
      }
      if (err instanceof ServerFailure) {
        return {
          ...base,
          serverFailureInfo: { nonRetryable: err.nonRetryable },
        };
      }
      // Just a TemporalFailure
      return base;
    }

    const base = {
      source: FAILURE_SOURCE,
    };

    if (isRecord(err) && hasOwnProperties(err, ['message', 'stack'])) {
      return {
        ...base,
        message: String(err.message) ?? '',
        stackTrace: cutoffStackTrace(String(err.stack)),
        cause: this.optionalErrorToOptionalFailure(err.cause, payloadConverter),
      };
    }

    const recommendation = ` [A non-Error value was thrown from your code. We recommend throwing Error objects so that we can provide a stack trace]`;

    if (typeof err === 'string') {
      return { ...base, message: err + recommendation };
    }
    if (typeof err === 'object') {
      let message = '';
      try {
        message = JSON.stringify(err);
      } catch (_err) {
        message = String(err);
      }
      return { ...base, message: message + recommendation };
    }

    return { ...base, message: String(err) + recommendation };
  }

  /**
   * Converts a Failure proto message to a JS Error object if defined or returns undefined.
   */
  optionalFailureToOptionalError(
    failure: ProtoFailure | undefined | null,
    payloadConverter: PayloadConverter
  ): Error | undefined {
    return failure ? this.failureToError(failure, payloadConverter) : undefined;
  }

  /**
   * Converts an error to a Failure proto message if defined or returns undefined
   */
  optionalErrorToOptionalFailure(err: unknown, payloadConverter: PayloadConverter): ProtoFailure | undefined {
    return err ? this.errorToFailure(err, payloadConverter) : undefined;
  }
}
