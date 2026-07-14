# @comis/skills

Skill system, MCP integration, built-in tools, and media processing for [Comis](https://github.com/comisai/comis) agents.

## What's Inside

### Skill Registry

Modular prompt packages give agents specialized knowledge and workflows. Skills are loaded from Markdown files with runtime eligibility filtering, dynamic context injection, and file watching for live reload. Content scanning checks skill definitions for prompt-injection patterns.

### MCP Client

Outbound [Model Context Protocol](https://modelcontextprotocol.io/) client support for stdio, SSE, and Streamable HTTP servers, with connection management, tool/resource/prompt translation, filtering, OAuth, and credential injection. Comis' inbound MCP server endpoint is implemented by `@comis/gateway` and wired by `@comis/daemon`.

### Built-in Tools

| Category | Tools |
|----------|-------|
| **Web** | Web search, web fetch |
| **Files** | Read, write, patch, state tracking |
| **Execution** | Shell execution and process management with configurable host isolation |
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

Named tool-filtering profiles combine per-agent allow/deny lists with progressive disclosure: compact tool definitions remain available while detailed usage guides are injected on demand.

## Part of Comis

This package is part of [Comis](https://github.com/comisai/comis), an open-source, security-first platform for AI agent teams.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
