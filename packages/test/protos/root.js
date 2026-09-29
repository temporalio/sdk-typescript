const { patchProtobufRoot } = require('@temporalio/common/lib/protobufs');
const unpatchedRoot = require('./json-module');
module.exports = patchProtobufRoot(unpatchedRoot);
