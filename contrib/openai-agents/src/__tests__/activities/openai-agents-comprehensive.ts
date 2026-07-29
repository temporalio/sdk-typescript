/**
 * Activities used by the OpenAI Agents comprehensive E2E test suite.
 *
 * `getWeatherWithInnerSpan` verifies activity-local user spans parent under
 * the activity execution span. `failingTool` drives activity-tool failure
 * classification.
 */
import { withCustomSpan } from '@openai/agents-core';

export interface WeatherInput {
  location: string;
}

export interface WeatherOutput {
  location: string;
  conditions: string;
  tempC: number;
}

export async function getWeather(input: WeatherInput): Promise<WeatherOutput> {
  return {
    location: input.location,
    conditions: 'sunny',
    tempC: 21,
  };
}

/**
 * Identical to `getWeather` except wraps its body in a user-created OTel
 * span. The activity's `temporal:runActivity:getWeatherWithInnerSpan` should
 * appear in the tree as the *parent* of `user_inside_activity`.
 */
export async function getWeatherWithInnerSpan(input: WeatherInput): Promise<WeatherOutput> {
  return withCustomSpan(
    async () => ({
      location: input.location,
      conditions: 'partly cloudy',
      tempC: 18,
    }),
    { data: { name: 'user_inside_activity', data: {} } }
  );
}

export interface SumInput {
  a: number;
  b: number;
}

export async function calculateSum(input: SumInput): Promise<number> {
  return input.a + input.b;
}

export async function failingTool(_input: { reason?: string }): Promise<never> {
  throw new Error('failingTool always fails');
}

let phase1Resolver: (() => void) | undefined;

/**
 * Returns a promise that resolves when `notifyPhase1Reached` next executes.
 * Call this from the test driver before starting the worker that will run
 * the comprehensive workflow.
 */
export function resetPhase1Sync(): Promise<void> {
  return new Promise<void>((resolve) => {
    phase1Resolver = resolve;
  });
}

/**
 * Scheduled by the comprehensive workflow immediately before its
 * `condition()` block. Resolves the host-side promise from
 * `resetPhase1Sync()` so the test driver knows it is safe to shut down
 * the pre-crash worker.
 */
export async function notifyPhase1Reached(): Promise<void> {
  phase1Resolver?.();
  phase1Resolver = undefined;
}
