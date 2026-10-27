const typedocSidebar = require('./docs/api/typedoc-sidebar.cjs');
const apiItems = typedocSidebar.flatMap((item) =>
  item.type === 'category' && item.label === 'Namespaces' ? item.items : [item]
);

module.exports = {
  referenceSidebar: [
    'index',
    {
      type: 'category',
      label: 'API',
      link: { type: 'doc', id: 'api/index' },
      items: apiItems,
    },
  ],
};
