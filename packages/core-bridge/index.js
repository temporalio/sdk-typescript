const { getPrebuiltPath, PrebuildError } = require('./common');

try {
  const prebuiltPath = getPrebuiltPath();
  module.exports = require(prebuiltPath);
} catch (err) {
  if (err instanceof PrebuildError) {
    module.exports = require('./default-build/index.node');
  } else {
    throw err;
  }
}
