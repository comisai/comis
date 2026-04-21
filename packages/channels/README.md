# @comis/channels

Chat platform adapters for the [Comis](https://github.com/comisai/comis) platform. Connects agents to 9 messaging platforms with unified message handling.

## Supported Platforms

| Platform | SDK | Features |
|----------|-----|----------|
| **Telegram** | [Grammy](https://grammy.dev/) | Text, voice, images, files, polls, reactions, threads, inline keyboards |
| **Discord** | [discord.js](https://discord.js.org/) | Text, voice, images, files, polls, reactions, threads, slash commands |
| **Slack** | [@slack/bolt](https://slack.dev/bolt-js/) | Text, images, files, reactions, threads, socket mode + HTTP mode |
| **WhatsApp** | [Baileys](https://github.com/WhiskeySockets/Baileys) | Text, voice, images, files, polls, reactions |
| **Signal** | [signal-cli](https://github.com/AsamK/signal-cli) | Text, voice, images, files, reactions |
| **LINE** | [@line/bot-sdk](https://github.com/line/line-bot-sdk-nodejs) | Text, images, files, rich menus, flex messages |
| **iMessage** | AppleScript bridge | Text, images, files |
| **IRC** | [irc-framework](https://github.com/kiwiirc/irc-framework) | Text, actions |
| **Email** | [imapflow](https://github.com/postalsys/imapflow) + [nodemailer](https://nodemailer.com/) | Full email with threading, attachments, HTML |
| **Echo** | Mock adapter | Testing and development |

## What's Inside

### Message Normalization

Each adapter converts platform-specific messages to a unified `NormalizedMessage` format. Text, attachments, polls, reactions, threads, and reply context are normalized across all platforms.

### Media Resolution

Platform-specific resolvers download and validate attachments with pre-download size checks and MIME type detection.

### Delivery Pipeline

Outbound message delivery with chunking (platform-specific size limits), rate limiting, retry logic with exponential backoff, permanent error classification, and stall detection.

### Plugin System

Composable `createXxxPlugin()` factories enable runtime channel registration. Each plugin wires its adapter, resolver, and message mapper into the channel registry.

### Cross-Platform Features

- **Typing indicators** -- Platform-specific lifecycle management
- **Health monitoring** -- Channel status tracking with stall detection
- **Auto-reply engine** -- Configurable auto-reply rules
- **Voice response pipeline** -- TTS delivery across voice-capable platforms
- **Template engine** -- Cross-platform message formatting

## Part of Comis

This package is part of the [Comis](https://github.com/comisai/comis) monorepo -- a security-first AI agent platform connecting agents to Discord, Telegram, Slack, WhatsApp, and more.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
