import * as nexus from 'nexus-rpc';
import Long from 'long';
import type { temporal } from '@temporalio/proto';
import {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  ChildWorkflowFailure,
  decodeApplicationFailureCategory,
  decodeRetryState,
  decodeTimeoutType,
  encodeApplicationFailureCategory,
  encodeRetryState,
  encodeTimeoutType,
  FAILURE_SOURCE,
  NexusOperationFailure,
  ProtoFailure,
  ServerFailure,
  TemporalFailure,
  TerminatedFailure,
  TimeoutFailure,
} from '../failure';
import { makeProtoEnumConverters } from '../internal-workflow';
import { isError } from '../type-helpers';
import { msOptionalToTs } from '../time';
import { arrayFromPayloads, fromPayloadsAtIndex, PayloadConverter, toPayloads } from './payload-converter';

// Can't import proto enums into the workflow sandbox, use this helper type and enum converter instead.
const NexusHandlerErrorRetryBehavior = {
  RETRYABLE: 'RETRYABLE',
  NON_RETRYABLE: 'NON_RETRYABLE',
} as const;

type NexusHandlerErrorRetryBehavior =
  (typeof NexusHandlerErrorRetryBehavior)[keyof typeof NexusHandlerErrorRetryBehavior];

const [encodeNexusHandlerErrorRetryBehavior, decodeNexusHandlerErrorRetryBehavior] = makeProtoEnumConverters<
  temporal.api.enums.v1.NexusHandlerErrorRetryBehavior,
  typeof temporal.api.enums.v1.NexusHandlerErrorRetryBehavior,
  keyof typeof temporal.api.enums.v1.NexusHandlerErrorRetryBehavior,
  typeof NexusHandlerErrorRetryBehavior,
  'NEXUS_HANDLER_ERROR_RETRY_BEHAVIOR_'
>(
  {
    UNSPECIFIED: 0,
    [NexusHandlerErrorRetryBehavior.RETRYABLE]: 1,
    [NexusHandlerErrorRetryBehavior.NON_RETRYABLE]: 2,
  } as const,
  'NEXUS_HANDLER_ERROR_RETRY_BEHAVIOR_'
);

function combineRegExp(...regexps: RegExp[]): RegExp {
  return new RegExp(regexps.map((x) => `(?:${x.source})`).join('|'));
}

/**
 * Stack traces will be cutoff when on of these patterns is matched
 */
const CUTOFF_STACK_PATTERNS = combineRegExp(
  /** Activity execution */
  /\s+at Activity\.execute \(.*[\\/]worker[\\/](?:src|lib)[\\/]activity\.[jt]s:\d+:\d+\)/,
  /** Nexus execution */
  /\s+at( async)? NexusHandler\.invokeUserCode \(.*[\\/]worker[\\/](?:src|lib)[\\/]nexus[\\/]index\.[jt]s:\d+:\d+\)/,
  /** Workflow activation */
  /\s+at Activator\.\S+NextHandler \(.*[\\/]workflow[\\/](?:src|lib)[\\/]internals\.[jt]s:\d+:\d+\)/,
  /** Workflow run anything in context */
  /\s+at Script\.runInContext \((?:node:vm|vm\.js):\d+:\d+\)/
);

/**
 * Any stack trace frames that match any of those wil be dopped.
 * The "null." prefix on some cases is to avoid https://github.com/nodejs/node/issues/42417
 */
const DROPPED_STACK_FRAMES_PATTERNS = combineRegExp(
  /** Internal functions used to recursively chain interceptors */
  /\s+at (null\.)?next \(.*[\\/]common[\\/](?:src|lib)[\\/]interceptors\.[jt]s:\d+:\d+\)/,
  /** Internal functions used to recursively chain interceptors */
  /\s+at (null\.)?executeNextHandler \(.*[\\/]worker[\\/](?:src|lib)[\\/]activity\.[jt]s:\d+:\d+\)/
);

/**
 * Cuts out the framework part of a stack trace, leaving only user code entries
 */
export function cutoffStackTrace(stack?: string): string {
  const lines = (stack ?? '').split(/\r?\n/);
  const acc = Array<string>();
  for (const line of lines) {
    if (CUTOFF_STACK_PATTERNS.test(line)) break;
    if (!DROPPED_STACK_FRAMES_PATTERNS.test(line)) acc.push(line);
  }
  return acc.join('\n');
}

/**
 * A `FailureConverter` is responsible for converting from proto `Failure` instances to JS `Errors` and back.
 *
 * We recommended using the {@link DefaultFailureConverter} instead of customizing the default implementation in order
 * to maintain cross-language Failure serialization compatibility.
 */
export interface FailureConverter {
  /**
   * Converts a caught error to a Failure proto message.
   */
  errorToFailure(err: unknown, payloadConverter: PayloadConverter): ProtoFailure;

