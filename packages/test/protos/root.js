const { patchProtobufRoot } = require('@temporalio/common/internal/protobufs');
const unpatchedRoot = require('./json-module');
module.exports = patchProtobufRoot(unpatchedRoot);
