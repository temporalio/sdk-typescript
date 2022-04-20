const { patchProtobufRoot } = require('./patch-protobuf-root');
const unpatchedRoot = require('./json-module');
module.exports = patchProtobufRoot(unpatchedRoot);