  /**
   * Converts a Failure proto message to a JS Error object.
   *
   * The returned error must be an instance of `TemporalFailure`.
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
  failureToErrorInner(failure: ProtoFailure, payloadConverter: PayloadConverter): Error {
    if (failure.applicationFailureInfo) {
      return new ApplicationFailure(
        failure.message ?? undefined,
        failure.applicationFailureInfo.type,
        Boolean(failure.applicationFailureInfo.nonRetryable),
        arrayFromPayloads(payloadConverter, failure.applicationFailureInfo.details?.payloads),
        this.optionalFailureToOptionalError(failure.cause, payloadConverter),
        undefined,
        decodeApplicationFailureCategory(failure.applicationFailureInfo.category)
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
        decodeTimeoutType(failure.timeoutFailureInfo.timeoutType)
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
        decodeRetryState(retryState),
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
        decodeRetryState(failure.activityFailureInfo.retryState),
        failure.activityFailureInfo.identity ?? undefined,
        this.optionalFailureToOptionalError(failure.cause, payloadConverter)
      );
    }
    if (failure.nexusHandlerFailureInfo) {
      let retryableOverride: boolean | undefined = undefined;
      const retryBehavior = decodeNexusHandlerErrorRetryBehavior(failure.nexusHandlerFailureInfo.retryBehavior);
      switch (retryBehavior) {
        case 'RETRYABLE':
          retryableOverride = true;
          break;
        case 'NON_RETRYABLE':
          retryableOverride = false;
          break;
      }

      return new nexus.HandlerError(
        (failure.nexusHandlerFailureInfo.type as nexus.HandlerErrorType) ?? 'INTERNAL',
        // TODO(nexus/error): Maybe set a default message here, once we've decided on error handling.
        failure.message ?? undefined,
        {
          cause: this.optionalFailureToOptionalError(failure.cause, payloadConverter),
          retryableOverride,
        }
      );
    }
    if (failure.nexusOperationExecutionFailureInfo) {
      return new NexusOperationFailure(
        // TODO(nexus/error): Maybe set a default message here, once we've decided on error handling.
        failure.message ?? undefined,
        failure.nexusOperationExecutionFailureInfo.scheduledEventId?.toNumber(),
        // We assume these will always be set or gracefully set to empty strings.
        failure.nexusOperationExecutionFailureInfo.endpoint ?? '',
        failure.nexusOperationExecutionFailureInfo.service ?? '',
        failure.nexusOperationExecutionFailureInfo.operation ?? '',
        failure.nexusOperationExecutionFailureInfo.operationToken ?? undefined,
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
    if (err instanceof TemporalFailure) {
      err.failure = failure;
    }
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
    // TODO(nexus/error): If we decide not to have a NexusHandlerFailure, we could still attach the
    //                    failure proto to the Nexus HandlerError object, by using a private symbol
    //                    property. To be considered once we have a decision on error handling.
    if (err instanceof TemporalFailure || err instanceof nexus.HandlerError) {
      if (err instanceof TemporalFailure && err.failure) return err.failure;
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
            retryState: encodeRetryState(err.retryState),
            activityType: { name: err.activityType },
          },
        };
      }
      if (err instanceof ChildWorkflowFailure) {
        return {
          ...base,
          childWorkflowExecutionFailureInfo: {
            ...err,
            retryState: encodeRetryState(err.retryState),
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
            nextRetryDelay: msOptionalToTs(err.nextRetryDelay),
            category: encodeApplicationFailureCategory(err.category),
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
            timeoutType: encodeTimeoutType(err.timeoutType),
            lastHeartbeatDetails: err.lastHeartbeatDetails
              ? { payloads: toPayloads(payloadConverter, err.lastHeartbeatDetails) }
              : undefined,
          },
        };
      }
      if (err instanceof ServerFailure) {
        return {
          ...base,
          serverFailureInfo: { nonRetryable: err.nonRetryable },
        };
      }
      if (err instanceof TerminatedFailure) {
        return {
          ...base,
          terminatedFailureInfo: {},
        };
      }
      if (err instanceof nexus.HandlerError) {
        let retryBehavior: temporal.api.enums.v1.NexusHandlerErrorRetryBehavior | undefined = undefined;
        switch (err.retryableOverride) {
          case true:
            retryBehavior = encodeNexusHandlerErrorRetryBehavior('RETRYABLE');
            break;
          case false:
            retryBehavior = encodeNexusHandlerErrorRetryBehavior('NON_RETRYABLE');
            break;
        }

        return {
          // TODO(nexus/error): Maybe set a default message here, once we've decided on error handling.
          ...base,
          nexusHandlerFailureInfo: {
            type: err.type,
            retryBehavior,
          },
        };
      }
      if (err instanceof NexusOperationFailure) {
        return {
          // TODO(nexus/error): Maybe set a default message here, once we've decided on error handling.
          ...base,
          nexusOperationExecutionFailureInfo: {
            scheduledEventId: err.scheduledEventId ? Long.fromNumber(err.scheduledEventId) : undefined,
            endpoint: err.endpoint,
            service: err.service,
            operation: err.operation,
            operationToken: err.operationToken,
          },
        };
      }
      // Just a TemporalFailure
      return base;
    }

    const base = {
      source: FAILURE_SOURCE,
    };

    if (isError(err)) {
      return {
        ...base,
        message: String(err.message) ?? '',
        stackTrace: cutoffStackTrace(err.stack),
        cause: this.optionalErrorToOptionalFailure((err as any).cause, payloadConverter),
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
