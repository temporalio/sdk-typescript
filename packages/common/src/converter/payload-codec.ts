import { Payload } from './types';

/**
 * `PayloadCodec` is an optional step that happens between the wire and the {@link PayloadConverter}:
 *
 * Temporal Server <--> Wire <--> `PayloadCodec` <--> `PayloadConverter` <--> User code
 *
 * Implement this to transform an array of {@link Payload}s to/from the format sent over the wire and stored by Temporal Server.
 * Common transformations are encryption and compression.
 */
export interface PayloadCodec {
  /**
   * Encode an array of {@link Payload}s for sending over the wire.
   * @param payloads May have length 0.
   */
  encode(payloads: Payload[]): Promise<Payload[]>;

  /**
   * Decode an array of {@link Payload}s received from the wire.
   */
  decode(payloads: Payload[]): Promise<Payload[]>;
}

/**
 * No-op implementation of {@link PayloadCodec}.
 */
export const defaultPayloadCodec = {
  encode: async (payloads: Payload[]): Promise<Payload[]> => payloads,
  decode: async (payloads: Payload[]): Promise<Payload[]> => payloads,
};
