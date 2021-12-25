const { patchProtobufRoot } = require('@temporalio/common');
const unpatchedRoot = require('./json-module');
module.exports = patchProtobufRoot(unpatchedRoot);
