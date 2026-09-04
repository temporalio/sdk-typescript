// Local workflow API proxy used by generated System Nexus bindings. Keep this
// narrow so generated operation exports do not create an index-module cycle.
export type { SignalDefinition } from '@temporalio/common';
export {
  startSystemNexusOperation,
  systemNexusPayloadConverter,
  withSystemNexusSerializationContext,
} from '../../nexus';
export { getExternalWorkflowHandle, workflowInfo } from '../../workflow';
export type { ExternalWorkflowHandle } from '../../workflow-handle';
