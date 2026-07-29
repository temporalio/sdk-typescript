import test from 'ava';
import { z } from 'zod';
import type { JSONSchema } from '@strands-agents/sdk';
import { toJsonSchema } from '../json-schema';

test('toJsonSchema converts a Zod schema to JSON Schema', (t) => {
  const result = toJsonSchema(z.object({ location: z.string() }));
  t.like(result, {
    type: 'object',
    properties: { location: { type: 'string' } },
    required: ['location'],
  });
});

test('toJsonSchema passes a literal JSON Schema through unchanged', (t) => {
  const schema: JSONSchema = { type: 'object', properties: { path: { type: 'string' } } };
  t.is(toJsonSchema(schema), schema);
});

test('toJsonSchema returns undefined for undefined', (t) => {
  t.is(toJsonSchema(undefined), undefined);
});
