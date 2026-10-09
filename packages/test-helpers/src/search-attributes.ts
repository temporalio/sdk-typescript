import { defineSearchAttributeKey, SearchAttributeType } from '@temporalio/common/lib/search-attributes';

// Kept free of heavier SDK imports so that CI scripts (e.g. Cloud namespace provisioning) can load it directly.

/**
 * Custom search attributes that integration tests expect to exist in the target namespace.
 */
export const defaultSAKeys = {
  CustomIntField: defineSearchAttributeKey('CustomIntField', SearchAttributeType.INT),
  CustomBoolField: defineSearchAttributeKey('CustomBoolField', SearchAttributeType.BOOL),
  CustomKeywordField: defineSearchAttributeKey('CustomKeywordField', SearchAttributeType.KEYWORD),
  CustomTextField: defineSearchAttributeKey('CustomTextField', SearchAttributeType.TEXT),
  CustomDatetimeField: defineSearchAttributeKey('CustomDatetimeField', SearchAttributeType.DATETIME),
  CustomDoubleField: defineSearchAttributeKey('CustomDoubleField', SearchAttributeType.DOUBLE),
};
