/*eslint-disable block-scoped-var, id-length, no-control-regex, no-magic-numbers, no-prototype-builtins, no-redeclare, no-shadow, no-var, sort-vars*/
"use strict";

var $protobuf = require("protobufjs/minimal");

// Common aliases
var $Reader = $protobuf.Reader, $Writer = $protobuf.Writer, $util = $protobuf.util;

// Exported root namespace
var $root = $protobuf.roots["default"] || ($protobuf.roots["default"] = {});

$root.ProtoActivityInput = (function() {

    /**
     * Properties of a ProtoActivityInput.
     * @exports IProtoActivityInput
     * @interface IProtoActivityInput
     * @property {string|null} [name] ProtoActivityInput name
     * @property {number|null} [age] ProtoActivityInput age
     */

    /**
     * Constructs a new ProtoActivityInput.
     * @exports ProtoActivityInput
     * @classdesc Represents a ProtoActivityInput.
     * @implements IProtoActivityInput
     * @constructor
     * @param {IProtoActivityInput=} [properties] Properties to set
     */
    function ProtoActivityInput(properties) {
        if (properties)
            for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                if (properties[keys[i]] != null)
                    this[keys[i]] = properties[keys[i]];
    }

    /**
     * ProtoActivityInput name.
     * @member {string} name
     * @memberof ProtoActivityInput
     * @instance
     */
    ProtoActivityInput.prototype.name = "";

    /**
     * ProtoActivityInput age.
     * @member {number} age
     * @memberof ProtoActivityInput
     * @instance
     */
    ProtoActivityInput.prototype.age = 0;

    /**
     * Creates a new ProtoActivityInput instance using the specified properties.
     * @function create
     * @memberof ProtoActivityInput
     * @static
     * @param {IProtoActivityInput=} [properties] Properties to set
     * @returns {ProtoActivityInput} ProtoActivityInput instance
     */
    ProtoActivityInput.create = function create(properties) {
        return new ProtoActivityInput(properties);
    };

    /**
     * Encodes the specified ProtoActivityInput message. Does not implicitly {@link ProtoActivityInput.verify|verify} messages.
     * @function encode
     * @memberof ProtoActivityInput
     * @static
     * @param {IProtoActivityInput} message ProtoActivityInput message or plain object to encode
     * @param {$protobuf.Writer} [writer] Writer to encode to
     * @returns {$protobuf.Writer} Writer
     */
    ProtoActivityInput.encode = function encode(message, writer) {
        if (!writer)
            writer = $Writer.create();
        if (message.name != null && Object.hasOwnProperty.call(message, "name"))
            writer.uint32(/* id 1, wireType 2 =*/10).string(message.name);
        if (message.age != null && Object.hasOwnProperty.call(message, "age"))
            writer.uint32(/* id 2, wireType 0 =*/16).int32(message.age);
        return writer;
    };

    /**
     * Encodes the specified ProtoActivityInput message, length delimited. Does not implicitly {@link ProtoActivityInput.verify|verify} messages.
     * @function encodeDelimited
     * @memberof ProtoActivityInput
     * @static
     * @param {IProtoActivityInput} message ProtoActivityInput message or plain object to encode
     * @param {$protobuf.Writer} [writer] Writer to encode to
     * @returns {$protobuf.Writer} Writer
     */
    ProtoActivityInput.encodeDelimited = function encodeDelimited(message, writer) {
        return this.encode(message, writer).ldelim();
    };

    /**
     * Decodes a ProtoActivityInput message from the specified reader or buffer.
     * @function decode
     * @memberof ProtoActivityInput
     * @static
     * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
     * @param {number} [length] Message length if known beforehand
     * @returns {ProtoActivityInput} ProtoActivityInput
     * @throws {Error} If the payload is not a reader or valid buffer
     * @throws {$protobuf.util.ProtocolError} If required fields are missing
     */
    ProtoActivityInput.decode = function decode(reader, length) {
        if (!(reader instanceof $Reader))
            reader = $Reader.create(reader);
        var end = length === undefined ? reader.len : reader.pos + length, message = new $root.ProtoActivityInput();
        while (reader.pos < end) {
            var tag = reader.uint32();
            switch (tag >>> 3) {
            case 1:
                message.name = reader.string();
                break;
            case 2:
                message.age = reader.int32();
                break;
            default:
                reader.skipType(tag & 7);
                break;
            }
        }
        return message;
    };

    /**
     * Decodes a ProtoActivityInput message from the specified reader or buffer, length delimited.
     * @function decodeDelimited
     * @memberof ProtoActivityInput
     * @static
     * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
     * @returns {ProtoActivityInput} ProtoActivityInput
     * @throws {Error} If the payload is not a reader or valid buffer
     * @throws {$protobuf.util.ProtocolError} If required fields are missing
     */
    ProtoActivityInput.decodeDelimited = function decodeDelimited(reader) {
        if (!(reader instanceof $Reader))
            reader = new $Reader(reader);
        return this.decode(reader, reader.uint32());
    };

    /**
     * Verifies a ProtoActivityInput message.
     * @function verify
     * @memberof ProtoActivityInput
     * @static
     * @param {Object.<string,*>} message Plain object to verify
     * @returns {string|null} `null` if valid, otherwise the reason why it is not
     */
    ProtoActivityInput.verify = function verify(message) {
        if (typeof message !== "object" || message === null)
            return "object expected";
        if (message.name != null && message.hasOwnProperty("name"))
            if (!$util.isString(message.name))
                return "name: string expected";
        if (message.age != null && message.hasOwnProperty("age"))
            if (!$util.isInteger(message.age))
                return "age: integer expected";
        return null;
    };

    /**
     * Creates a ProtoActivityInput message from a plain object. Also converts values to their respective internal types.
     * @function fromObject
     * @memberof ProtoActivityInput
     * @static
     * @param {Object.<string,*>} object Plain object
     * @returns {ProtoActivityInput} ProtoActivityInput
     */
    ProtoActivityInput.fromObject = function fromObject(object) {
        if (object instanceof $root.ProtoActivityInput)
            return object;
        var message = new $root.ProtoActivityInput();
        if (object.name != null)
            message.name = String(object.name);
        if (object.age != null)
            message.age = object.age | 0;
        return message;
    };

    /**
     * Creates a plain object from a ProtoActivityInput message. Also converts values to other types if specified.
     * @function toObject
     * @memberof ProtoActivityInput
     * @static
     * @param {ProtoActivityInput} message ProtoActivityInput
     * @param {$protobuf.IConversionOptions} [options] Conversion options
     * @returns {Object.<string,*>} Plain object
     */
    ProtoActivityInput.toObject = function toObject(message, options) {
        if (!options)
            options = {};
        var object = {};
        if (options.defaults) {
            object.name = "";
            object.age = 0;
        }
        if (message.name != null && message.hasOwnProperty("name"))
            object.name = message.name;
        if (message.age != null && message.hasOwnProperty("age"))
            object.age = message.age;
        return object;
    };

    /**
     * Converts this ProtoActivityInput to JSON.
     * @function toJSON
     * @memberof ProtoActivityInput
     * @instance
     * @returns {Object.<string,*>} JSON object
     */
    ProtoActivityInput.prototype.toJSON = function toJSON() {
        return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
    };

    return ProtoActivityInput;
})();

