// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import type { ActionClassification } from "./action-classifier.js";
import {
  classifyAction,
  requiresConfirmation,
  registerAction,
  lockRegistry,
  isRegistryLocked,
  _resetRegistryForTesting,
} from "./action-classifier.js";

describe("classifyAction", () => {
  describe("read actions", () => {
    const readActions = [
      "file.read",
      "memory.search",
      "memory.get",
      "config.read",
      "status.check",
      "skill.list",
    ];

    for (const action of readActions) {
      it(`classifies "${action}" as read`, () => {
        expect(classifyAction(action)).toBe("read");
      });
    }
  });

  describe("mutate actions", () => {
    const mutateActions = [
      "file.write",
      "file.create",
      "memory.store",
      "memory.update",
      "config.update",
      "message.send",
    ];

    for (const action of mutateActions) {
      it(`classifies "${action}" as mutate`, () => {
        expect(classifyAction(action)).toBe("mutate");
      });
    }
  });

  describe("destructive actions", () => {
    const destructiveActions = [
      "file.delete",
      "memory.delete",
      "memory.clear",
      "session.destroy",
      "system.exec",
      "system.shutdown",
    ];

    for (const action of destructiveActions) {
      it(`classifies "${action}" as destructive`, () => {
        expect(classifyAction(action)).toBe("destructive");
      });
    }
  });

  describe("v2.0 tool read actions", () => {
    const v2ReadActions = [
      "tool.execute",
      "cron.list",
      "cron.status",
      "cron.runs",
      "cron.wake",
      "session.list",
      "session.history",
      "session.status",
      "message.fetch",
      "agents.list",
      "gateway.status",
      "config.schema",
      "web.fetch",
      "web.search",
      "image.analyze",
      "memory.search_files",
      "memory.get_file",
    ];

    for (const action of v2ReadActions) {
      it(`classifies "${action}" as read`, () => {
        expect(classifyAction(action)).toBe("read");
      });
    }
  });

  describe("v2.0 tool mutate actions", () => {
    const v2MutateActions = [
      "message.reply",
      "message.react",
      "message.edit",
      "cron.add",
      "cron.update",
      "session.send",
      "session.spawn",
      "tts.synthesize",
      "canvas.present",
      "canvas.eval",
    ];

    for (const action of v2MutateActions) {
      it(`classifies "${action}" as mutate`, () => {
        expect(classifyAction(action)).toBe("mutate");
      });
    }
  });

  describe("v2.0 tool destructive actions", () => {
    const v2DestructiveActions = [
      "cron.remove",
      "message.delete",
      "gateway.restart",
      "gateway.update",
      "config.patch",
      "config.apply",
    ];

    it('classifies "config.patch" as destructive', () => {
      expect(classifyAction("config.patch")).toBe("destructive");
    });

    it('classifies "config.apply" as destructive', () => {
      expect(classifyAction("config.apply")).toBe("destructive");
    });

    for (const action of v2DestructiveActions) {
      it(`classifies "${action}" as destructive`, () => {
        expect(classifyAction(action)).toBe("destructive");
      });
    }
  });

  describe("v23.0 config management actions", () => {
    it('classifies "config.history" as read', () => {
      expect(classifyAction("config.history")).toBe("read");
    });

    it('classifies "config.diff" as read', () => {
      expect(classifyAction("config.diff")).toBe("read");
    });

    it('classifies "config.rollback" as destructive', () => {
      expect(classifyAction("config.rollback")).toBe("destructive");
    });

    it('classifies "config.apply" as destructive', () => {
      expect(classifyAction("config.apply")).toBe("destructive");
    });

    it('classifies "config.gc" as destructive', () => {
      expect(classifyAction("config.gc")).toBe("destructive");
    });

    it('classifies "daemon.setLogLevel" as mutate (in-memory only, resets on restart)', () => {
      expect(classifyAction("daemon.setLogLevel")).toBe("mutate");
    });
  });

  describe("v6.5 prompt skill actions", () => {
    it('classifies "skill.prompt.load" as read', () => {
      expect(classifyAction("skill.prompt.load")).toBe("read");
    });

    it('classifies "skill.prompt.invoke" as mutate', () => {
      expect(classifyAction("skill.prompt.invoke")).toBe("mutate");
    });
  });

  describe("v22.0 privileged tool actions", () => {
    describe("read actions", () => {
      const readActions = [
        "agents.get",
        "session.export",
        "memory.stats",
        "memory.browse",
        "memory.export",
        "channels.list",
        "channels.get",
        "tokens.list",
        "models.list",
        "models.test",
      ];
      for (const action of readActions) {
        it(`classifies "${action}" as read`, () => {
          expect(classifyAction(action)).toBe("read");
        });
      }
    });

    describe("mutate actions", () => {
      const mutateActions = ["agents.update", "agents.resume"];
      for (const action of mutateActions) {
        it(`classifies "${action}" as mutate`, () => {
          expect(classifyAction(action)).toBe("mutate");
        });
      }
    });

    describe("destructive actions", () => {
      const destructiveActions = [
        "agents.create",
        "agents.delete",
        "agents.suspend",
        "session.delete",
        "memory.flush",
        "channels.enable",
        "channels.disable",
        "channels.restart",
        "tokens.create",
        "tokens.revoke",
        "tokens.rotate",
      ];
      for (const action of destructiveActions) {
        it(`classifies "${action}" as destructive`, () => {
          expect(classifyAction(action)).toBe("destructive");
        });
      }
    });
  });

  describe("unknown actions", () => {
    it("defaults unknown action to destructive (fail-closed)", () => {
      expect(classifyAction("totally.unknown.action")).toBe("destructive");
    });

    it("defaults empty string to destructive", () => {
      expect(classifyAction("")).toBe("destructive");
    });

    it("defaults novel action to destructive", () => {
      expect(classifyAction("custom.plugin.run")).toBe("destructive");
    });
  });
});

