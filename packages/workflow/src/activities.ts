import {
    ActivityCancellationType,
    encodeActivityCancellationType,
    decodeActivityCancellationType,
    type ActivityOptions as ActivityOptionsCommon,
    type LocalActivityOptions as LocalActivityOptionsCommon,
} from '@temporalio/common/lib/activity-options';
import type { EventGroupMarker } from './event-groups';

/**
 * Options for non-local activity invocation inside a workflow.
 * 
 * @interface
 */
export type ActivityOptions = ActivityOptionsCommon & {
    /**
     * Event group markers to attach to this local activity. The markers will be reflected on the
     * corresponding workflow history events, and may be used by tooling (UI/CLI) to group
     * related events together. See {@link EventGroupMarker} and `createGroup` in the workflow
     * package.
     *
     * @experimental Event Groups is a new API and may change without notice.
     */
    eventGroups?: EventGroupMarker[];
};

/**
 * Options for local activity invocation.
 * 
 * @interface
 */
export type LocalActivityOptions = LocalActivityOptionsCommon & {
    /**
     * Event group markers to attach to this local activity. The markers will be reflected on the
     * corresponding workflow history events, and may be used by tooling (UI/CLI) to group
     * related events together. See {@link EventGroupMarker} and `createGroup` in the workflow
     * package.
     *
     * @experimental Event Groups is a new API and may change without notice.
     */
    eventGroups?: EventGroupMarker[];
};

export {
    ActivityCancellationType,
    encodeActivityCancellationType,
    decodeActivityCancellationType,
}
