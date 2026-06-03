/**
 * Live Nexus service + handler for the comprehensive trace-tree test.
 *
 * The handler body runs an unchanged native `traceable` (`nexus_inner_call`) so
 * the test proves trace context propagates from the workflow into the Nexus
 * operation handler and that the handler-body run nests under
 * `RunStartNexusOperationHandler:`.
 *
 * @module
 */

import { traceable } from 'langsmith/traceable';
import * as nexus from 'nexus-rpc';

export interface GreetInput {
  name: string;
}

export interface GreetOutput {
  greeting: string;
}

export const comprehensiveNexusService = nexus.service('comprehensiveNexusService', {
  greet: nexus.operation<GreetInput, GreetOutput>(),
});

export const comprehensiveNexusServiceHandler = nexus.serviceHandler(comprehensiveNexusService, {
  async greet(_ctx, input): Promise<GreetOutput> {
    const inner = traceable(async (name: string): Promise<string> => `hi:${name}`, { name: 'nexus_inner_call' });
    return { greeting: await inner(input.name) };
  },
});
