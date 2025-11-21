/**
 * Indicates whether the user intends certain commands to be run on a compatible worker Build Id version or not.
 *
 * `COMPATIBLE` indicates that the command should run on a worker with compatible version if possible. It may not be
 * possible if the target task queue does not also have knowledge of the current worker's Build Id.
 *
 * `DEFAULT` indicates that the command should run on the target task queue's current overall-default Build Id.
 *
 * Where this type is accepted optionally, an unset value indicates that the SDK should choose the most sensible default
 * behavior for the type of command, accounting for whether the command will be run on the same task queue as the
 * current worker. The default behavior for starting Workflows is `DEFAULT`. The default behavior for Workflows starting
 * Activities, starting Child Workflows, or Continuing As New is `COMPATIBLE`.
 *
 * @deprecated In favor of the new Worker Deployment API.
 * @experimental The Worker Versioning API is still being designed. Major changes are expected.
 */
export type VersioningIntent = 'COMPATIBLE' | 'DEFAULT';
