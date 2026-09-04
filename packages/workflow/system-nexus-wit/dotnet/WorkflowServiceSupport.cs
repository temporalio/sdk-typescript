using Temporalio.Converters;
using Temporalio.Workflows;

namespace Nexgen.Support
{
    internal static class WorkflowServiceSerializationContexts
    {
        internal static ISerializationContext SignalWithStartWorkflow(SignalWithStartWorkflowRequest request) =>
            new ISerializationContext.Workflow(request.Namespace, request.Id);
    }
}