describe("requiresConfirmation", () => {
  it("returns true for destructive actions", () => {
    expect(requiresConfirmation("file.delete")).toBe(true);
    expect(requiresConfirmation("system.exec")).toBe(true);
  });

  it("returns true for unknown actions (fail-closed)", () => {
    expect(requiresConfirmation("unknown.action")).toBe(true);
  });

  it("returns false for read actions", () => {
    expect(requiresConfirmation("file.read")).toBe(false);
    expect(requiresConfirmation("memory.search")).toBe(false);
  });

  it("returns false for mutate actions", () => {
    expect(requiresConfirmation("file.write")).toBe(false);
    expect(requiresConfirmation("message.send")).toBe(false);
  });

  it("requires confirmation for config.patch", () => {
    expect(requiresConfirmation("config.patch")).toBe(true);
  });
});

describe("requiresConfirmation - v23.0 daemon actions", () => {
  it("returns false for daemon.setLogLevel (mutate, not destructive)", () => {
    expect(requiresConfirmation("daemon.setLogLevel")).toBe(false);
  });

  it("returns true for config.rollback (destructive)", () => {
    expect(requiresConfirmation("config.rollback")).toBe(true);
  });

  it("returns true for config.gc (destructive)", () => {
    expect(requiresConfirmation("config.gc")).toBe(true);
  });
});

describe("requiresConfirmation - v22.0 privileged actions", () => {
  it("returns true for destructive privileged actions", () => {
    expect(requiresConfirmation("agents.create")).toBe(true);
    expect(requiresConfirmation("agents.delete")).toBe(true);
    expect(requiresConfirmation("tokens.revoke")).toBe(true);
    expect(requiresConfirmation("channels.restart")).toBe(true);
  });

  it("returns false for read privileged actions", () => {
    expect(requiresConfirmation("agents.get")).toBe(false);
    expect(requiresConfirmation("models.list")).toBe(false);
    expect(requiresConfirmation("channels.list")).toBe(false);
  });
});

describe("registerAction", () => {
  it("registers a new action type", () => {
    registerAction("custom.read", "read");
    expect(classifyAction("custom.read")).toBe("read");
  });

  it("overwrites an existing registration", () => {
    registerAction("custom.overwrite", "destructive");
    expect(classifyAction("custom.overwrite")).toBe("destructive");

    registerAction("custom.overwrite", "read");
    expect(classifyAction("custom.overwrite")).toBe("read");
  });

  it("accepts all valid classifications", () => {
    const classifications: ActionClassification[] = ["read", "mutate", "destructive"];
    for (const classification of classifications) {
      registerAction(`test.${classification}`, classification);
      expect(classifyAction(`test.${classification}`)).toBe(classification);
    }
  });
});

describe("lockRegistry", () => {
  beforeEach(() => {
    _resetRegistryForTesting();
  });

  it("lockRegistry prevents subsequent registerAction calls", () => {
    lockRegistry();
    expect(() => registerAction("new.action", "read")).toThrow("locked");
  });

  it("isRegistryLocked returns true after locking", () => {
    expect(isRegistryLocked()).toBe(false);
    lockRegistry();
    expect(isRegistryLocked()).toBe(true);
  });

  it("classifyAction still works after locking", () => {
    lockRegistry();
    // Pre-registered actions should still work
    expect(classifyAction("file.read")).toBe("read");
    expect(classifyAction("file.write")).toBe("mutate");
    expect(classifyAction("file.delete")).toBe("destructive");
    // Unknown actions still default to destructive
    expect(classifyAction("totally.unknown")).toBe("destructive");
  });

  it("lockRegistry is idempotent", () => {
    lockRegistry();
    lockRegistry(); // second call should not throw
    expect(isRegistryLocked()).toBe(true);
  });

  it("registerAction error message includes the rejected action type", () => {
    lockRegistry();
    expect(() => registerAction("malicious.downgrade", "read")).toThrow(
      'registerAction() rejected for "malicious.downgrade"',
    );
  });
});
