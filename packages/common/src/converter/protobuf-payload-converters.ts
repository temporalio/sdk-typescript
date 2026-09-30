import * as protojson from 'protobufjs/ext/protojson';
import * as protobufjslight from 'protobufjs/light';
import type { Message, Root, Type } from 'protobufjs';
import { decode, encode } from '../encoding';
import { PayloadConverterError, ValueError } from '../errors';
import type { Payload } from '../interfaces';
import { errorMessage, hasOwnProperties, hasOwnProperty, isRecord } from '../type-helpers';
import type { PayloadConverterWithEncoding } from './payload-converter';
import {
  BinaryPayloadConverter,
  CompositePayloadConverter,
  JsonPayloadConverter,
  UndefinedPayloadConverter,
} from './payload-converter';

import { encodingTypes, METADATA_ENCODING_KEY, METADATA_MESSAGE_TYPE_KEY } from './types';

/**
 * `protobufjs` optimizes allocations of `bytes` fields using `Buffer.allocUnsafe()`
 * instead of `Uint8Array` if the global `Buffer` class exists. `Buffer.allocUnsafe()`
 * carves small allocations out of a shared pool slab (of 64KB as of Node 24); the
 * slab is retained as long as any one payload is reachable, which may effectively leak
 * memory if payloads are not garbage collected within a reasonable timeframe, and pose
 * other subtle issues (i.e. `Buffer` and `Uint8array` differ under `JSON.stringify`
 * and deep equality). For those reasons, we walk through objects decoded by `protobufjs`
 * and replace `Buffer`s with `Uint8Array`s.
 *
 * That fix adds unnecessary overhead in the very common case of decoding payloads
 * inside the Workflow sandbox, as Node's `Buffer` class is known to be not available
 * (protobufjs explicitly rejects `Buffer` polyfills).
 *
 * @hidden
 */
const PROTOBUFJS_MAY_ALLOCATE_BUFFERS = protobufjslight.util.Buffer != null;

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

    const jsonValue = protojson.toJson(value.$type, value);

    return this.constructPayload({
      messageTypeName: getNamespacedTypeName(value.$type),
      message: encode(JSON.stringify(jsonValue)),
    });
  }

  public fromPayload<T>(content: Payload): T {
    const { messageType, data } = this.validatePayload(content);
    const res = protojson.fromJson(messageType, JSON.parse(decode(data)), {
      ignoreUnknownFields: true,
    }) as unknown as T;
    return replaceBuffers(res);
  }
}

/**
 * Recursively replace the `Buffer`s that `protobufjs` may have allocated for
 * `bytes` fields with plain `Uint8Array`s; see {@link PROTOBUFJS_MAY_ALLOCATE_BUFFERS}.
 */
function replaceBuffers<X>(value: X): X {
  if (PROTOBUFJS_MAY_ALLOCATE_BUFFERS) {
    if (isBuffer(value)) {
      return new Uint8Array(value) as unknown as X;
    }
    replaceBuffersInChildren(value);
  }
  return value;
}

function replaceBuffersInChildren(obj: unknown): void {
  // Bail on binary leaves; descending into one would visit it a byte at a time
  if (obj == null || typeof obj !== 'object' || ArrayBuffer.isView(obj)) return;

  // Indexing rather than Object.entries() is a performance optimization for large arrays
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const child = obj[i];
      if (isBuffer(child)) obj[i] = new Uint8Array(child);
      else replaceBuffersInChildren(child);
    }
  } else {
    const record = obj as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (isBuffer(child)) record[key] = new Uint8Array(child);
      else replaceBuffersInChildren(child);
    }
  }
}

function isBuffer(value: unknown): value is Buffer {
  // Can't use `Buffer` as a function here (i.e. `instanceof Buffer`)
  // because that would fail in the Workflow sandbox.
  if (!isRecord(value)) return false;

  // Resolving `isBuffer` through the value's own `constructor` keeps this correct
  // for `Buffer`s created in another realm, and avoids referencing the `Buffer`
  // global, which is undefined in the Workflow sandbox.
  const maybeBufferConstructor = value.constructor as BufferConstructor | undefined;
  return (
    maybeBufferConstructor?.name === 'Buffer' &&
    typeof maybeBufferConstructor?.isBuffer === 'function' &&
    maybeBufferConstructor?.isBuffer?.(value) === true
  );
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

function getNamespacedTypeName(type: Type): string {
  // protobufjs qualifies names from the root down, e.g. `.temporal.api.common.v1.Payload`.
  // The leading dot is not part of the name that goes on the wire.
  const { fullName } = type;
  return fullName.charAt(0) === '.' ? fullName.slice(1) : fullName;
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
