/**
 * Type definitions for the Workflow end of the external dependencies mechanism.
 *
 * External dependencies are functions injected into a Workflow isolate from the main Node.js isolate.
 *
 * Dependency functions may not return values to the Workflow in order to prevent breaking determinism.
 *
 * @experimental
 *
 * @module
 */

/**
 * Any function signature can be used for dependency functions as long as the return type is `void`.
 *
 * When calling a dependency function, arguments and return value are copied between the Workflow isolate and the Node.js.
 * This constrains the argument types to primitives (excluding Symbols).
 */
export type ExternalDependencyFunction = (...args: any[]) => void;
/** A mapping of name to function, defines a single external dependency (e.g. logger) */
export type ExternalDependency = Record<string, ExternalDependencyFunction>;
/**
 * Workflow dependencies are a mapping of name to {@link ExternalDependency}
 */
export type ExternalDependencies = Record<string, ExternalDependency>;

/**
 * Call information for external dependencies
 */
export interface ExternalCall {
  ifaceName: string;
  fnName: string;
  args: any[];
}
