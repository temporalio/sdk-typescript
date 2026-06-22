/**
 * `npm i @temporalio/interceptors-opentelemetry-v2`
 *
 * Interceptors that add OpenTelemetry tracing.
 *
 * [Documentation](https://docs.temporal.io/typescript/logging#opentelemetry-tracing)
 *
 * @module
 */

export * from './plugin';
export * from './workflow';
export * from './worker';
export { OpenTelemetryWorkflowClientInterceptor } from './client';
