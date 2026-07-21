import { defineConfig } from "vitepress";

const base = process.env.DOCS_BASE ?? "/pear-agent/";

export default defineConfig({
  title: "PEAR Agent",
  description: "Natural-language sources in. Durable execution plans out.",
  lang: "ja-JP",
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [["link", { rel: "icon", type: "image/svg+xml", href: `${base}pear-mark.svg` }]],
  themeConfig: {
    logo: "/pear-mark.svg",
    siteTitle: "PEAR Agent",
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Concepts", link: "/guide/concepts" },
      {
        text: "Packages",
        items: [
          { text: "Core", link: "/packages/core" },
          { text: "AI", link: "/packages/ai" },
          { text: "Cloudflare", link: "/packages/cloudflare" },
          { text: "React", link: "/packages/react" },
        ],
      },
      { text: "Agent Skill", link: "/guide/agent-skill" },
    ],
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "How PEAR works", link: "/guide/concepts" },
          { text: "Use the Agent Skill", link: "/guide/agent-skill" },
        ],
      },
      {
        text: "Build an app",
        items: [
          { text: "Define a Domain", link: "/guide/domain" },
          { text: "Compile with AI", link: "/guide/ai-compilation" },
          { text: "Wire Cloudflare", link: "/guide/cloudflare" },
          { text: "Connect React", link: "/guide/react" },
          { text: "Replan, resume, voice", link: "/guide/extensions" },
          { text: "Deploy", link: "/guide/deploy" },
        ],
      },
      {
        text: "Packages",
        items: [
          { text: "@pear-agent/core", link: "/packages/core" },
          { text: "@pear-agent/ai", link: "/packages/ai" },
          { text: "@pear-agent/cloudflare", link: "/packages/cloudflare" },
          { text: "@pear-agent/react", link: "/packages/react" },
        ],
      },
    ],
    search: { provider: "local" },
    outline: { level: [2, 3], label: "On this page" },
    socialLinks: [{ icon: "github", link: "https://github.com/aomona/pear-agent" }],
    editLink: {
      pattern: "https://github.com/aomona/pear-agent/edit/dev/website/:path",
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Execution support, not autonomous guesswork.",
      copyright: "Released under the MIT License.",
    },
  },
});
