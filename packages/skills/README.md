# @comis/skills

Skill system, MCP integration, built-in tools, and media processing for [Comis](https://github.com/comisai/comis) agents.

## What's Inside

### Skill Registry

Modular prompt packages that give agents specialized knowledge, workflows, and persona traits. Skills are loaded from markdown files with runtime eligibility filtering, dynamic context injection, and file watching for live reload. Content scanning prevents injection attacks in skill definitions.

### MCP Client

Full [Model Context Protocol](https://modelcontextprotocol.io/) integration with server configuration, connection management, tool translation, and credential injection.

### Built-in Tools

| Category | Tools |
|----------|-------|
| **Web** | Web search, web fetch |
| **Files** | Read, write, patch, state tracking |
| **Execution** | Sandboxed shell exec, process management |
| **Memory** | Search, get, store (with trust partitioning) |
| **Messaging** | Send messages, reply, react across channels |
| **Scheduling** | Create/manage cron jobs |
| **Media** | Image generation, TTS, transcription, video description, document extraction |
| **Browser** | Headless browser automation via Playwright |
| **Platform** | Channel-specific operations (Discord, Telegram, Slack, WhatsApp) |
| **Infrastructure** | Gateway management, fleet operations |

### Media Integrations

- **Vision** -- Multi-provider registry with scope resolution (image + video analysis)
- **Text-to-Speech** -- OpenAI, ElevenLabs, Edge TTS with auto-mode selection and voice directives
- **Speech-to-Text** -- OpenAI Whisper, Groq, Deepgram with fallback chains
- **Image Generation** -- FAL and OpenAI DALL-E with rate limiting
- **Document Extraction** -- PDF, CSV, and general file text extraction with FFmpeg support for audio metadata

### Tool Policy

5 named tool filtering profiles with per-agent allow/deny lists and progressive disclosure -- lean tool definitions are always present, detailed usage guides inject on first use.

## Part of Comis

This package is part of the [Comis](https://github.com/comisai/comis) monorepo -- a security-first AI agent platform connecting agents to Discord, Telegram, Slack, WhatsApp, and more.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
