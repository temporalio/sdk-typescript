const { getPrebuiltPath } = require('./common');

try {
  const prebuiltPath = getPrebuiltPath();
  module.exports = require(prebuiltPath);
} catch (err) {
  throw err;
}
