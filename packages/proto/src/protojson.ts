// The JSON codec for the generated types, from the same protobufjs copy they were built with.
// protobufjs checks that a type is one of its own, and npm can install a second copy for a
// package that depends on protobufjs too. A codec from that copy rejects these types.
export { fromJson, toJson } from 'protobufjs/ext/protojson';
