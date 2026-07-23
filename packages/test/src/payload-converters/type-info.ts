import type { ConverterHint } from '@temporalio/common';
import {
  BinaryPayloadConverter,
  CompositePayloadConverter,
  JsonPayloadConverter,
  UndefinedPayloadConverter,
} from '@temporalio/common';

class HintJsonPayloadConverter extends JsonPayloadConverter {
  validateConverterHint(hint: ConverterHint): boolean {
    return hint.converter === 'json';
  }
}

export const payloadConverter = new CompositePayloadConverter(
  new UndefinedPayloadConverter(),
  new BinaryPayloadConverter(),
  new HintJsonPayloadConverter()
);
