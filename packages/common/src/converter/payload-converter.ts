import { ValueError, DataConverterError } from '../errors';
import {
  u8,
  str,
  Payload,
  encodingTypes,
  encodingKeys,
  METADATA_ENCODING_KEY,
  METADATA_MESSAGE_TYPE_KEY,
  ProtobufSerializable,
} from './types';

/**
 * Used by the framework to serialize/deserialize method parameters that need to be sent over the
 * wire.
 *
 * @author fateev
 */
export interface PayloadConverter {
  encodingType: string;

  /**
   * TODO: Fix comment in https://github.com/temporalio/sdk-java/blob/85593dbfa99bddcdf54c7196d2b73eeb23e94e9e/temporal-sdk/src/main/java/io/temporal/common/converter/DataConverter.java#L46
   * Implements conversion of value to payload
   *
   * @param value JS value to convert.
   * @return converted value or `undefined` if unable to convert.
   * @throws DataConverterException if conversion of the value passed as parameter failed for any
   *     reason.
   */
  toData(value: unknown): Promise<Payload | undefined>;

  /**
   * Implements conversion of payload to value.
   *
   * @param content Serialized value to convert to a JS value.
   * @return converted JS value
   * @throws DataConverterException if conversion of the data passed as parameter failed for any
   *     reason.
   */
  fromData<T>(content: Payload): Promise<T>;

  /**
   * Synchronous version of {@link toData}, used in the Workflow runtime because
   * the async version limits the functionality of the runtime.
   *
   * Implements conversion of value to payload
   *
   * @param value JS value to convert.
   * @return converted value or `undefined` if unable to convert.
   * @throws DataConverterException if conversion of the value passed as parameter failed for any
   *     reason.
   */
  toDataSync(value: unknown): Payload | undefined;

  /**
   * Synchronous version of {@link fromData}, used in the Workflow runtime because
   * the async version limits the functionality of the runtime.
   *
   * Implements conversion of payload to value.
   *
   * @param content Serialized value to convert to a JS value.
   * @return converted JS value
   * @throws DataConverterException if conversion of the data passed as parameter failed for any
   *     reason.
   */
  fromDataSync<T>(content: Payload): T;
}

export abstract class AsyncFacadePayloadConverter implements PayloadConverter {
  abstract encodingType: string;
  abstract toDataSync(value: unknown): Payload | undefined;
  abstract fromDataSync<T>(content: Payload): T;

  public async toData(value: unknown): Promise<Payload | undefined> {
    return this.toDataSync(value);
  }

  public async fromData<T>(content: Payload): Promise<T> {
    return this.fromDataSync(content);
  }
}

/**
 * Converts between JS undefined and NULL Payload
 */
export class UndefinedPayloadConverter extends AsyncFacadePayloadConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_NULL;

  public toDataSync(value: unknown): Payload | undefined {
    if (value !== undefined) return undefined; // Can't encode
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_NULL,
      },
    };
  }

  public fromDataSync<T>(_content: Payload): T {
    return undefined as any; // Just return undefined
  }
}

/**
 * Converts between non-undefined values and serialized JSON Payload
 */
export class JsonPayloadConverter extends AsyncFacadePayloadConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_JSON;

  public toDataSync(value: unknown): Payload | undefined {
    if (value === undefined) return undefined; // Should be encoded with the UndefinedPayloadConverter
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_JSON,
      },
      data: u8(JSON.stringify(value)),
    };
  }

  public fromDataSync<T>(content: Payload): T {
    if (content.data === undefined || content.data === null) {
      throw new ValueError('Got payload with no data');
    }
    return JSON.parse(str(content.data));
  }
}

/**
 * Converts between binary data types and RAW Payload
 */
export class BinaryPayloadConverter extends AsyncFacadePayloadConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_RAW;

  public toDataSync(value: unknown): Payload | undefined {
    // TODO: support any DataView or ArrayBuffer?
    if (!(value instanceof Uint8Array)) {
      return undefined;
    }
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_RAW,
      },
      data: value,
    };
  }

  public fromDataSync<T>(content: Payload): T {
    // TODO: support any DataView or ArrayBuffer?
    return content.data as any;
  }
}