$root.ProtoActivityResult = (function() {

    /**
     * Properties of a ProtoActivityResult.
     * @exports IProtoActivityResult
     * @interface IProtoActivityResult
     * @property {string|null} [sentence] ProtoActivityResult sentence
     */

    /**
     * Constructs a new ProtoActivityResult.
     * @exports ProtoActivityResult
     * @classdesc Represents a ProtoActivityResult.
     * @implements IProtoActivityResult
     * @constructor
     * @param {IProtoActivityResult=} [properties] Properties to set
     */
    function ProtoActivityResult(properties) {
        if (properties)
            for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                if (properties[keys[i]] != null)
                    this[keys[i]] = properties[keys[i]];
    }

    /**
     * ProtoActivityResult sentence.
     * @member {string} sentence
     * @memberof ProtoActivityResult
     * @instance
     */
    ProtoActivityResult.prototype.sentence = "";

    /**
     * Creates a new ProtoActivityResult instance using the specified properties.
     * @function create
     * @memberof ProtoActivityResult
     * @static
     * @param {IProtoActivityResult=} [properties] Properties to set
     * @returns {ProtoActivityResult} ProtoActivityResult instance
     */
    ProtoActivityResult.create = function create(properties) {
        return new ProtoActivityResult(properties);
    };

    /**
     * Encodes the specified ProtoActivityResult message. Does not implicitly {@link ProtoActivityResult.verify|verify} messages.
     * @function encode
     * @memberof ProtoActivityResult
     * @static
     * @param {IProtoActivityResult} message ProtoActivityResult message or plain object to encode
     * @param {$protobuf.Writer} [writer] Writer to encode to
     * @returns {$protobuf.Writer} Writer
     */
    ProtoActivityResult.encode = function encode(message, writer) {
        if (!writer)
            writer = $Writer.create();
        if (message.sentence != null && Object.hasOwnProperty.call(message, "sentence"))
            writer.uint32(/* id 1, wireType 2 =*/10).string(message.sentence);
        return writer;
    };

    /**
     * Encodes the specified ProtoActivityResult message, length delimited. Does not implicitly {@link ProtoActivityResult.verify|verify} messages.
     * @function encodeDelimited
     * @memberof ProtoActivityResult
     * @static
     * @param {IProtoActivityResult} message ProtoActivityResult message or plain object to encode
     * @param {$protobuf.Writer} [writer] Writer to encode to
     * @returns {$protobuf.Writer} Writer
     */
    ProtoActivityResult.encodeDelimited = function encodeDelimited(message, writer) {
        return this.encode(message, writer).ldelim();
    };

    /**
     * Decodes a ProtoActivityResult message from the specified reader or buffer.
     * @function decode
     * @memberof ProtoActivityResult
     * @static
     * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
     * @param {number} [length] Message length if known beforehand
     * @returns {ProtoActivityResult} ProtoActivityResult
     * @throws {Error} If the payload is not a reader or valid buffer
     * @throws {$protobuf.util.ProtocolError} If required fields are missing
     */
    ProtoActivityResult.decode = function decode(reader, length) {
        if (!(reader instanceof $Reader))
            reader = $Reader.create(reader);
        var end = length === undefined ? reader.len : reader.pos + length, message = new $root.ProtoActivityResult();
        while (reader.pos < end) {
            var tag = reader.uint32();
            switch (tag >>> 3) {
            case 1:
                message.sentence = reader.string();
                break;
            default:
                reader.skipType(tag & 7);
                break;
            }
        }
        return message;
    };

    /**
     * Decodes a ProtoActivityResult message from the specified reader or buffer, length delimited.
     * @function decodeDelimited
     * @memberof ProtoActivityResult
     * @static
     * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
     * @returns {ProtoActivityResult} ProtoActivityResult
     * @throws {Error} If the payload is not a reader or valid buffer
     * @throws {$protobuf.util.ProtocolError} If required fields are missing
     */
    ProtoActivityResult.decodeDelimited = function decodeDelimited(reader) {
        if (!(reader instanceof $Reader))
            reader = new $Reader(reader);
        return this.decode(reader, reader.uint32());
    };

    /**
     * Verifies a ProtoActivityResult message.
     * @function verify
     * @memberof ProtoActivityResult
     * @static
     * @param {Object.<string,*>} message Plain object to verify
     * @returns {string|null} `null` if valid, otherwise the reason why it is not
     */
    ProtoActivityResult.verify = function verify(message) {
        if (typeof message !== "object" || message === null)
            return "object expected";
        if (message.sentence != null && message.hasOwnProperty("sentence"))
            if (!$util.isString(message.sentence))
                return "sentence: string expected";
        return null;
    };

    /**
     * Creates a ProtoActivityResult message from a plain object. Also converts values to their respective internal types.
     * @function fromObject
     * @memberof ProtoActivityResult
     * @static
     * @param {Object.<string,*>} object Plain object
     * @returns {ProtoActivityResult} ProtoActivityResult
     */
    ProtoActivityResult.fromObject = function fromObject(object) {
        if (object instanceof $root.ProtoActivityResult)
            return object;
        var message = new $root.ProtoActivityResult();
        if (object.sentence != null)
            message.sentence = String(object.sentence);
        return message;
    };

    /**
     * Creates a plain object from a ProtoActivityResult message. Also converts values to other types if specified.
     * @function toObject
     * @memberof ProtoActivityResult
     * @static
     * @param {ProtoActivityResult} message ProtoActivityResult
     * @param {$protobuf.IConversionOptions} [options] Conversion options
     * @returns {Object.<string,*>} Plain object
     */
    ProtoActivityResult.toObject = function toObject(message, options) {
        if (!options)
            options = {};
        var object = {};
        if (options.defaults)
            object.sentence = "";
        if (message.sentence != null && message.hasOwnProperty("sentence"))
            object.sentence = message.sentence;
        return object;
    };

    /**
     * Converts this ProtoActivityResult to JSON.
     * @function toJSON
     * @memberof ProtoActivityResult
     * @instance
     * @returns {Object.<string,*>} JSON object
     */
    ProtoActivityResult.prototype.toJSON = function toJSON() {
        return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
    };

    return ProtoActivityResult;
})();

module.exports = $root;
