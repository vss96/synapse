---
layout: home

hero:
  name: Synapse
  text: A live mindmap of what your coding agent is planning, thinking, and changing
  tagline: An MCP server and web viewer for Claude Code, Claude Desktop, Cursor, OpenCode, Codex, Windsurf, and any other MCP client.
  image:
    src: /hero.svg
    alt: A Synapse mindmap drawn as a network of neurons
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/vss96/synapse

features:
  - icon: 🗺️
    title: The plan, live
    details: Tasks with planned, in progress, completed, and blocked statuses update in the viewer as the agent works through them.
  - icon: 🧠
    title: The agent's mental model
    details: Components, data flows, decisions, hypotheses, and risks, joined by labeled arrows, show how the agent understands your code.
  - icon: 📝
    title: What changed, and how
    details: Every touched file is attached to the task that touched it, with symbol-level changes such as add, fix, refactor, rename, remove, and test.
  - icon: 🔌
    title: Works with any MCP client
    details: One command, npx synapse-mindmap init, configures the clients you have installed. You can also add it to any client by hand.
  - icon: ⎇
    title: Git aware
    details: A workspace watcher and git sync attach changed files on their own, so files show up even when the agent forgets to log them.
  - icon: 💾
    title: Local and plain
    details: Each mindmap is a JSON file on your machine. There is no account and no cloud service.
---

<div style="max-width: 1152px; margin: 48px auto 0;">

![Split view: the plan tree next to the agent's code mental model](./screenshots/split-view.png)

</div>
