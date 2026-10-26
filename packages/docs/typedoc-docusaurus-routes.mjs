import path from 'node:path';
import { MarkdownPageEvent } from 'typedoc-plugin-markdown';

export function load(app) {
  const outputDirectory = path.resolve(app.options.getValue('out'));

  app.renderer.on(MarkdownPageEvent.BEGIN, (page) => {
    const outputPath = path.relative(outputDirectory, page.filename).split(path.sep).join('/');
    const routePath = outputPath
      .replace(/^temporalio\//, '')
      .replace(/\/index\.md$/, '')
      .replace(/\.md$/, '');

    // Keep the API entry page at /api and preserve the existing namespace URLs.
    if (routePath === 'index' || routePath === outputPath) return;

    page.frontmatter = {
      ...page.frontmatter,
      slug: `/api/${routePath}`,
    };
  });
}
