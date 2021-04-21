module.exports = {
  referenceSidebar: ['index'].concat(require('./typedoc-sidebar').filter((item) => item !== 'api/index')),
};
