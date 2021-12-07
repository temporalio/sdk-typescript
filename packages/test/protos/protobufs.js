/*eslint-disable block-scoped-var, id-length, no-control-regex, no-magic-numbers, no-prototype-builtins, no-redeclare, no-shadow, no-var, sort-vars*/
"use strict";

var $protobuf = require("protobufjs/minimal");

// Common aliases
var $Reader = $protobuf.Reader, $Writer = $protobuf.Writer, $util = $protobuf.util;

// Exported root namespace
var $root = $protobuf.roots["default"] || ($protobuf.roots["default"] = {});

$root.FooSignalArgs = (function() {

    /**
     * Properties of a FooSignalArgs.
     * @exports IFooSignalArgs
     * @interface IFooSignalArgs
     * @property {string|null} [name] FooSignalArgs name
     * @property {number|null} [age] FooSignalArgs age
     */

    /**
     * Constructs a new FooSignalArgs.
     * @exports FooSignalArgs
     * @classdesc Represents a FooSignalArgs.
     * @implements IFooSignalArgs
     * @constructor
     * @param {IFooSignalArgs=} [properties] Properties to set
     */
    function FooSignalArgs(properties) {
        if (properties)
            for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                if (properties[keys[i]] != null)
                    this[keys[i]] = properties[keys[i]];
    }

    /**
     * FooSignalArgs name.
     * @member {string} name
     * @memberof FooSignalArgs
     * @instance
     */
    FooSignalArgs.prototype.name = "";

    /**
     * FooSignalArgs age.
     * @member {number} age
     * @memberof FooSignalArgs
     * @instance
     */
    FooSignalArgs.prototype.age = 0;

    /**
     * Creates a new FooSignalArgs instance using the specified properties.
     * @function create
     * @memberof FooSignalArgs
     * @static
     * @param {IFooSignalArgs=} [properties] Properties to set
     * @returns {FooSignalArgs} FooSignalArgs instance
     */
    FooSignalArgs.create = function create(properties) {
        return new FooSignalArgs(properties);
    };

    /**
     * Encodes the specified FooSignalArgs message. Does not implicitly {@link FooSignalArgs.verify|verify} messages.
     * @function encode
     * @memberof FooSignalArgs
     * @static
     * @param {IFooSignalArgs} message FooSignalArgs message or plain object to encode
     * @param {$protobuf.Writer} [writer] Writer to encode to
     * @returns {$protobuf.Writer} Writer
     */
    FooSignalArgs.encode = function encode(message, writer) {
        if (!writer)
            writer = $Writer.create();
        if (message.name != null && Object.hasOwnProperty.call(message, "name"))
            writer.uint32(/* id 1, wireType 2 =*/10).string(message.name);
        if (message.age != null && Object.hasOwnProperty.call(message, "age"))
            writer.uint32(/* id 2, wireType 0 =*/16).int32(message.age);
        return writer;
    };

    /**
     * Encodes the specified FooSignalArgs message, length delimited. Does not implicitly {@link FooSignalArgs.verify|verify} messages.
     * @function encodeDelimited
     * @memberof FooSignalArgs
     * @static
     * @param {IFooSignalArgs} message FooSignalArgs message or plain object to encode
     * @param {$protobuf.Writer} [writer] Writer to encode to
     * @returns {$protobuf.Writer} Writer
     */
    FooSignalArgs.encodeDelimited = function encodeDelimited(message, writer) {
        return this.encode(message, writer).ldelim();
    };

    /**
     * Decodes a FooSignalArgs message from the specified reader or buffer.
     * @function decode
     * @memberof FooSignalArgs
     * @static
     * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
     * @param {number} [length] Message length if known beforehand
     * @returns {FooSignalArgs} FooSignalArgs
     * @throws {Error} If the payload is not a reader or valid buffer
     * @throws {$protobuf.util.ProtocolError} If required fields are missing
     */
    FooSignalArgs.decode = function decode(reader, length) {
        if (!(reader instanceof $Reader))
            reader = $Reader.create(reader);
        var end = length === undefined ? reader.len : reader.pos + length, message = new $root.FooSignalArgs();
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
     * Decodes a FooSignalArgs message from the specified reader or buffer, length delimited.
     * @function decodeDelimited
     * @memberof FooSignalArgs
     * @static
     * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
     * @returns {FooSignalArgs} FooSignalArgs
     * @throws {Error} If the payload is not a reader or valid buffer
     * @throws {$protobuf.util.ProtocolError} If required fields are missing
     */
    FooSignalArgs.decodeDelimited = function decodeDelimited(reader) {
        if (!(reader instanceof $Reader))
            reader = new $Reader(reader);
        return this.decode(reader, reader.uint32());
    };

    /**
     * Verifies a FooSignalArgs message.
     * @function verify
     * @memberof FooSignalArgs
     * @static
     * @param {Object.<string,*>} message Plain object to verify
     * @returns {string|null} `null` if valid, otherwise the reason why it is not
     */
    FooSignalArgs.verify = function verify(message) {
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
     * Creates a FooSignalArgs message from a plain object. Also converts values to their respective internal types.
     * @function fromObject
     * @memberof FooSignalArgs
     * @static
     * @param {Object.<string,*>} object Plain object
     * @returns {FooSignalArgs} FooSignalArgs
     */
    FooSignalArgs.fromObject = function fromObject(object) {
        if (object instanceof $root.FooSignalArgs)
            return object;
        var message = new $root.FooSignalArgs();
        if (object.name != null)
            message.name = String(object.name);
        if (object.age != null)
            message.age = object.age | 0;
        return message;
    };

    /**
     * Creates a plain object from a FooSignalArgs message. Also converts values to other types if specified.
     * @function toObject
     * @memberof FooSignalArgs
     * @static
     * @param {FooSignalArgs} message FooSignalArgs
     * @param {$protobuf.IConversionOptions} [options] Conversion options
     * @returns {Object.<string,*>} Plain object
     */
    FooSignalArgs.toObject = function toObject(message, options) {
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
     * Converts this FooSignalArgs to JSON.
     * @function toJSON
     * @memberof FooSignalArgs
     * @instance
     * @returns {Object.<string,*>} JSON object
     */
    FooSignalArgs.prototype.toJSON = function toJSON() {
        return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
    };

    return FooSignalArgs;
})();

module.exports = $root;
