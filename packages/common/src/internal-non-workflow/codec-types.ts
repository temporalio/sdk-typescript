import type { Payload } from '../interfaces';
import type { ProtoFailure } from '../failure';
import type { ReplaceNested } from '../type-helpers';

export interface EncodedPayload extends Payload {
  encoded: true;
}

export interface DecodedPayload extends Payload {
  decoded: true;
}

/** Replace `Payload`s with `EncodedPayload`s */
export type Encoded<T> = ReplaceNested<T, Payload, EncodedPayload>;

/** Replace `Payload`s with `DecodedPayload`s */
export type Decoded<T> = ReplaceNested<T, Payload, DecodedPayload>;

export type EncodedProtoFailure = Encoded<ProtoFailure>;
export type DecodedProtoFailure = Decoded<ProtoFailure>;
