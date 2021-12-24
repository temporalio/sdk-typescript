const { patchRoot } = require('@temporalio/common');
const unpatchedRoot = require('./json-module');
module.exports = patchRoot(unpatchedRoot);
