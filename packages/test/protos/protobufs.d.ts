import * as $protobuf from "protobufjs";
/** Properties of a ProtoActivityInput. */
export interface IProtoActivityInput {

    /** ProtoActivityInput name */
    name?: (string|null);

    /** ProtoActivityInput age */
    age?: (number|null);
}

/** Represents a ProtoActivityInput. */
export class ProtoActivityInput implements IProtoActivityInput {

    /**
     * Constructs a new ProtoActivityInput.
     * @param [properties] Properties to set
     */
    constructor(properties?: IProtoActivityInput);

    /** ProtoActivityInput name. */
    public name: string;

    /** ProtoActivityInput age. */
    public age: number;

    /**
     * Creates a new ProtoActivityInput instance using the specified properties.
     * @param [properties] Properties to set
     * @returns ProtoActivityInput instance
     */
    public static create(properties?: IProtoActivityInput): ProtoActivityInput;

    /**
     * Encodes the specified ProtoActivityInput message. Does not implicitly {@link ProtoActivityInput.verify|verify} messages.
     * @param message ProtoActivityInput message or plain object to encode
     * @param [writer] Writer to encode to
     * @returns Writer
     */
    public static encode(message: IProtoActivityInput, writer?: $protobuf.Writer): $protobuf.Writer;

    /**
     * Encodes the specified ProtoActivityInput message, length delimited. Does not implicitly {@link ProtoActivityInput.verify|verify} messages.
     * @param message ProtoActivityInput message or plain object to encode
     * @param [writer] Writer to encode to
     * @returns Writer
     */
    public static encodeDelimited(message: IProtoActivityInput, writer?: $protobuf.Writer): $protobuf.Writer;

    /**
     * Decodes a ProtoActivityInput message from the specified reader or buffer.
     * @param reader Reader or buffer to decode from
     * @param [length] Message length if known beforehand
     * @returns ProtoActivityInput
     * @throws {Error} If the payload is not a reader or valid buffer
     * @throws {$protobuf.util.ProtocolError} If required fields are missing
     */
    public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): ProtoActivityInput;

    /**
     * Decodes a ProtoActivityInput message from the specified reader or buffer, length delimited.
     * @param reader Reader or buffer to decode from
     * @returns ProtoActivityInput
     * @throws {Error} If the payload is not a reader or valid buffer
     * @throws {$protobuf.util.ProtocolError} If required fields are missing
     */
    public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): ProtoActivityInput;

    /**
     * Verifies a ProtoActivityInput message.
     * @param message Plain object to verify
     * @returns `null` if valid, otherwise the reason why it is not
     */
    public static verify(message: { [k: string]: any }): (string|null);

    /**
     * Creates a ProtoActivityInput message from a plain object. Also converts values to their respective internal types.
     * @param object Plain object
     * @returns ProtoActivityInput
     */
    public static fromObject(object: { [k: string]: any }): ProtoActivityInput;

    /**
     * Creates a plain object from a ProtoActivityInput message. Also converts values to other types if specified.
     * @param message ProtoActivityInput
     * @param [options] Conversion options
     * @returns Plain object
     */
    public static toObject(message: ProtoActivityInput, options?: $protobuf.IConversionOptions): { [k: string]: any };

    /**
     * Converts this ProtoActivityInput to JSON.
     * @returns JSON object
     */
    public toJSON(): { [k: string]: any };
}

/** Properties of a ProtoActivityResult. */
export interface IProtoActivityResult {

    /** ProtoActivityResult sentence */
    sentence?: (string|null);
}

/** Represents a ProtoActivityResult. */
export class ProtoActivityResult implements IProtoActivityResult {

    /**
     * Constructs a new ProtoActivityResult.
     * @param [properties] Properties to set
     */
    constructor(properties?: IProtoActivityResult);

    /** ProtoActivityResult sentence. */
    public sentence: string;

    /**
     * Creates a new ProtoActivityResult instance using the specified properties.
     * @param [properties] Properties to set
     * @returns ProtoActivityResult instance
     */
    public static create(properties?: IProtoActivityResult): ProtoActivityResult;

    /**
     * Encodes the specified ProtoActivityResult message. Does not implicitly {@link ProtoActivityResult.verify|verify} messages.
     * @param message ProtoActivityResult message or plain object to encode
     * @param [writer] Writer to encode to
     * @returns Writer
     */
    public static encode(message: IProtoActivityResult, writer?: $protobuf.Writer): $protobuf.Writer;

    /**
     * Encodes the specified ProtoActivityResult message, length delimited. Does not implicitly {@link ProtoActivityResult.verify|verify} messages.
     * @param message ProtoActivityResult message or plain object to encode
     * @param [writer] Writer to encode to
     * @returns Writer
     */
    public static encodeDelimited(message: IProtoActivityResult, writer?: $protobuf.Writer): $protobuf.Writer;

    /**
     * Decodes a ProtoActivityResult message from the specified reader or buffer.
     * @param reader Reader or buffer to decode from
     * @param [length] Message length if known beforehand
     * @returns ProtoActivityResult
     * @throws {Error} If the payload is not a reader or valid buffer
     * @throws {$protobuf.util.ProtocolError} If required fields are missing
     */
    public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): ProtoActivityResult;

    /**
     * Decodes a ProtoActivityResult message from the specified reader or buffer, length delimited.
     * @param reader Reader or buffer to decode from
     * @returns ProtoActivityResult
     * @throws {Error} If the payload is not a reader or valid buffer
     * @throws {$protobuf.util.ProtocolError} If required fields are missing
     */
    public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): ProtoActivityResult;

    /**
     * Verifies a ProtoActivityResult message.
     * @param message Plain object to verify
     * @returns `null` if valid, otherwise the reason why it is not
     */
    public static verify(message: { [k: string]: any }): (string|null);

    /**
     * Creates a ProtoActivityResult message from a plain object. Also converts values to their respective internal types.
     * @param object Plain object
     * @returns ProtoActivityResult
     */
    public static fromObject(object: { [k: string]: any }): ProtoActivityResult;

    /**
     * Creates a plain object from a ProtoActivityResult message. Also converts values to other types if specified.
     * @param message ProtoActivityResult
     * @param [options] Conversion options
     * @returns Plain object
     */
    public static toObject(message: ProtoActivityResult, options?: $protobuf.IConversionOptions): { [k: string]: any };

    /**
     * Converts this ProtoActivityResult to JSON.
     * @returns JSON object
     */
    public toJSON(): { [k: string]: any };
}
