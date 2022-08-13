// Workaround an issue that prevents protobufjs from loading 'long' in Yarn 3 PnP
// https://github.com/protobufjs/protobuf.js/issues/1745#issuecomment-1200319399
const $protobuf = require('protobufjs/light');
$protobuf.util.Long = require('long');
$protobuf.configure();

const { patchProtobufRoot } = require('../lib/patch-protobuf-root');
const unpatchedRoot = require('./json-module');
module.exports = patchProtobufRoot(unpatchedRoot);
