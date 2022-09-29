import { PayloadConverter, defaultPayloadConverter } from '../converter/payload-converter';
import { DataConverter, defaultFailureConverter, LoadedDataConverter } from '../converter/data-converter';
import { FailureConverter } from '../converter/failure-converter';
import { errorCode, hasOwnProperty, isRecord } from '../type-helpers';
import { ValueError } from '../errors';

const isValidPayloadConverter = (converter: unknown): converter is PayloadConverter =>
  typeof converter === 'object' &&
  converter !== null &&
  ['toPayload', 'fromPayload'].every((method) => typeof (converter as Record<string, unknown>)[method] === 'function');

const isValidFailureConverter = (converter: unknown): converter is FailureConverter =>
  typeof converter === 'object' &&
  converter !== null &&
  ['errorToFailure', 'failureToError'].every(
    (method) => typeof (converter as Record<string, unknown>)[method] === 'function'
  );

function requireConverter<T>(path: string, type: string, validator: (converter: unknown) => converter is T): T {
  let module;
  try {
    module = require(path); // eslint-disable-line @typescript-eslint/no-var-requires
  } catch (error) {
    if (errorCode(error) === 'MODULE_NOT_FOUND') {
      throw new ValueError(`Could not find a file at the specified ${type}Path: '${path}'.`);
    }
    throw error;
  }

  if (isRecord(module) && hasOwnProperty(module, type)) {
    const converter = module[type];
    if (validator(converter)) {
      return converter;
    } else {
      throw new ValueError(
        `payloadConverter export at ${path} must be an object with toPayload and fromPayload methods`
      );
    }
  } else {
    throw new ValueError(`Module ${path} does not have a \`payloadConverter\` named export`);
  }
}

/**
 * If {@link DataConverter.payloadConverterPath} is specified, `require()` it and validate that the module has a `payloadConverter` named export.
 * If not, use {@link defaultPayloadConverter}.
 * If {@link DataConverter.payloadCodecs} is unspecified, use an empty array.
 */
export function loadDataConverter(dataConverter?: DataConverter): LoadedDataConverter {
  let payloadConverter: PayloadConverter = defaultPayloadConverter;
  if (dataConverter?.payloadConverterPath) {
    payloadConverter = requireConverter(
      dataConverter.payloadConverterPath,
      'payloadConverter',
      isValidPayloadConverter
    );
  }
  let failureConverter: FailureConverter = defaultFailureConverter;
  if (dataConverter?.failureConverterPath) {
    failureConverter = requireConverter(
      dataConverter.failureConverterPath,
      'failureConverter',
      isValidFailureConverter
    );
  }
  return {
    payloadConverter,
    failureConverter,
    payloadCodecs: dataConverter?.payloadCodecs ?? [],
  };
}

/**
 * Returns true if the converter is already "loaded"
 */
export function isLoadedDataConverter(
  dataConverter?: DataConverter | LoadedDataConverter
): dataConverter is LoadedDataConverter {
  return isRecord(dataConverter) && hasOwnProperty(dataConverter, 'payloadConverter');
}
