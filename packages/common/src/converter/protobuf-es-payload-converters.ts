import {
  createRegistry,
  fromBinary,
  fromJson,
  isMessage,
  toBinary,
  toJson,
  type DescMessage,
  type Registry,
} from '@bufbuild/protobuf';
import { decode, encode } from '../encoding';
import { PayloadConverterError, ValueError } from '../errors';
import type { Payload } from '../interfaces';
import { isRecord } from '../type-helpers';
import type { PayloadConverterWithEncoding } from './payload-converter';
import {
  BinaryPayloadConverter,
  CompositePayloadConverter,
  JsonPayloadConverter,
  UndefinedPayloadConverter,
} from './payload-converter';
import { encodingTypes, METADATA_ENCODING_KEY, METADATA_MESSAGE_TYPE_KEY } from './types';

/**
 * Constructor argument for the protobuf-es payload converters. Accepts either a pre-built
 * `@bufbuild/protobuf` `Registry`, or an array of schemas (each generated `<Message>Schema`
 * export from `protoc-gen-es`) that will be passed to `createRegistry`.
 */
export type ProtobufEsRegistryInput = Registry | readonly DescMessage[];

abstract class ProtobufEsPayloadConverter implements PayloadConverterWithEncoding {
  protected readonly registry: Registry | undefined;
  private readonly encodedEncodingType: Uint8Array;
  public abstract encodingType: string;

  public abstract toPayload<T>(value: T): Payload | undefined;
  public abstract fromPayload<T>(payload: Payload): T;

  constructor(encodingType: string, registryOrSchemas?: ProtobufEsRegistryInput) {
    this.encodedEncodingType = encode(encodingType);

    if (registryOrSchemas === undefined) return;

    if (Array.isArray(registryOrSchemas)) {
      this.registry = createRegistry(...registryOrSchemas);
    } else if (isRegistry(registryOrSchemas)) {
      this.registry = registryOrSchemas;
    } else {
      throw new TypeError('`registry` must be a @bufbuild/protobuf Registry or an array of generated message schemas');
    }
  }

  protected validatePayload(content: Payload): { schema: DescMessage; data: Uint8Array } {
    if (content.data === undefined || content.data === null) {
      throw new ValueError('Got payload with no data');
    }
    if (!content.metadata || !(METADATA_MESSAGE_TYPE_KEY in content.metadata)) {
      throw new ValueError(`Got protobuf payload without metadata.${METADATA_MESSAGE_TYPE_KEY}`);
    }
    const schema = this.getSchemaOrThrow(decode(content.metadata[METADATA_MESSAGE_TYPE_KEY]));
    return { schema, data: content.data };
  }

  protected getSchemaOrThrow(messageTypeName: string): DescMessage {
    if (!this.registry) {
      throw new PayloadConverterError('Unable to process protobuf message without `registry` being provided');
    }
    const schema = this.registry.getMessage(messageTypeName);
    if (!schema) {
      throw new PayloadConverterError(
        `Got a \`${messageTypeName}\` protobuf message but cannot find corresponding message schema in \`registry\``
      );
    }
    return schema;
  }

  protected constructPayload({ messageTypeName, message }: { messageTypeName: string; message: Uint8Array }): Payload {
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: this.encodedEncodingType,
        [METADATA_MESSAGE_TYPE_KEY]: encode(messageTypeName),
      },
      data: message,
    };
  }
}

/**
 * Converts between `@bufbuild/protobuf` v2 message instances and serialized Protobuf Payload.
 *
 * Wire-compatible with {@link ProtobufBinaryPayloadConverter} (the protobufjs-based converter):
 * uses the same `binary/protobuf` encoding marker and fully-qualified message-type metadata.
 */
export class ProtobufEsBinaryPayloadConverter extends ProtobufEsPayloadConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_PROTOBUF;

  constructor(registryOrSchemas?: ProtobufEsRegistryInput) {
    super(encodingTypes.METADATA_ENCODING_PROTOBUF, registryOrSchemas);
  }

  public toPayload(value: unknown): Payload | undefined {
    if (!isMessage(value)) return undefined;
    const schema = this.getSchemaOrThrow(value.$typeName);
    return this.constructPayload({
      messageTypeName: value.$typeName,
      message: toBinary(schema, value),
    });
  }

  public fromPayload<T>(content: Payload): T {
    const { schema, data } = this.validatePayload(content);
    // Re-wrap with Uint8Array from this realm so cross-realm `instanceof` checks
    // inside @bufbuild/protobuf keep working through the workflow sandbox.
    const localData = new Uint8Array(data.buffer, data.byteOffset, data.length);
    return fromBinary(schema, localData) as T;
  }
}

/**
 * Converts between `@bufbuild/protobuf` v2 message instances and serialized JSON Payload
 * (proto3 JSON mapping).
 *
 * Produces canonical proto3 JSON that {@link ProtobufJsonPayloadConverter} can also read
 * (and vice versa). Exact JSON byte equality across the two runtimes is not guaranteed
 * for every message — field ordering or trailing-zero formatting may differ — but the
 * structural content is identical.
 */
export class ProtobufEsJsonPayloadConverter extends ProtobufEsPayloadConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_PROTOBUF_JSON;

  constructor(registryOrSchemas?: ProtobufEsRegistryInput) {
    super(encodingTypes.METADATA_ENCODING_PROTOBUF_JSON, registryOrSchemas);
  }

  public toPayload(value: unknown): Payload | undefined {
    if (!isMessage(value)) return undefined;
    const schema = this.getSchemaOrThrow(value.$typeName);
    // Forward the registry so `google.protobuf.Any` and extension fields can
    // resolve their embedded types during proto3 JSON serialization.
    return this.constructPayload({
      messageTypeName: value.$typeName,
      message: encode(JSON.stringify(toJson(schema, value, { registry: this.registry }))),
    });
  }

  public fromPayload<T>(content: Payload): T {
    const { schema, data } = this.validatePayload(content);
    return fromJson(schema, JSON.parse(decode(data)), { registry: this.registry }) as T;
  }
}

function isRegistry(x: unknown): x is Registry {
  // `Registry` exposes a documented `kind: "registry"` brand.
  return isRecord(x) && (x as { kind?: unknown }).kind === 'registry';
}

export interface DefaultPayloadConverterWithProtobufsEsOptions {
  /**
   * The `Registry` (or schema array) handed to {@link ProtobufEsJsonPayloadConverter} and
   * {@link ProtobufEsBinaryPayloadConverter}. Build one with `createRegistry(MessageSchema, ...)`
   * from `@bufbuild/protobuf`, or pass the schemas directly.
   */
  registry: ProtobufEsRegistryInput;
}

/**
 * Composite payload converter pre-wired with the protobuf-es converters. Composition order
 * matches {@link DefaultPayloadConverterWithProtobufs} (Undefined → Binary → ProtobufJson →
 * ProtobufBinary → Json), so the on-the-wire selection is identical to the protobufjs default.
 *
 * Mirrors the order used by other Temporal SDKs:
 * https://github.com/temporalio/sdk-go/blob/5e5645f0c550dcf717c095ae32c76a7087d2e985/converter/default_data_converter.go#L28
 */
export class DefaultPayloadConverterWithProtobufsEs extends CompositePayloadConverter {
  constructor({ registry }: DefaultPayloadConverterWithProtobufsEsOptions) {
    super(
      new UndefinedPayloadConverter(),
      new BinaryPayloadConverter(),
      new ProtobufEsJsonPayloadConverter(registry),
      new ProtobufEsBinaryPayloadConverter(registry),
      new JsonPayloadConverter()
    );
  }
}
