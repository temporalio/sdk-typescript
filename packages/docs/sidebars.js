const path = require('path');
const glob = require('glob');

function markdownFiles() {
  return glob.sync(path.join(__dirname, 'docs/api/*/*.md'));
}

function titleCase(str) {
  return str.toLowerCase().replace(/\b(\w)/g, (s) => s.toUpperCase());
}

function nestMarkdownFiles() {
  return markdownFiles()
    .sort((a, b) => a.split('.').length - b.split('.').length)
    .reduce((acc, f) => {
      const url = path.relative(path.join(__dirname, 'docs'), f).replace(/\.md$/, '');
      const category = titleCase(url.split('/')[1]);
      const basename = path.basename(url);
      const parts = basename.split('.');
      if (parts.length === 1) {
        return [...acc, { type: 'category', label: basename, items: [url] }];
      }
      // Find the right place to insert this item
      const items = parts
        .slice(0, -1) // Omit the last part, it'll be inserted below
        .reduce((items, part) => items.find((item) => typeof item === 'object' && item.label === part).items, acc);

      // Insert new item
      if (category === 'Namespaces') {
        items.push({ type: 'category', label: url.replace(/.*\./, ''), items: [url] });
      } else {
        let item = items.find(({ label }) => label === category);
        if (item === undefined) {
          item = { type: 'category', label: category, items: [] };
          items.push(item);
        }
        item.items.push(url);
      }
      return acc;
    }, []);
}

module.exports = {
  referenceSidebar: ['index', { type: 'category', label: 'API', items: nestMarkdownFiles() }],
};
