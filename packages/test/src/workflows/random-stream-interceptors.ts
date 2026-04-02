import { getRandomStream, workflowInfo, withRandomStream, WorkflowInterceptors } from '@temporalio/workflow';

const pluginNamedStreamDoesNotConsumeMain = 'randomStreamPluginNamedStreamDoesNotConsumeMain';
const pluginNamedStreamNamespaceBaseline = 'randomStreamPluginNamedStreamNamespaceBaseline';
const pluginNamedStreamNamespaceIsolation = 'randomStreamPluginNamedStreamNamespaceIsolation';
const pluginActivationBaseline = 'randomStreamPluginActivationBaseline';
const pluginActivationWithWorkflowInterference = 'randomStreamPluginActivationWithWorkflowInterference';
const pluginScopedMathAroundNext = 'randomStreamPluginScopedMathAroundNext';
const pluginScopedUuidAroundNext = 'randomStreamPluginScopedUuidAroundNext';
const pluginOutboundTimerNamedStream = 'randomStreamPluginOutboundTimerNamedStream';

const pluginActivationWorkflowTypes = new Set([pluginActivationBaseline, pluginActivationWithWorkflowInterference]);
const pluginScopedWorkflowTypes = new Set([pluginScopedMathAroundNext, pluginScopedUuidAroundNext]);

export const interceptors = (): WorkflowInterceptors => ({
  inbound: [
    {
      async execute(input, next) {
        switch (workflowInfo().workflowType) {
          case pluginNamedStreamDoesNotConsumeMain:
            console.log('plugin', getRandomStream('@temporalio/test/random-streams/plugin').random());
            return next(input);
          case pluginNamedStreamNamespaceBaseline: {
            const stream = getRandomStream('@temporalio/test/random-streams/plugin-a');
            console.log('plugin-a', stream.random());
            console.log('plugin-a', stream.random());
            return next(input);
          }
          case pluginNamedStreamNamespaceIsolation: {
            const stream = getRandomStream('@temporalio/test/random-streams/plugin-a');
            console.log('plugin-a', stream.random());
            console.log('plugin-b', getRandomStream('@temporalio/test/random-streams/plugin-b').random());
            console.log('plugin-a', stream.random());
            return next(input);
          }
          default:
            break;
        }

        if (!pluginScopedWorkflowTypes.has(workflowInfo().workflowType)) {
          return next(input);
        }

        return await withRandomStream('@temporalio/test/random-streams/plugin-scoped', async () => {
          console.log('plugin-scoped', Math.random());
          const result = await next(input);
          console.log('plugin-scoped', Math.random());
          return result;
        });
      },
    },
  ],
  outbound: [
    {
      async startTimer(input, next) {
        if (workflowInfo().workflowType === pluginOutboundTimerNamedStream) {
          console.log('plugin-outbound', getRandomStream('@temporalio/test/random-streams/plugin-outbound').random());
        }
        return next(input);
      },
    },
  ],
  internals: [
    {
      activate(input, next) {
        if (pluginActivationWorkflowTypes.has(workflowInfo().workflowType)) {
          console.log('plugin-activation', getRandomStream('@temporalio/test/random-streams/plugin-activation').random());
        }
        return next(input);
      },
    },
  ],
});
