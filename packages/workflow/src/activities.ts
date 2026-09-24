import {
  ActivityCancellationType,
  encodeActivityCancellationType,
  decodeActivityCancellationType,
  type ActivityOptions as ActivityOptionsCommon,
  type LocalActivityOptions as LocalActivityOptionsCommon,
} from '@temporalio/common/lib/activity-options';
import type { EventGroup } from './event-groups';

/**
 * Options for non-local activity invocation inside a workflow.
 *
 * @interface
 */
export type ActivityOptions = ActivityOptionsCommon & {
  /**
   * Event Groups to attach to this activity. They will be reflected on the corresponding
   * workflow history events, and may be used by tooling (UI/CLI) to group related events
   * together. See {@link EventGroup} and {@link createEventGroup}.
   *
   * @experimental Event Groups is an experimental API and may change without notice.
   */
  eventGroups?: EventGroup[];
};

/**
 * Options for local activity invocation.
 *
 * @interface
 */
export type LocalActivityOptions = LocalActivityOptionsCommon & {
  /**
   * Event Groups to attach to this local activity. They will be reflected on the corresponding
   * workflow history events, and may be used by tooling (UI/CLI) to group related events
   * together. See {@link EventGroup} and {@link createEventGroup}.
   *
   * @experimental Event Groups is an experimental API and may change without notice.
   */
  eventGroups?: EventGroup[];
};

export { ActivityCancellationType, encodeActivityCancellationType, decodeActivityCancellationType };
