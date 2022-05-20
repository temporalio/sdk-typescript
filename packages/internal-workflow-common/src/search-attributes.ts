import type { SearchAttributeValue } from './interfaces';

export type CompiledSearchAttributeValue = Exclude<SearchAttributeValue, Date | Date[]>;

export function convertSearchAttributeDatesToStrings(
  searchAttributes?: Record<string, SearchAttributeValue>
): Record<string, CompiledSearchAttributeValue> | undefined {
  if (searchAttributes === null || searchAttributes === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(searchAttributes).map(([key, value]): [string, SearchAttributeValue] => {
      return [key, convertDateValueToString(value)];
    })
  ) as Record<string, CompiledSearchAttributeValue>;
}

function convertDateValueToString(value: SearchAttributeValue): CompiledSearchAttributeValue {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Array && value.length > 0 && value[0] instanceof Date) {
    return (value as Date[]).map((date) => date.toISOString());
  }

  return value as CompiledSearchAttributeValue;
}

export function convertSearchAttributeStringsToDates(
  searchAttributes?: Record<string, CompiledSearchAttributeValue> | null
): Record<string, SearchAttributeValue> | undefined {
  if (searchAttributes === null || searchAttributes === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(searchAttributes).map(([key, value]): [string, SearchAttributeValue] => {
      return [key, convertStringValueToDate(value)];
    })
  ) as Record<string, SearchAttributeValue>;
}

function convertStringValueToDate(value: CompiledSearchAttributeValue): SearchAttributeValue {
  // This may have false positives: if you have a keyword or text search attribute that's a valid ISO string, we will
  // convert it to a Date.
  if (isValidISOString(value)) {
    return new Date(value);
  }

  if (value instanceof Array && value.length > 0 && isValidISOString(value[0])) {
    return value.map((isoString) => new Date(isoString as string));
  }

  return value;
}

// https://stackoverflow.com/a/3143231/627729
const ISO_REGEX =
  /(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))/;

function isValidISOString(value: unknown): value is string {
  return typeof value === 'string' && ISO_REGEX.test(value);
}
