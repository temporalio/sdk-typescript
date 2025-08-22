import type { Payload } from '../interfaces';
import type { ProtoFailure } from '../failure';

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

/** An object T with any nested values of type ToReplace replaced with ReplaceWith */
export type ReplaceNested<T, ToReplace, ReplaceWith> = T extends (...args: any[]) => any
  ? T
  : [keyof T] extends [never]
    ? T
    : T extends Record<string, string> // Special exception for Nexus Headers.
      ? T
      : T extends { [k: string]: ToReplace }
        ? {
            [P in keyof T]: ReplaceNested<T[P], ToReplace, ReplaceWith>;
          }
        : T extends ToReplace
          ? ReplaceWith | Exclude<T, ToReplace>
          : {
              [P in keyof T]: ReplaceNested<T[P], ToReplace, ReplaceWith>;
            };
