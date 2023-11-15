import * as protoJsonSerializer from 'proto3-json-serializer';
import type { Message, Namespace, Root, Type } from 'protobufjs';
import { decode, encode } from '../encoding';
import { PayloadConverterError, ValueError } from '../errors';
import { Payload } from '../interfaces';
import { errorMessage, hasOwnProperties, hasOwnProperty, isRecord } from '../type-helpers';
import {
  BinaryPayloadConverter,
  CompositePayloadConverter,
  JsonPayloadConverter,
  PayloadConverterWithEncoding,
  UndefinedPayloadConverter,
} from './payload-converter';

import { encodingTypes, METADATA_ENCODING_KEY, METADATA_MESSAGE_TYPE_KEY } from './types';

const GLOBAL_BUFFER = globalThis.constructor.constructor('return globalThis.Buffer')();

abstract class ProtobufPayloadConverter implements PayloadConverterWithEncoding {
  protected readonly root: Root | undefined;
  public abstract encodingType: string;

  public abstract toPayload<T>(value: T): Payload | undefined;
  public abstract fromPayload<T>(payload: Payload): T;

  // Don't use type Root here because root.d.ts doesn't export Root, so users would have to type assert
  constructor(root?: unknown) {
    if (root) {
      if (!isRoot(root)) {
        throw new TypeError('root must be an instance of a protobufjs Root');
      }

      this.root = root;
    }
  }

  protected validatePayload(content: Payload): { messageType: Type; data: Uint8Array } {
    if (content.data === undefined || content.data === null) {
      throw new ValueError('Got payload with no data');
    }
    if (!content.metadata || !(METADATA_MESSAGE_TYPE_KEY in content.metadata)) {
      throw new ValueError(`Got protobuf payload without metadata.${METADATA_MESSAGE_TYPE_KEY}`);
    }
    if (!this.root) {
      throw new PayloadConverterError('Unable to deserialize protobuf message without `root` being provided');
    }

    const messageTypeName = decode(content.metadata[METADATA_MESSAGE_TYPE_KEY]);
    let messageType;
    try {
      messageType = this.root.lookupType(messageTypeName);
    } catch (e) {
      if (errorMessage(e)?.includes('no such type')) {
        throw new PayloadConverterError(
          `Got a \`${messageTypeName}\` protobuf message but cannot find corresponding message class in \`root\``
        );
      }

      throw e;
    }

    return { messageType, data: content.data };
  }

  protected constructPayload({ messageTypeName, message }: { messageTypeName: string; message: Uint8Array }): Payload {
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encode(this.encodingType),
        [METADATA_MESSAGE_TYPE_KEY]: encode(messageTypeName),
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

  /**
   * @param root The value returned from {@link patchProtobufRoot}
   */
  constructor(root?: unknown) {
    super(root);
  }

  public toPayload(value: unknown): Payload | undefined {
    if (!isProtobufMessage(value)) {
      return undefined;
    }

    return this.constructPayload({
      messageTypeName: getNamespacedTypeName(value.$type),
      message: value.$type.encode(value).finish(),
    });
  }

  public fromPayload<T>(content: Payload): T {
    const { messageType, data } = this.validatePayload(content);
    // Wrap with Uint8Array from this context to ensure `instanceof` works
    const localData = data ? new Uint8Array(data.buffer, data.byteOffset, data.length) : data;
    return messageType.decode(localData) as unknown as T;
  }
}

/**
 * Converts between protobufjs Message instances and serialized JSON Payload
 */
export class ProtobufJsonPayloadConverter extends ProtobufPayloadConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_PROTOBUF_JSON;

  /**
   * @param root The value returned from {@link patchProtobufRoot}
   */
  constructor(root?: unknown) {
    super(root);
  }