abstract class ProtobufPayloadConverter extends AsyncFacadePayloadConverter {
  protected messageClasses: Record<string, ProtobufSerializable> = {};

  constructor(protobufClasses?: Record<string, unknown>) {
    super();

    if (protobufClasses) {
      if (typeof protobufClasses !== 'object') {
        throw new TypeError('protobufClasses must be an object');
      }

      let count = 0;
      for (const [name, klass] of Object.entries(protobufClasses)) {
        if (this.isProtobufMessageClass(klass)) {
          this.messageClasses[name] = klass;
          count++;
        }
      }

      if (count === 0) {
        throw new TypeError(
          'protobufClasses must be an object with values that are classes that have `encode`, `decode`, and `create` static methods'
        );
      }
    }
  }

  protected isProtobufMessageClass(messageClass: unknown): messageClass is ProtobufSerializable {
    return (
      typeof messageClass === 'function' &&
      typeof (messageClass as unknown as ProtobufSerializable).create === 'function' &&
      typeof (messageClass as unknown as ProtobufSerializable).encode === 'function' &&
      typeof (messageClass as unknown as ProtobufSerializable).decode === 'function'
    );
  }

  protected isProtobufMessageInstance(value: unknown): value is ProtobufSerializable {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const messageClass = this.messageClasses[value.constructor.name];
    return typeof messageClass === 'function' && value instanceof messageClass;
  }

  protected validatePayload(content: Payload): { messageClass: ProtobufSerializable; data: Uint8Array } {
    if (content.data === undefined || content.data === null) {
      throw new ValueError('Got payload with no data');
    }
    if (!content.metadata || !(METADATA_MESSAGE_TYPE_KEY in content.metadata)) {
      throw new ValueError(`Got protobuf payload without metadata.${METADATA_MESSAGE_TYPE_KEY}`);
    }
    if (Object.keys(this.messageClasses).length === 0) {
      throw new DataConverterError('Unable to deserialize protobuf message without `protobufClasses` being provided');
    }

    const messageClassName = str(content.metadata[METADATA_MESSAGE_TYPE_KEY]);
    const messageClass = this.messageClasses[messageClassName];
    if (!messageClass) {
      throw new DataConverterError(
        `Got a \`${messageClassName}\` protobuf message but cannot find corresponding message class in protobufClasses`
      );
    }

    return { messageClass, data: content.data };
  }

  protected constructPayload(messageType: string, message: Uint8Array): Payload {
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: u8(this.encodingType),
        [METADATA_MESSAGE_TYPE_KEY]: u8(messageType),
      },
      data: message,
    };
  }
}

/**
 * Converts between protobufjs Message instances and serialized Protobuf Payload
 */
export class ProtobufBinaryPayloadConverter extends ProtobufPayloadConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_PROTOBUF;

  constructor(protobufClasses?: Record<string, unknown>) {
    super(protobufClasses);
  }

  public toDataSync(value: unknown): Payload | undefined {
    if (!this.isProtobufMessageInstance(value)) {
      return undefined;
    }

    const messageClass = this.messageClasses[value.constructor.name];
    return this.constructPayload(value.constructor.name, messageClass.encode(value).finish());
  }

  public fromDataSync<T>(content: Payload): T {
    const { messageClass, data } = this.validatePayload(content);
    return messageClass.decode<T>(data);
  }
}

/**
 * Converts between protobufjs Message instances and serialized JSON Payload
 */
export class ProtobufJSONPayloadConverter extends ProtobufPayloadConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_PROTOBUF_JSON;

  constructor(protobufClasses?: Record<string, unknown>) {
    super(protobufClasses);
  }

  public toDataSync(value: unknown): Payload | undefined {
    if (!this.isProtobufMessageInstance(value)) {
      return undefined;
    }

    return this.constructPayload(value.constructor.name, u8(JSON.stringify(value)));
  }

  public fromDataSync<T>(content: Payload): T {
    const { messageClass, data } = this.validatePayload(content);
    return messageClass.create<T>(JSON.parse(str(data)));
  }
}
