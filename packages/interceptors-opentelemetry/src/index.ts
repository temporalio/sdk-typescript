/**
 * `npm i @temporalio/interceptors-opentelemetry`
 *
 * Interceptors that add OpenTelemetry tracing.
 *
 * [Documentation](https://docs.temporal.io/typescript/logging#opentelemetry-tracing)
 *
 * @module
 */

export * from './workflow';
export * from './worker';
export { OpenTelemetryWorkflowClientCallsInterceptor } from './client';
