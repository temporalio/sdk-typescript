const { patchProtobufRoot } = require('@temporalio/common/protobufs');
const unpatchedRoot = require('./json-module');
module.exports = patchProtobufRoot(unpatchedRoot);
