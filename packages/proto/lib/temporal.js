const { patchProtobufRoot } = require('@temporalio/common/lib/converter/patch-protobuf-root');
const unpatchedRoot = require('./temporal-json-module');
module.exports = patchProtobufRoot(unpatchedRoot);
