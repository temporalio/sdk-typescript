import { Payload } from '../interfaces';

export interface PayloadConverterWithEncoding {
  /**
   * Converts a value to a {@link Payload}.
   *
   * @param value The value to convert. Example values include the Workflow args sent from the Client and the values returned by a Workflow or Activity.
   * @returns The {@link Payload}, or `undefined` if unable to convert.
   */
  toPayload<T>(value: T): Payload | undefined;

  /**
   * Converts a {@link Payload} back to a value.
   */
  fromPayload<T>(payload: Payload): T;

  readonly encodingType: string;
}
