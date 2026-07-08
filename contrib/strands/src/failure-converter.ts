import { ContextWindowOverflowError, MaxTokensError, StructuredOutputError } from '@strands-agents/sdk';
import {
  ApplicationFailure,
  DefaultFailureConverter,
  type FailureConverter,
  type PayloadConverter,
  type ProtoFailure,
  type SerializationContext,
} from '@temporalio/common';

export const STRANDS_INTERRUPT_TYPE = 'StrandsInterrupt';

// Strands does not re-export `InterruptError` from its public index, so detect
// it structurally instead of via `instanceof`.
interface InterruptLike {
  toJSON(): { id: string; name: string; reason?: unknown; response?: unknown; source: string };
}

function isInterruptError(err: unknown): err is { interrupts: InterruptLike[] } {
  if (err === null || typeof err !== 'object') return false;
  const candidate = err as { interrupts?: unknown };
  if (!Array.isArray(candidate.interrupts) || candidate.interrupts.length === 0) return false;
  const first = candidate.interrupts[0] as { toJSON?: unknown } | undefined;
  return typeof first?.toJSON === 'function';
}

const TERMINAL_ERROR_TYPES = [
  { ctor: ContextWindowOverflowError, name: 'ContextWindowOverflowError' },
  { ctor: MaxTokensError, name: 'MaxTokensError' },
  { ctor: StructuredOutputError, name: 'StructuredOutputError' },
];

function rewriteError(err: unknown): unknown {
  if (isInterruptError(err)) {
    const details = err.interrupts.map((i) => i.toJSON());
    const names = err.interrupts.map((i) => i.toJSON().name).join(',');
    return ApplicationFailure.create({
      message: `interrupt:${names}`,
      type: STRANDS_INTERRUPT_TYPE,
      nonRetryable: true,
      details,
    });
  }
  if (err instanceof Error) {
    for (const { ctor, name } of TERMINAL_ERROR_TYPES) {
      if (err instanceof ctor) {
        return ApplicationFailure.create({
          message: err.message,
          type: name,
          nonRetryable: true,
        });
      }
    }
  }
  return err;
}

/**
 * Failure converter that preserves Strands `InterruptError` payloads across the
 * activity boundary as typed, non-retryable {@link ApplicationFailure}s and
 * marks deterministic Strands model errors as non-retryable.
 *
 * Read by the worker and client via {@link DataConverter.failureConverterPath};
 * the named export below is what {@link StrandsPlugin} wires in.
 */
export class StrandsFailureConverter extends DefaultFailureConverter implements FailureConverter {
  override errorToFailure(
    err: unknown,
    payloadConverter: PayloadConverter,
    context?: SerializationContext
  ): ProtoFailure {
    return super.errorToFailure(rewriteError(err), payloadConverter, context);
  }
}

export const failureConverter: FailureConverter = new StrandsFailureConverter();
