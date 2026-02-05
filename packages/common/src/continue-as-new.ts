import { temporal } from '@temporalio/proto';
import { makeProtoEnumConverters } from './internal-workflow';

/**
 * Reason(s) why continue as new is suggested. Can potentially be multiple reasons.
 *
 * @experimental Versioning semantics with continue-as-new are experimental and may change in the future.
 */
export const SuggestContinueAsNewReason = {
  HISTORY_SIZE_TOO_LARGE: 'HISTORY_SIZE_TOO_LARGE',
  TOO_MANY_HISTORY_EVENTS: 'TOO_MANY_HISTORY_EVENTS',
  TOO_MANY_UPDATES: 'TOO_MANY_UPDATES',
  TARGET_WORKER_DEPLOYMENT_VERSION_CHANGED: 'TARGET_WORKER_DEPLOYMENT_VERSION_CHANGED',
} as const;
export type SuggestContinueAsNewReason = (typeof SuggestContinueAsNewReason)[keyof typeof SuggestContinueAsNewReason];

export const [encodeSuggestContinueAsNewReason, decodeSuggestContinueAsNewReason] = makeProtoEnumConverters<
  temporal.api.enums.v1.SuggestContinueAsNewReason,
  typeof temporal.api.enums.v1.SuggestContinueAsNewReason,
  keyof typeof temporal.api.enums.v1.SuggestContinueAsNewReason,
  typeof SuggestContinueAsNewReason,
  'SUGGEST_CONTINUE_AS_NEW_REASON_'
>(
  {
    [SuggestContinueAsNewReason.HISTORY_SIZE_TOO_LARGE]: 1,
    [SuggestContinueAsNewReason.TOO_MANY_HISTORY_EVENTS]: 2,
    [SuggestContinueAsNewReason.TOO_MANY_UPDATES]: 3,
    [SuggestContinueAsNewReason.TARGET_WORKER_DEPLOYMENT_VERSION_CHANGED]: 4,
    UNSPECIFIED: 0,
  } as const,
  'SUGGEST_CONTINUE_AS_NEW_REASON_'
);

export function suggestContinueAsNewReasonsFromProto(
  reasons: temporal.api.enums.v1.SuggestContinueAsNewReason[] | null | undefined
): SuggestContinueAsNewReason[] | undefined {
  if (reasons == null) {
    return undefined;
  }

  const res: SuggestContinueAsNewReason[] = [];
  for (const r of reasons) {
    const decoded = decodeSuggestContinueAsNewReason(r);
    if (decoded !== undefined) {
      res.push(decoded);
    }
  }
  if (res.length === 0) {
    return undefined;
  }
  return res;
}
