import { ValueError, DataConverterError } from '../errors';
import {
  u8,
  str,
  Payload,
  encodingTypes,
  encodingKeys,
  METADATA_ENCODING_KEY,
  METADATA_MESSAGE_TYPE_KEY,
  ProtobufCodec,
  ProtobufjsInstance,
  ProtobufjsNode,
} from './types';
import { isRecord, hasOwnProperty } from '../type-helpers';
import * as protoJsonSerializer from 'proto3-json-serializer';

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
  protected readonly typesByName: Record<string, ProtobufCodec> = {};

  constructor(root?: Record<string, unknown>) {
    super();

    if (root) {
      if (typeof root !== 'object') {
        throw new TypeError('root must be an object');
      }

      this.extractTypes(root);

      if (Object.keys(this.typesByName).length === 0) {
        throw new TypeError(
          'root must be an object with values or nested values that are Type classes with `encode`, `decode`, and `create` static methods'
        );
      }
    }
  }

  extractTypes(node: Record<string, unknown>, seen = new Set()) {
    for (const key in node) {
      const value = node[key];
      if (seen.has(value)) {
        continue;
      }

      seen.add(value);
      if (isProtobufMessageType(value)) {
        this.typesByName[getNamespacedTypeName(value)] = value;
      } else if (isProtobufNamespace(value)) {
        this.extractTypes(value, seen);
      }
    }
  }

  protected validatePayload(content: Payload): { messageType: ProtobufCodec; data: Uint8Array } {
    if (content.data === undefined || content.data === null) {
      throw new ValueError('Got payload with no data');
    }
    if (!content.metadata || !(METADATA_MESSAGE_TYPE_KEY in content.metadata)) {
      throw new ValueError(`Got protobuf payload without metadata.${METADATA_MESSAGE_TYPE_KEY}`);
    }
    if (Object.keys(this.typesByName).length === 0) {
      throw new DataConverterError('Unable to deserialize protobuf message without `root` being provided');
    }

    const messageTypeName = str(content.metadata[METADATA_MESSAGE_TYPE_KEY]);
    const messageType = this.typesByName[messageTypeName];
    if (!messageType) {
      throw new DataConverterError(
        `Got a \`${messageTypeName}\` protobuf message but cannot find corresponding message class in \`root\``
      );
    }

    return { messageType, data: content.data };
  }

  protected constructPayload({ messageTypeName, message }: { messageTypeName: string; message: Uint8Array }): Payload {
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: u8(this.encodingType),
        [METADATA_MESSAGE_TYPE_KEY]: u8(messageTypeName),
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

  constructor(root?: Record<string, unknown>) {
    super(root);
  }

  public toDataSync(value: unknown): Payload | undefined {
    if (!isProtobufMessageInstance(value)) {
      return undefined;
    }

    return this.constructPayload({
      messageTypeName: getNamespacedTypeName(value.$type),
      message: value.$type.encode(value).finish(),
    });
  }

  public fromDataSync<T>(content: Payload): T {
    const { messageType, data } = this.validatePayload(content);
    return messageType.decode<T>(data);
  }
}

/**
 * Converts between protobufjs Message instances and serialized JSON Payload
 */
export class ProtobufJsonPayloadConverter extends ProtobufPayloadConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_PROTOBUF_JSON;

  constructor(root?: Record<string, unknown>) {
    super(root);
  }

  public toDataSync(value: unknown): Payload | undefined {
    if (!isProtobufMessageInstance(value)) {
      return undefined;
    }

    const jsonValue = protoJsonSerializer.toProto3JSON(value as any);

    return this.constructPayload({
      messageTypeName: getNamespacedTypeName(value.$type),
      message: u8(JSON.stringify(jsonValue)),
    });
  }

  public fromDataSync<T>(content: Payload): T {
    const { messageType, data } = this.validatePayload(content);
    return protoJsonSerializer.fromProto3JSON(messageType as any, JSON.parse(str(data))) as any as T;
  }
}

function isProtobufMessageType(type: unknown): type is ProtobufCodec {
  return (
    isRecord(type) &&
    type.constructor.name === 'Type' &&
    'parent' in type &&
    typeof (type as unknown as ProtobufCodec).name === 'string' &&
    typeof (type as unknown as ProtobufCodec).create === 'function' &&
    typeof (type as unknown as ProtobufCodec).encode === 'function' &&
    typeof (type as unknown as ProtobufCodec).decode === 'function'
  );
}

function isProtobufNamespace(namespace: unknown): namespace is Record<string, unknown> {
  return isRecord(namespace) && namespace.constructor.name === 'Namespace';
}

function isProtobufMessageInstance(value: unknown): value is ProtobufjsInstance {
  return isRecord(value) && hasOwnProperty(value, '$type') && isProtobufMessageType(value.$type);
}

function getNamespacedTypeName(node: ProtobufjsNode): string {
  if (node.parent && node.parent.constructor.name !== 'Root') {
    return getNamespacedTypeName(node.parent) + '.' + node.name;
  } else {
    return node.name;
  }
}
