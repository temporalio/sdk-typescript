const { patchProtobufRoot } = require('@temporalio/common/lib/converter/patch-protobuf-root');
const unpatchedRoot = require('./json-module');
module.exports = patchProtobufRoot(unpatchedRoot);
