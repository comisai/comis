// package-delivery simulator — the Hindsight exemplar. The agent delivers a package
// in an office building it does not know. Cold, it must wander (look + check_office)
// or read the lobby directory to find the recipient, then navigate there. The
// building layout, who sits where, and the efficient route are the HIDDEN truth the
// reflection engine must LEARN — none of it is in the SKILL.md. A learned agent goes
// straight there in ~par moves; a careless one delivers to the wrong place.

export function setup({ seedWorld, variant }) {
  const v = (seedWorld.variants && seedWorld.variants[variant]) || seedWorld.variants.A;
  // Merge the variant's nameplates onto the shared building graph.
  const nodes = {};
  for (const [id, n] of Object.entries(seedWorld.building.nodes)) {
    nodes[id] = { ...n, nameplate: v.nameplates[id] || null };
  }
  return {
    start: seedWorld.building.start,
    nodes,
    directory: v.directory,
    recipient: v.recipient,
    recipientOffice: v.directory[v.recipient],
    par: v.par,
  };
}

function getTrip(ctx) {
  if (ctx.lastTrip && ctx.cases.has(ctx.lastTrip)) return ctx.cases.get(ctx.lastTrip);
  // auto-init a trip so stray observe calls work before accept_package
  const id = `T-${++ctx.caseCounter}`;
  const trip = { id, recipient: null, recipientOffice: null, location: ctx.world.start, moves: 0, log: [] };
  ctx.cases.set(id, trip);
  ctx.lastTrip = id;
  return trip;
}

const node = (ctx, id) => ctx.world.nodes[id];

export const handlers = {
  whereami(_args, ctx) {
    const t = getTrip(ctx);
    const n = node(ctx, t.location);
    return { location: t.location, floor: n.floor, movesUsed: t.moves, carrying: t.recipient || "(nothing yet)" };
  },

  look(_args, ctx) {
    const t = getTrip(ctx);
    const n = node(ctx, t.location);
    return {
      location: t.location,
      floor: n.floor,
      type: n.type,
      description: n.description || (n.type === "office" ? "an office door with a nameplate" : n.type === "elevator" ? "an elevator landing" : "a hallway"),
      here: n.type === "office" ? "an office (use check_office to read the nameplate)" : n.type === "lobby" ? "the lobby — there is a building directory desk here" : n.type,
      exits: n.exits,
    };
  },

  read_directory(_args, ctx) {
    const t = getTrip(ctx);
    const n = node(ctx, t.location);
    if (n.type !== "lobby") {
      return { available: false, hint: "There is no directory here. The building directory desk is in the lobby." };
    }
    return { available: true, directory: ctx.world.directory };
  },

  check_office(_args, ctx) {
    const t = getTrip(ctx);
    const n = node(ctx, t.location);
    if (n.type !== "office") return { atOffice: false, hint: "You are not standing at an office door." };
    return { atOffice: true, location: t.location, nameplate: n.nameplate };
  },

  accept_package(args, ctx) {
    const recipient = String(args.recipient || "").trim();
    const id = `T-${++ctx.caseCounter}`;
    const trip = {
      id,
      recipient,
      recipientOffice: ctx.world.directory[recipient] || null,
      location: ctx.world.start,
      moves: 0,
      log: [`accepted package for ${recipient}`],
    };
    ctx.cases.set(id, trip);
    ctx.lastTrip = id;
    return { trip: id, recipient, startedAt: trip.location, note: "Find the recipient and deliver. The lobby has a directory; offices have nameplates." };
  },

  move(args, ctx) {
    const t = getTrip(ctx);
    const n = node(ctx, t.location);
    const to = String(args.to || "");
    if (!n.exits.includes(to)) {
      return { moved: false, from: t.location, error: `No direct path from ${t.location} to ${to}.`, exits: n.exits };
    }
    t.location = to;
    t.moves += 1;
    t.log.push(`move → ${to}`);
    const dest = node(ctx, to);
    return { moved: true, location: to, floor: dest.floor, movesUsed: t.moves, exits: dest.exits };
  },

  take_elevator(args, ctx) {
    const t = getTrip(ctx);
    const n = node(ctx, t.location);
    if (n.type !== "elevator") {
      return { moved: false, error: "You can only take the elevator from an elevator landing.", location: t.location };
    }
    const floor = Number(args.floor);
    const target = `elevator-${floor}`;
    if (!node(ctx, target)) {
      return { moved: false, error: `No elevator landing on floor ${floor}.`, location: t.location };
    }
    t.location = target;
    t.moves += 1;
    t.log.push(`elevator → floor ${floor}`);
    const dest = node(ctx, target);
    return { moved: true, location: target, floor, movesUsed: t.moves, exits: dest.exits };
  },

  deliver(args, ctx) {
    const t = getTrip(ctx);
    const recipient = String(args.recipient || t.recipient || "");
    if (!recipient) return ctx.grade("failure", { score: 0, rationale: "No recipient — accept_package first." });
    const office = ctx.world.directory[recipient];
    if (!office) return ctx.grade("failure", { score: 0, rationale: `Unknown recipient "${recipient}" — not in this building.` });

    if (t.location !== office) {
      return ctx.grade("failure", {
        score: 0,
        rationale: `You are at ${t.location}, not at ${recipient}'s office. Find the right office before delivering.`,
        movesUsed: t.moves,
      });
    }
    const par = ctx.world.par;
    const efficient = t.moves <= Math.ceil(par * 1.5);
    const score = Math.max(0, Math.min(1, 1 - Math.max(0, t.moves - par) / (par * 2)));
    return ctx.grade("success", {
      score,
      rationale: `Delivered to ${recipient} at ${office} in ${t.moves} moves (par ${par})${efficient ? "" : " — got there, but the route was inefficient"}.`,
      movesUsed: t.moves,
      par,
      efficient,
      route: t.log,
    });
  },
};

// Golden: read the lobby directory → route straight to the office → deliver in par moves → success.
// Naive: skip the directory, deliver from the wrong place → failure (the shortcut the engine must learn past).
export function selftest({ call, ctx }) {
  const recipient = ctx.world.recipient;
  // golden path
  call("accept_package", { recipient });
  const dir = call("read_directory", {}); // at lobby
  const office = dir.directory[recipient]; // e.g. "3-01"
  const floor = Number(office.split("-")[0]);
  call("move", { to: "elevator-1" });
  call("take_elevator", { floor });
  call("move", { to: `hall-${floor}` });
  call("move", { to: office });
  const good = call("deliver", { recipient });

  // naive path: accept, then try to deliver from the lobby without navigating
  call("accept_package", { recipient });
  const bad = call("deliver", { recipient });

  const pass = good.outcome === "success" && bad.outcome === "failure";
  return {
    pass,
    golden: good.outcome,
    naive: bad.outcome,
    detail: pass ? `delivered in ${good.movesUsed} moves (par ${good.par}), efficient=${good.efficient}` : { good, bad },
  };
}