  public toPayload(value: unknown): Payload | undefined {
    if (!isProtobufMessage(value)) {
      return undefined;
    }

    const hasBufferChanged = setBufferInGlobal();
    try {
      const jsonValue = protoJsonSerializer.toProto3JSON(value);

      return this.constructPayload({
        messageTypeName: getNamespacedTypeName(value.$type),
        message: encode(JSON.stringify(jsonValue)),
      });
    } finally {
      resetBufferInGlobal(hasBufferChanged);
    }
  }

  public fromPayload<T>(content: Payload): T {
    const hasBufferChanged = setBufferInGlobal();
    try {
      const { messageType, data } = this.validatePayload(content);
      const res = protoJsonSerializer.fromProto3JSON(messageType, JSON.parse(decode(data))) as unknown as T;
      if (Buffer.isBuffer(res)) {
        return new Uint8Array(res) as any;
      }
      replaceBuffers(res);
      return res;
    } finally {
      resetBufferInGlobal(hasBufferChanged);
    }
  }
}

function replaceBuffers<X>(obj: X) {
  const replaceBuffersImpl = <Y>(value: any, key: string | number, target: Y) => {
    if (Buffer.isBuffer(value)) {
      // Need to copy. `Buffer` manages a pool slab, internally reused when Buffer objects are GC.
      type T = keyof typeof target;
      target[key as T] = new Uint8Array(value) as any;
    } else {
      replaceBuffers(value);
    }
  };

  if (obj != null && typeof obj === 'object') {
    // Performance optimization for large arrays
    if (Array.isArray(obj)) {
      obj.forEach(replaceBuffersImpl);
    } else {
      for (const [key, value] of Object.entries(obj)) {
        replaceBuffersImpl(value, key, obj);
      }
    }
  }
}

function setBufferInGlobal(): boolean {
  if (typeof globalThis.Buffer === 'undefined') {
    globalThis.Buffer = GLOBAL_BUFFER;
    return true;
  }
  return false;
}

function resetBufferInGlobal(hasChanged: boolean): void {
  if (hasChanged) {
    delete (globalThis as any).Buffer;
  }
}

function isProtobufType(type: unknown): type is Type {
  return (
    isRecord(type) &&
    // constructor.name may get mangled by minifiers; thanksfuly protobufjs also sets a className property
    (type.constructor as any).className === 'Type' &&
    hasOwnProperties(type, ['parent', 'name', 'create', 'encode', 'decode']) &&
    typeof type.name === 'string' &&
    typeof type.create === 'function' &&
    typeof type.encode === 'function' &&
    typeof type.decode === 'function'
  );
}

function isProtobufMessage(value: unknown): value is Message {
  return isRecord(value) && hasOwnProperty(value, '$type') && isProtobufType(value.$type);
}

function getNamespacedTypeName(node: Type | Namespace): string {
  if (node.parent && !isRoot(node.parent)) {
    return getNamespacedTypeName(node.parent) + '.' + node.name;
  } else {
    return node.name;
  }
}

function isRoot(root: unknown): root is Root {
  // constructor.name may get mangled by minifiers; thanksfuly protobufjs also sets a className property
  return isRecord(root) && (root.constructor as any).className === 'Root';
}

export interface DefaultPayloadConverterWithProtobufsOptions {
  /**
   * The `root` provided to {@link ProtobufJsonPayloadConverter} and {@link ProtobufBinaryPayloadConverter}
   */
  protobufRoot: Record<string, unknown>;
}

export class DefaultPayloadConverterWithProtobufs extends CompositePayloadConverter {
  // Match the order used in other SDKs.
  //
  // Go SDK:
  // https://github.com/temporalio/sdk-go/blob/5e5645f0c550dcf717c095ae32c76a7087d2e985/converter/default_data_converter.go#L28
  constructor({ protobufRoot }: DefaultPayloadConverterWithProtobufsOptions) {
    super(
      new UndefinedPayloadConverter(),
      new BinaryPayloadConverter(),
      new ProtobufJsonPayloadConverter(protobufRoot),
      new ProtobufBinaryPayloadConverter(protobufRoot),
      new JsonPayloadConverter()
    );
  }
}
