/** @type {import('@docusaurus/types').DocusaurusConfig} */
require('dotenv').config();
const lightCodeTheme = require('prism-react-renderer').themes.github;
const darkCodeTheme = require('prism-react-renderer').themes.dracula;

const watch = ['y', 'yes', 't', 'true', '1'].includes(process.env.TYPEDOC_WATCH);

module.exports = {
  title: 'Temporal TypeScript SDK API Reference',
  tagline: 'Build invincible applications',
  url: 'https://typescript.temporal.io',
  baseUrl: '/',
  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',
  favicon: 'img/favicon.ico',
  organizationName: 'temporalio',
  projectName: 'sdk-typescript',
  themeConfig: {
    image: 'img/social.png',
    prism: {
      theme: lightCodeTheme,
      darkTheme: darkCodeTheme,
    },
    navbar: {
      logo: {
        alt: 'Temporal',
        src: 'img/temporal-logo-dark.svg',
        srcDark: 'img/temporal-logo.svg',
      },
      title: 'TypeScript SDK API Reference',
      items: [
        {
          href: 'https://temporal.io/ts',
          label: 'Docs',
          position: 'right',
        },
        {
          href: 'https://github.com/temporalio/sdk-typescript',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          items: [
            {
              label: 'SDK Docs',
              href: 'https://docs.temporal.io/typescript/introduction/',
            },
            {
              label: 'npm',
              href: 'https://www.npmjs.com/package/temporalio',
            },
            {
              label: 'Support Forum',
              href: 'https://community.temporal.io/',
            },
            {
              label: 'Community Slack',
              href: 'https://temporal.io/slack',
            },
          ],
        },
        {
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/temporalio/sdk-typescript',
            },
            {
              label: 'Twitter',
              href: 'https://twitter.com/temporalio',
            },
            {
              label: 'YouTube',
              href: 'https://www.youtube.com/c/Temporalio',
            },
            {
              label: 'Temporal Careers',
              href: 'https://temporal.io/careers',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Temporal Technologies Inc.`,
    },
    algolia: {
      appId: 'FL5BOEA5LF',
      apiKey: '00c3351a19fe08956c234eef9938d2ff', // public client key (search-only)
      indexName: 'typescript-temporal',
      algoliaOptions: { facetFilters: ['type:$TYPE'] },
    },
  },
  presets: [
    [
      '@docusaurus/preset-classic',
      {
        docs: {
          sidebarPath: require.resolve('./sidebars.js'),
          routeBasePath: '/',
        },
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
        sitemap: {
          changefreq: 'weekly',
          priority: 0.5,
        },
        gtag: {
          trackingID: 'UA-163137879-1',
          // Optional fields.
          anonymizeIP: true, // Should IPs be anonymized?
        },
      },
    ],
  ],
  plugins: [
    [
      'docusaurus-plugin-typedoc',
      {
        id: 'meta-docs',
        entryPoints: ['../meta/src/index.ts'],
        tsconfig: '../meta/tsconfig.json',
        excludeInternal: true,
        excludePrivate: true,
        excludeProtected: true,
        hideGenerator: true,
        disableSources: true,
        jsDocCompatibility: {
          exampleTag: false,
        },
        readme: 'none',
        watch,
        frontmatter: {
          image: 'img/social.png',
        },
      },
    ],
    ...(watch
      ? []
      : [
          [
            'docusaurus-plugin-snipsync',
            {
              origins: [
                {
                  pattern: '../*/src/**/*.ts',
                  owner: 'temporalio',
                  repo: 'sdk-typescript',
                  ref: 'main',
                },
                {
                  pattern: '../*/src/*.ts',
                  owner: 'temporalio',
                  repo: 'sdk-typescript',
                  ref: 'main',
                },
                {
                  pattern: '../create-project/samples/*.ts',
                  owner: 'temporalio',
                  repo: 'sdk-typescript',
                  ref: 'main',
                },
                {
                  owner: 'temporalio',
                  repo: 'samples-typescript',
                },
              ],
              targets: ['docs'],
              features: {
                enable_source_link: false,
                enable_code_block: true,
                allowed_target_extensions: ['.md'],
              },
            },
          ],
        ]),
  ],
  markdown: {
    format: 'md',
    mermaid: false,
    mdx1Compat: {
      comments: true,
      admonitions: true,
      headingIds: true,
    },
  },
};
