import { defaultPayloadConverter } from '@temporalio/common';
import { WrappedPayloadConverter } from '@temporalio/common/lib/converter/wrapped-payload-converter';

export const wrappedDefaultPayloadConverter = new WrappedPayloadConverter(defaultPayloadConverter);
