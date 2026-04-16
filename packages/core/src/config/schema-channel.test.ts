import { describe, it, expect } from "vitest";
import {
  ChannelEntrySchema,
  ChannelConfigSchema,
  SignalChannelEntrySchema,
  IMessageChannelEntrySchema,
  LineChannelEntrySchema,
  IrcChannelEntrySchema,
  EmailChannelEntrySchema,
} from "./schema-channel.js";

describe("ChannelEntrySchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = ChannelEntrySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.allowFrom).toEqual([]);
    }
  });

  it("validates Telegram config (enabled + botToken)", () => {
    const result = ChannelEntrySchema.safeParse({
      enabled: true,
      botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.botToken).toBe("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11");
    }
  });

  it("validates Slack Socket Mode config", () => {
    const result = ChannelEntrySchema.safeParse({
      enabled: true,
      botToken: "xoxb-123-456-abc",
      appToken: "xapp-1-A0B1C2D3E4-123456789-abcdef",
      mode: "socket",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.appToken).toBe("xapp-1-A0B1C2D3E4-123456789-abcdef");
      expect(result.data.mode).toBe("socket");
    }
  });

  it("validates Slack HTTP Mode config", () => {
    const result = ChannelEntrySchema.safeParse({
      enabled: true,
      botToken: "xoxb-123-456-abc",
      signingSecret: "abc123def456",
      mode: "http",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.signingSecret).toBe("abc123def456");
      expect(result.data.mode).toBe("http");
    }
  });

  it("validates WhatsApp config", () => {
    const result = ChannelEntrySchema.safeParse({
      enabled: true,
      authDir: "./wa-auth",
      printQR: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.authDir).toBe("./wa-auth");
      expect(result.data.printQR).toBe(false);
    }
  });

  it("validates Discord config (just enabled + botToken) without new fields", () => {
    const result = ChannelEntrySchema.safeParse({
      enabled: true,
      botToken: "MTA...abc.xyz",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // New fields should be undefined (not required)
      expect(result.data.appToken).toBeUndefined();
      expect(result.data.signingSecret).toBeUndefined();
      expect(result.data.mode).toBeUndefined();
      expect(result.data.authDir).toBeUndefined();
      expect(result.data.printQR).toBeUndefined();
    }
  });

  it("rejects invalid mode value", () => {
    const result = ChannelEntrySchema.safeParse({
      enabled: true,
      botToken: "xoxb-test",
      mode: "websocket",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields (.strict())", () => {
    const result = ChannelEntrySchema.safeParse({
      enabled: true,
      botToken: "test",
      unknownField: "should-fail",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SecretRef union validation
// ---------------------------------------------------------------------------

describe("ChannelEntrySchema — SecretRef union", () => {
  it("accepts a SecretRef object for botToken", () => {
    const result = ChannelEntrySchema.safeParse({
      enabled: true,
      botToken: { source: "env", provider: "telegram", id: "TELEGRAM_BOT_TOKEN" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.botToken).toEqual({
        source: "env",
        provider: "telegram",
        id: "TELEGRAM_BOT_TOKEN",
      });
    }
  });

  it("still accepts a plain string for botToken (backward compat)", () => {
    const result = ChannelEntrySchema.safeParse({
      enabled: true,
      botToken: "plaintext-token",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.botToken).toBe("plaintext-token");
    }
  });

  it("rejects an invalid SecretRef source", () => {
    const result = ChannelEntrySchema.safeParse({
      enabled: true,
      botToken: { source: "invalid", provider: "x", id: "y" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a SecretRef for apiKey with file source", () => {
    const result = ChannelEntrySchema.safeParse({
      enabled: true,
      apiKey: { source: "file", provider: "vault", id: "/secrets/api.key" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.apiKey).toEqual({
        source: "file",
        provider: "vault",
        id: "/secrets/api.key",
      });
    }
  });

  it("accepts a SecretRef for appToken", () => {
    const result = ChannelEntrySchema.safeParse({
      enabled: true,
      appToken: { source: "exec", provider: "op", id: "slack-app-token" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a SecretRef for signingSecret", () => {
    const result = ChannelEntrySchema.safeParse({
      enabled: true,
      signingSecret: { source: "env", provider: "slack", id: "SLACK_SIGNING_SECRET" },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Platform-specific entry schemas
// ---------------------------------------------------------------------------

describe("SignalChannelEntrySchema", () => {
  it("parses with defaults", () => {
    const result = SignalChannelEntrySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.baseUrl).toBe("http://127.0.0.1:8080");
    }
  });

  it("parses with platform-specific fields", () => {
    const result = SignalChannelEntrySchema.safeParse({
      enabled: true,
      baseUrl: "http://signal.local:9090",
      account: "+1234567890",
      cliPath: "/usr/local/bin/signal-cli",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.baseUrl).toBe("http://signal.local:9090");
      expect(result.data.account).toBe("+1234567890");
      expect(result.data.cliPath).toBe("/usr/local/bin/signal-cli");
    }
  });
});

describe("IMessageChannelEntrySchema", () => {
  it("parses with defaults", () => {
    const result = IMessageChannelEntrySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });

  it("parses with platform-specific fields", () => {
    const result = IMessageChannelEntrySchema.safeParse({
      enabled: true,
      binaryPath: "/usr/local/bin/imsg",
      account: "user@icloud.com",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.binaryPath).toBe("/usr/local/bin/imsg");
      expect(result.data.account).toBe("user@icloud.com");
    }
  });
});

describe("LineChannelEntrySchema", () => {
  it("parses with defaults", () => {
    const result = LineChannelEntrySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.webhookPath).toBe("/webhooks/line");
    }
  });

  it("parses with platform-specific fields", () => {
    const result = LineChannelEntrySchema.safeParse({
      enabled: true,
      apiKey: "line-channel-access-token",
      channelSecret: "line-secret-abc",
      webhookPath: "/hooks/line",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.apiKey).toBe("line-channel-access-token");
      expect(result.data.channelSecret).toBe("line-secret-abc");
      expect(result.data.webhookPath).toBe("/hooks/line");
    }
  });
});

describe("IrcChannelEntrySchema", () => {
  it("parses with defaults", () => {
    const result = IrcChannelEntrySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.tls).toBe(true);
    }
  });

  it("parses with platform-specific fields", () => {
    const result = IrcChannelEntrySchema.safeParse({
      enabled: true,
      host: "irc.libera.chat",
      port: 6697,
      nick: "comis-bot",
      tls: true,
      channels: ["#comis", "#bots"],
      nickservPassword: "secret123",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.host).toBe("irc.libera.chat");
      expect(result.data.port).toBe(6697);
      expect(result.data.nick).toBe("comis-bot");
      expect(result.data.tls).toBe(true);
      expect(result.data.channels).toEqual(["#comis", "#bots"]);
      expect(result.data.nickservPassword).toBe("secret123");
    }
  });

  it("rejects non-integer port", () => {
    const result = IrcChannelEntrySchema.safeParse({
      port: 6697.5,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Email channel entry schema
// ---------------------------------------------------------------------------

describe("EmailChannelEntrySchema", () => {
  it("parses minimal config with defaults", () => {
    const result = EmailChannelEntrySchema.safeParse({ enabled: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imapPort).toBe(993);
      expect(result.data.smtpPort).toBe(587);
      expect(result.data.secure).toBe(true);
      expect(result.data.authType).toBe("password");
      expect(result.data.allowMode).toBe("allowlist");
      expect(result.data.pollingIntervalMs).toBe(60_000);
    }
  });

  it("parses full config with IMAP/SMTP/OAuth2 fields", () => {
    const result = EmailChannelEntrySchema.safeParse({
      enabled: true,
      imapHost: "imap.gmail.com",
      smtpHost: "smtp.gmail.com",
      address: "bot@example.com",
      authType: "oauth2",
      clientId: "client-id-123",
      clientSecret: "client-secret-456",
      refreshToken: "refresh-token-789",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imapHost).toBe("imap.gmail.com");
      expect(result.data.smtpHost).toBe("smtp.gmail.com");
      expect(result.data.address).toBe("bot@example.com");
      expect(result.data.authType).toBe("oauth2");
      expect(result.data.clientId).toBe("client-id-123");
    }
  });

  it("rejects invalid email address", () => {
    const result = EmailChannelEntrySchema.safeParse({
      enabled: true,
      address: "not-an-email",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Top-level channel config
// ---------------------------------------------------------------------------

describe("ChannelConfigSchema", () => {
  it("validates full config with all 8 channels", () => {
    const result = ChannelConfigSchema.safeParse({
      telegram: { enabled: true, botToken: "tg-token" },
      discord: { enabled: true, botToken: "discord-token" },
      slack: {
        enabled: true,
        botToken: "xoxb-slack",
        appToken: "xapp-slack",
        mode: "socket",
      },
      whatsapp: {
        enabled: true,
        authDir: "/var/wa-auth",
        printQR: true,
      },
      signal: {
        enabled: true,
        baseUrl: "http://signal:8080",
        account: "+1234567890",
      },
      imessage: {
        enabled: true,
        binaryPath: "/usr/local/bin/imsg",
      },
      line: {
        enabled: true,
        apiKey: "line-token",
        channelSecret: "line-secret",
      },
      irc: {
        enabled: true,
        host: "irc.libera.chat",
        port: 6697,
        nick: "comis",
        channels: ["#comis"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.telegram.enabled).toBe(true);
      expect(result.data.discord.enabled).toBe(true);
      expect(result.data.slack.mode).toBe("socket");
      expect(result.data.whatsapp.printQR).toBe(true);
      expect(result.data.signal.baseUrl).toBe("http://signal:8080");
      expect(result.data.imessage.binaryPath).toBe("/usr/local/bin/imsg");
      expect(result.data.line.channelSecret).toBe("line-secret");
      expect(result.data.irc.nick).toBe("comis");
    }
  });

  it("produces valid defaults from empty object", () => {
    const result = ChannelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.telegram.enabled).toBe(false);
      expect(result.data.discord.enabled).toBe(false);
      expect(result.data.slack.enabled).toBe(false);
      expect(result.data.whatsapp.enabled).toBe(false);
      expect(result.data.signal.enabled).toBe(false);
      expect(result.data.imessage.enabled).toBe(false);
      expect(result.data.line.enabled).toBe(false);
      expect(result.data.irc.enabled).toBe(false);
      expect(result.data.email.enabled).toBe(false);
    }
  });

  it("defaults platform-specific fields for new channels", () => {
    const result = ChannelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.signal.baseUrl).toBe("http://127.0.0.1:8080");
      expect(result.data.line.webhookPath).toBe("/webhooks/line");
      expect(result.data.irc.tls).toBe(true);
    }
  });
});
