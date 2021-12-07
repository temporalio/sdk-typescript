import * as $protobuf from "protobufjs";
/** Properties of a FooSignalArgs. */
export interface IFooSignalArgs {

    /** FooSignalArgs name */
    name?: (string|null);

    /** FooSignalArgs age */
    age?: (number|null);
}

/** Represents a FooSignalArgs. */
export class FooSignalArgs implements IFooSignalArgs {

    /**
     * Constructs a new FooSignalArgs.
     * @param [properties] Properties to set
     */
    constructor(properties?: IFooSignalArgs);

    /** FooSignalArgs name. */
    public name: string;

    /** FooSignalArgs age. */
    public age: number;

    /**
     * Creates a new FooSignalArgs instance using the specified properties.
     * @param [properties] Properties to set
     * @returns FooSignalArgs instance
     */
    public static create(properties?: IFooSignalArgs): FooSignalArgs;

    /**
     * Encodes the specified FooSignalArgs message. Does not implicitly {@link FooSignalArgs.verify|verify} messages.
     * @param message FooSignalArgs message or plain object to encode
     * @param [writer] Writer to encode to
     * @returns Writer
     */
    public static encode(message: IFooSignalArgs, writer?: $protobuf.Writer): $protobuf.Writer;

    /**
     * Encodes the specified FooSignalArgs message, length delimited. Does not implicitly {@link FooSignalArgs.verify|verify} messages.
     * @param message FooSignalArgs message or plain object to encode
     * @param [writer] Writer to encode to
     * @returns Writer
     */
    public static encodeDelimited(message: IFooSignalArgs, writer?: $protobuf.Writer): $protobuf.Writer;

    /**
     * Decodes a FooSignalArgs message from the specified reader or buffer.
     * @param reader Reader or buffer to decode from
     * @param [length] Message length if known beforehand
     * @returns FooSignalArgs
     * @throws {Error} If the payload is not a reader or valid buffer
     * @throws {$protobuf.util.ProtocolError} If required fields are missing
     */
    public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): FooSignalArgs;

    /**
     * Decodes a FooSignalArgs message from the specified reader or buffer, length delimited.
     * @param reader Reader or buffer to decode from
     * @returns FooSignalArgs
     * @throws {Error} If the payload is not a reader or valid buffer
     * @throws {$protobuf.util.ProtocolError} If required fields are missing
     */
    public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): FooSignalArgs;

    /**
     * Verifies a FooSignalArgs message.
     * @param message Plain object to verify
     * @returns `null` if valid, otherwise the reason why it is not
     */
    public static verify(message: { [k: string]: any }): (string|null);

    /**
     * Creates a FooSignalArgs message from a plain object. Also converts values to their respective internal types.
     * @param object Plain object
     * @returns FooSignalArgs
     */
    public static fromObject(object: { [k: string]: any }): FooSignalArgs;

    /**
     * Creates a plain object from a FooSignalArgs message. Also converts values to other types if specified.
     * @param message FooSignalArgs
     * @param [options] Conversion options
     * @returns Plain object
     */
    public static toObject(message: FooSignalArgs, options?: $protobuf.IConversionOptions): { [k: string]: any };

    /**
     * Converts this FooSignalArgs to JSON.
     * @returns JSON object
     */
    public toJSON(): { [k: string]: any };
}
