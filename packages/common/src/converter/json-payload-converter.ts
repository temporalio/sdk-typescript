import { decode, encode } from '../encoding';
import { ValueError } from '../errors';
import { Payload } from '../interfaces';
import { PayloadConverterWithEncoding } from './payload-converter-with-encoding';
import { encodingKeys, encodingTypes, METADATA_ENCODING_KEY } from './types';

/**
 * Converts between non-undefined values and serialized JSON Payload
 */
export class JsonPayloadConverter implements PayloadConverterWithEncoding {
  public encodingType = encodingTypes.METADATA_ENCODING_JSON;

  public toPayload(value: unknown): Payload | undefined {
    if (value === undefined) {
      return undefined;
    }

    let json;
    try {
      json = JSON.stringify(value);
    } catch (e) {
      return undefined;
    }

    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_JSON,
      },
      data: encode(json),
    };
  }

  public fromPayload<T>(content: Payload): T {
    if (content.data === undefined || content.data === null) {
      throw new ValueError('Got payload with no data');
    }
    return JSON.parse(decode(content.data));
  }
}
