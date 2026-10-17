import { defineConfig } from 'vitepress'

const base = '/synapse/'

export default defineConfig({
  title: 'Synapse',
  description:
    'An MCP server and live viewer that shows what your coding agent is planning, thinking, and changing as a real-time mindmap.',
  base,
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['HANDOFF.md', 'public/LOGO-CREDITS.md'],

  // Head links are not prefixed with `base` automatically.
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}icon.svg` }],
    ['link', { rel: 'icon', type: 'image/png', href: `${base}favicon.png` }],
  ],

  themeConfig: {
    logo: '/icon.svg',

    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Reference', link: '/reference/tools', activeMatch: '/reference/' },
      { text: 'Development', link: '/development' },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Connecting Clients', link: '/guide/clients' },
          { text: 'The Viewer', link: '/guide/viewer' },
          { text: 'How It Works', link: '/guide/how-it-works' },
          { text: 'Agent Instructions', link: '/guide/agent-instructions' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'MCP Tools', link: '/reference/tools' },
          { text: 'CLI', link: '/reference/cli' },
        ],
      },
      {
        text: 'Contributing',
        items: [{ text: 'Development', link: '/development' }],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/vss96/synapse' }],

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/vss96/synapse/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
    },
  },
})
