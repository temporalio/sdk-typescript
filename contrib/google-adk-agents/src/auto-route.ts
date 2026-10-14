/**
 * Routes raw model strings through Temporal inside the Workflow sandbox.
 *
 * ADK resolves an agent's `model: 'gemini-2.5-flash'` through its `LLMRegistry`
 * into a real `Gemini` (or `ApigeeLlm`) instance, which then attempts a live
 * network call. Inside a Workflow that call has nowhere to go: the sandbox has
 * no `fetch`, the auth libraries are aliased to empty modules, and the error
 * names neither ADK nor the real mistake (see the README's troubleshooting
 * entry). A model that performs I/O from Workflow code is *always* wrong there,
 * so this module re-registers every built-in model class's patterns to a
 * {@link TemporalModel} subclass — the same class a user gets by wrapping the
 * string by hand — with default Activity options. Wrap explicitly
 * (`new TemporalModel(name, options)`) to customize timeouts, retries or
 * streaming.
 *
 * Registry mechanics this relies on (`@google/adk` `models/registry.ts`): the
 * registry is a `Map` keyed by the `string | RegExp` entries of each class's
 * `supportedModels`, matched first-registered-first, and `register` overwrites
 * an entry only when the key is the **same object**. Spreading the built-in
 * classes' own `supportedModels` arrays therefore replaces their entries in
 * place instead of appending unreachable duplicates behind them.
 *
 * Scope: evaluated per Workflow (as a `workflowInterceptorModules` entry, after
 * `load-polyfills`) with the activator installed, so `inWorkflowContext()` is
 * true and the registration lands in that Workflow's private module state
 * before any user code resolves a model name. On the worker, in tests, and in
 * direct ADK use the gate is false and the real classes stay registered — which
 * also keeps `TemporalModel`'s own outside-Workflow delegation to
 * `LLMRegistry.newLlm` from recursing into itself.
 *
 * Disable with `GoogleAdkPluginOptions.autoRouteModels: false`, which leaves
 * this module out of the bundle's interceptor list.
 */

import { ApigeeLlm, Gemini, LLMRegistry } from '@google/adk';
import { inWorkflowContext, type WorkflowInterceptorsFactory } from '@temporalio/workflow';

import { TemporalModel } from './model';

/**
 * The {@link TemporalModel} the registry constructs for a built-in model name.
 * The registry instantiates with `new Cls({ model })`, hence the object-form
 * constructor; options are the defaults.
 */
class AutoRoutedTemporalModel extends TemporalModel {
  static override readonly supportedModels: Array<string | RegExp> = [
    ...Gemini.supportedModels,
    ...ApigeeLlm.supportedModels,
  ];

  constructor({ model }: { model: string }) {
    super(model);
  }
}

// Satisfies the documented interceptor-module contract (modules on
// `workflowInterceptorModules` export an `interceptors` factory); this module
// is on that list purely for its load-time side effect, so it registers none.
// ts-prune-ignore-next (loaded by path from workflowInterceptorModules)
export const interceptors: WorkflowInterceptorsFactory = () => ({});

if (inWorkflowContext()) {
  LLMRegistry.register(AutoRoutedTemporalModel);
}
