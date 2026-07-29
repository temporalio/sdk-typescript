import test from 'ava';
import * as nexus from 'nexus-rpc';
import type { FunctionTool, RunContext } from '@openai/agents-core';
import { nexusOperationAsTool } from '../workflow/nexus-tools';
import { ToolSerializationError } from '../workflow/tools';

interface WeatherInput {
  location: string;
}

interface Weather {
  city: string;
  description: string;
}

const WeatherService = nexus.service('WeatherService', {
  getWeather: nexus.operation<WeatherInput, Weather>(),
});

const weatherSchema = {
  type: 'object' as const,
  properties: { location: { type: 'string' } },
  required: ['location'],
  additionalProperties: false,
};

test('nexusOperationAsTool: returns FunctionTool with expected static fields', (t) => {
  const tool = nexusOperationAsTool(
    WeatherService.operations.getWeather,
    {
      name: 'getWeather',
      description: 'Get the weather for a city',
      parameters: weatherSchema,
    },
    { service: WeatherService, endpoint: 'weather-endpoint' }
  ) as FunctionTool;

  t.is(tool.type, 'function');
  t.is(tool.name, 'getWeather');
  t.is(tool.description, 'Get the weather for a city');
  t.deepEqual(tool.parameters, weatherSchema);
});

test('nexusOperationAsTool: strict defaults to true', (t) => {
  const tool = nexusOperationAsTool(
    WeatherService.operations.getWeather,
    { name: 'getWeather', description: '', parameters: weatherSchema },
    { service: WeatherService, endpoint: 'weather-endpoint' }
  ) as FunctionTool;
  t.is(tool.strict, true);
});

test('nexusOperationAsTool: strict can be overridden to false', (t) => {
  const tool = nexusOperationAsTool(
    WeatherService.operations.getWeather,
    { name: 'getWeather', description: '', parameters: weatherSchema },
    { service: WeatherService, endpoint: 'weather-endpoint', strict: false }
  ) as FunctionTool;
  t.is(tool.strict, false);
});

test('nexusOperationAsTool: needsApproval is false, isEnabled is true', async (t) => {
  const tool = nexusOperationAsTool(
    WeatherService.operations.getWeather,
    { name: 'getWeather', description: '', parameters: weatherSchema },
    { service: WeatherService, endpoint: 'weather-endpoint' }
  ) as FunctionTool;

  const fakeCtx = {} as RunContext<any>;
  const fakeAgent = {} as any;
  const fakeCall = {} as any;
  t.is(await tool.needsApproval(fakeCtx, fakeCall, ''), false);
  t.is(await tool.isEnabled(fakeCtx, fakeAgent), true);
});

test('nexusOperationAsTool: invoke with malformed JSON throws ToolSerializationError', async (t) => {
  const tool = nexusOperationAsTool(
    WeatherService.operations.getWeather,
    { name: 'getWeather', description: '', parameters: weatherSchema },
    { service: WeatherService, endpoint: 'weather-endpoint' }
  ) as FunctionTool;

  const err = await t.throwsAsync(() => tool.invoke({} as RunContext<any>, 'not-json'));
  t.true(err instanceof ToolSerializationError);
  t.regex((err as Error).message, /getWeather/);
});

test('nexusOperationAsTool: invoke outside workflow context fails after JSON parse succeeds', async (t) => {
  const tool = nexusOperationAsTool(
    WeatherService.operations.getWeather,
    { name: 'getWeather', description: '', parameters: weatherSchema },
    { service: WeatherService, endpoint: 'weather-endpoint' }
  ) as FunctionTool;

  const err = await t.throwsAsync(() => tool.invoke({} as RunContext<any>, '{"location":"Seattle"}'));
  t.false(err instanceof ToolSerializationError, 'should fail after JSON parse, not during it');
});
