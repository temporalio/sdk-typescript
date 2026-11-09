import path from 'node:path';
import { ReflectionKind } from 'typedoc';
import { MarkdownPageEvent, MemberRouter } from 'typedoc-plugin-markdown';

// Preserve the filenames from typedoc-plugin-markdown 3.17.1 with TypeDoc 0.25.13,
class LegacyRouter extends MemberRouter {
  getIdealBaseName(reflection) {
    // typedoc-plugin-markdown 3.17.1 used "enums" rather than the current "enumerations".
    const directory = reflection.kind === ReflectionKind.Enum ? 'enums' : this.directories.get(reflection.kind);
    return `${directory}/${reflection.getFullName()}`;
  }
}

export function load(app) {
  app.renderer.defineRouter('legacy', LegacyRouter);
  const outputDirectory = path.resolve(app.options.getValue('out'));

  app.renderer.on(MarkdownPageEvent.BEGIN, (page) => {
    const outputPath = path.relative(outputDirectory, page.filename).split(path.sep).join('/');
    const routePath = outputPath.replace(/\.md$/, '');

    // Keep the API entry page at /api.
    if (routePath === 'index' || routePath === outputPath) return;

    page.frontmatter = {
      ...page.frontmatter,
      slug: `/api/${routePath}`,
    };
  });
}
