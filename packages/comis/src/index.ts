// comisai - Umbrella package for the Comis platform
// Re-exports all sub-packages as namespaces

import * as shared from "@comis/shared";
import * as core from "@comis/core";
import * as infra from "@comis/infra";
import * as memory from "@comis/memory";
import * as gateway from "@comis/gateway";
import * as skills from "@comis/skills";
import * as scheduler from "@comis/scheduler";
import * as agent from "@comis/agent";
import * as channels from "@comis/channels";
import * as cli from "@comis/cli";
import * as daemon from "@comis/daemon";

export {
  shared,
  core,
  infra,
  memory,
  gateway,
  skills,
  scheduler,
  agent,
  channels,
  cli,
  daemon,
};
