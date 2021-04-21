/** @type {import('@docusaurus/types').DocusaurusConfig} */
module.exports = {
  title: 'Temporal NodeJS SDK API Reference',
  tagline: 'Build invincible applications',
  url: 'https://nodejs.temporal.io',
  baseUrl: '/',
  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',
  favicon: 'img/favicon.ico',
  organizationName: 'temporalio',
  projectName: 'sdk-node',
  themeConfig: {
    prism: {
      theme: require('prism-react-renderer/themes/dracula'),
    },
    navbar: {
      logo: {
        alt: 'Temporal',
        src: 'img/temporal-logo-dark.svg',
        srcDark: 'img/temporal-logo.svg',
      },
      items: [
        {
          href: 'https://github.com/temporalio/sdk-node',
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
              label: 'NPM',
              href: 'https://www.npmjs.com/package/temporalio',
            },
            {
              label: 'Support Forum',
              href: 'https://community.temporal.io/',
            },
            {
              label: 'Public Slack',
              href: 'https://join.slack.com/t/temporalio/shared_invite/zt-onhti57l-J0bl~Tr7MqSUnIc1upjRkw',
            },
            {
              label: 'Temporal Careers',
              href: 'https://temporal.io/careers',
            },
          ],
        },
        {
          items: [
            {
              label: 'Temporal Documentation',
              to: 'https://docs.temporal.io',
            },
            {
              label: 'GitHub',
              href: 'https://github.com/temporalio/sdk-node',
            },
            {
              label: 'Twitter',
              href: 'https://twitter.com/temporalio',
            },
            {
              label: 'YouTube',
              href: 'https://www.youtube.com/channel/UCGovZyy8OfFPNlNV0i1fI1g',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Temporal Technologies Inc.`,
    },
    gtag: {
      trackingID: 'UA-163137879-1',
      // Optional fields.
      anonymizeIP: true, // Should IPs be anonymized?
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
      },
    ],
  ],
  plugins: [
    [
      'docusaurus-plugin-typedoc',
      {
        entryPoints: ['../meta/src/index.ts'],
        tsconfig: '../meta/tsconfig.json',
        excludePrivate: true,
        excludeProtected: true,
        hideGenerator: true,
        disableSources: true,
        hideBreadcrumbs: true,
        readme: 'none',
        watch: ['y', 'yes', 't', 'true', '1'].includes(process.env.TYPEDOC_WATCH),
      },
    ],
  ],
};
