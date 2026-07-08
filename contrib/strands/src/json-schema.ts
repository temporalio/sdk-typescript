import { z } from 'zod';
import type { JSONSchema } from '@strands-agents/sdk';

/**
 * Normalize a tool input schema to a JSON Schema.
 *
 * A literal JSON Schema is returned unchanged; a Zod schema is converted via
 * zod 4's native {@link z.toJSONSchema}. The conversion is pure and
 * deterministic, so this is safe to call from workflow code.
 */
export function toJsonSchema(schema: JSONSchema | z.ZodType | undefined): JSONSchema | undefined {
  if (schema === undefined) return undefined;
  return schema instanceof z.ZodType ? (z.toJSONSchema(schema) as JSONSchema) : schema;
}
