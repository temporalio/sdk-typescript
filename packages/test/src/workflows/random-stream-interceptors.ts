import { getRandomStream, uuid4, workflowInfo, withRandomStream, WorkflowInterceptors } from '@temporalio/workflow';
import type { WorkflowRandomStream } from '@temporalio/workflow';

const pluginNamedStreamDoesNotConsumeMain = 'randomStreamPluginNamedStreamDoesNotConsumeMain';
const pluginNamedStreamNamespaceBaseline = 'randomStreamPluginNamedStreamNamespaceBaseline';
const pluginNamedStreamNamespaceIsolation = 'randomStreamPluginNamedStreamNamespaceIsolation';
const pluginActivationBaseline = 'randomStreamPluginActivationBaseline';
const pluginActivationWithWorkflowInterference = 'randomStreamPluginActivationWithWorkflowInterference';
const pluginScopedMathAcrossAwaitBaseline = 'randomStreamPluginScopedMathAcrossAwaitBaseline';
const pluginScopedMathAcrossAwaitBeforeNext = 'randomStreamPluginScopedMathAcrossAwaitBeforeNext';
const pluginScopedUuidAcrossAwaitBaseline = 'randomStreamPluginScopedUuidAcrossAwaitBaseline';
const pluginScopedUuidAcrossAwaitBeforeNext = 'randomStreamPluginScopedUuidAcrossAwaitBeforeNext';
const pluginScopedMathAroundNext = 'randomStreamPluginScopedMathAroundNext';
const pluginScopedUuidAroundNext = 'randomStreamPluginScopedUuidAroundNext';
const pluginOutboundTimerNamedStream = 'randomStreamPluginOutboundTimerNamedStream';
const pluginCachedStreamSingleActivation = 'randomStreamPluginCachedStreamSingleActivation';
const pluginCachedStreamAcrossActivations = 'randomStreamPluginCachedStreamAcrossActivations';

const pluginActivationWorkflowTypes = new Set([pluginActivationBaseline, pluginActivationWithWorkflowInterference]);
const pluginScopedWorkflowTypes = new Set([pluginScopedMathAroundNext, pluginScopedUuidAroundNext]);
const pluginCachedStreamWorkflowTypes = new Set([pluginCachedStreamSingleActivation, pluginCachedStreamAcrossActivations]);

export const interceptors = (): WorkflowInterceptors => {
  // Keep the wrapper alive across activations to verify that updateRandomSeed
  // invalidates Activator state rather than requiring callers to reacquire streams.
  let cachedConcludeStream: WorkflowRandomStream | undefined;

  return {
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
            case pluginScopedMathAcrossAwaitBaseline: {
              const stream = getRandomStream('@temporalio/test/random-streams/plugin-scoped');
              console.log('plugin-scoped', stream.random());
              console.log('plugin-scoped', stream.random());
              return next(input);
            }
            case pluginScopedMathAcrossAwaitBeforeNext:
              await withRandomStream('@temporalio/test/random-streams/plugin-scoped', async () => {
                console.log('plugin-scoped', Math.random());
                await Promise.resolve();
                console.log('plugin-scoped', Math.random());
              });
              return next(input);
            case pluginScopedUuidAcrossAwaitBaseline: {
              const stream = getRandomStream('@temporalio/test/random-streams/plugin-scoped');
              console.log('plugin-scoped-uuid', stream.uuid4());
              console.log('plugin-scoped-uuid', stream.uuid4());
              return next(input);
            }
            case pluginScopedUuidAcrossAwaitBeforeNext:
              await withRandomStream('@temporalio/test/random-streams/plugin-scoped', async () => {
                console.log('plugin-scoped-uuid', uuid4());
                await Promise.resolve();
                console.log('plugin-scoped-uuid', uuid4());
              });
              return next(input);
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
        }
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
      {
        concludeActivation(input, next) {
          if (pluginCachedStreamWorkflowTypes.has(workflowInfo().workflowType)) {
            if (cachedConcludeStream === undefined) {
              cachedConcludeStream = getRandomStream('@temporalio/test/random-streams/plugin-conclude');
            }
            console.log('plugin-conclude', cachedConcludeStream.random());
          }
          return next(input);
        },
      },
    ],
  };
};
