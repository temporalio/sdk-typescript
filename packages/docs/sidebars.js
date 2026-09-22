const path = require('path');
const glob = require('glob');

function markdownFiles() {
  return glob.sync('docs/api/*/*.md', { cwd: __dirname, absolute: true, root: '' });
}

function titleCase(str) {
  return str.toLowerCase().replace(/\b(\w)/g, (s) => s.toUpperCase());
}

// Normalize the doc-relative path so it always uses forward slashes: on
// Windows `path.relative` returns backslashes, breaking both the `/`-split
// below and the doc IDs stored in the sidebar. Replacing both separator
// forms keeps the result consistent on any platform.
function relativeDocUrl(relative) {
  return relative.replace(/\\/g, '/').replace(/\.md$/, '');
}

function nestMarkdownFiles() {
  return markdownFiles()
    .sort()
    .sort((a, b) => a.split('.').length - b.split('.').length)
    .reduce((acc, f) => {
      // `path.relative` returns platform-specific separators, but the split
      // below and the doc IDs stored in the sidebar always use forward slashes.
      // Normalize so sidebar generation works on Windows too.
      const url = relativeDocUrl(path.relative(path.join(__dirname, 'docs'), f));
      const category = titleCase(url.split('/')[1]);
      const basename = path.basename(url);
      const parts = basename.split('.');
      if (parts.length === 1) {
        return [
          ...acc,
          {
            type: 'category',
            label: basename,
            link: { type: 'doc', id: `api/namespaces/${basename}` },
            items: [],
          },
        ];
      }
      // Find the right place to insert this item
      const items = parts
        .slice(0, -1) // Omit the last part, it'll be inserted below
        .reduce((items, part) => items.find((item) => typeof item === 'object' && item.label === part).items, acc);

      // Insert new item
      if (category === 'Namespaces') {
        items.push({
          type: 'category',
          label: url.replace(/.*\./, ''),
          link: { type: 'doc', id: `api/namespaces/${basename}` },
          items: [],
        });
      } else {
        let item = items.find(({ label }) => label === category);
        if (item === undefined) {
          const anchor = category.toLowerCase() === 'enums' ? 'enumerations' : category.toLowerCase();
          item = {
            type: 'category',
            label: category,
            items: [],
            customProps: {
              breadcrumbLink: `/api/namespaces/${parts[0]}#${anchor}`,
            },
          };
          items.push(item);
        }
        item.items.push(url);
      }
      return acc;
    }, []);
}

module.exports = {
  relativeDocUrl,
  referenceSidebar: [
    'index',
    {
      type: 'category',
      label: 'API',
      link: { type: 'doc', id: 'api/index' },
      items: nestMarkdownFiles(),
    },
  ],
};
