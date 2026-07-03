// threat-hunting simulator — the off-hours-admin-pivot scenario.
// The agent must learn to (a) trust BEHAVIOR over the rotating IOCs, (b) check the
// baseline before flagging an anomaly (the Tuesday backup + the WS-07 VPN decoy are
// benign), and (c) find the off-hours admin pivot to the file server. None of that
// is in the SKILL.md — it is the learned strategy.

import { matches } from "../shared/world.mjs";

export function setup({ seedWorld, variant }) {
  const v = (seedWorld.variants && seedWorld.variants[variant]) || seedWorld.variants.A;
  const t = seedWorld.truth;
  // Telemetry derived from the truth + the (rotating) variant IOCs. The real pivot
  // uses legitimate tooling and carries NO ioc — only the decoy does.
  const telemetry = [
    { ts: "Mon 13:02", host: t.compromisedHost, account: t.compromisedAccount, action: "lsass access (credential theft)", indicator: v.iocs.hash },
    { ts: "Mon 13:40", host: t.compromisedHost, account: t.compromisedAccount, action: "outbound C2 beacon", indicator: v.iocs.ip },
    { ts: "Tue 01:00", host: "FS-01", account: "svc-backup", action: "scheduled backup write", indicator: null },
    { ts: "Wed 11:20", host: "WS-07", account: "j.rivera", action: "outbound update check (new VPN client)", indicator: v.iocs.domain },
    { ts: "Sat 02:14", host: t.pivotHost, account: t.compromisedAccount, action: "remote admin exec from WS-21 → FS-01 (legit admin tooling)", indicator: null },
    { ts: "Sat 02:31", host: t.pivotHost, account: t.compromisedAccount, action: "bulk read of finance share", indicator: null },
  ];
  const alerts = [
    { id: "AL-1", title: `WS-07 outbound to newly-registered domain ${v.iocs.domain}`, severity: "medium", note: "auto-raised on domain age" },
    { id: "AL-2", title: `Known-bad IP ${v.iocs.ip} contacted by WS-21`, severity: "high" },
    { id: "AL-3", title: "Off-hours admin logon to FS-01 (Sat 02:14)", severity: "high" },
  ];
  return { ...seedWorld, iocs: v.iocs, telemetry, alerts };
}

const getCase = (ctx, id) => ctx.cases.get(id || ctx.lastCase);

export const handlers = {
  list_open_alerts(_args, ctx) {
    return { alerts: ctx.world.alerts };
  },
  query_telemetry(args, ctx) {
    const f = args.filter || "";
    const events = ctx.world.telemetry.filter(
      (e) => matches(e.host, f) || matches(e.account, f) || matches(e.action, f) || matches(e.indicator || "", f)
    );
    return { count: events.length, events };
  },
  lookup_host(args, ctx) {
    const h = ctx.world.hosts.find((x) => x.id.toLowerCase() === String(args.host).toLowerCase());
    return h || { host: args.host, unknown: true };
  },
  lookup_account(args, ctx) {
    const a = ctx.world.accounts.find((x) => x.id.toLowerCase() === String(args.account).toLowerCase());
    return a || { account: args.account, unknown: true };
  },
  check_ioc(args, ctx) {
    const ind = String(args.indicator || "");
    const v = ctx.world.iocs;
    const known = ind === v.hash || ind === v.ip || ind === v.domain;
    // Reputation is real-but-volatile, and explicitly NOT authoritative: the decoy
    // domain looks bad but is the benign VPN client.
    return {
      indicator: ind,
      reputation: known ? "flagged (volatile, rotates often)" : "unknown",
      authoritative: false,
      note: "IOC reputation rotates between campaigns; corroborate with behavior before acting.",
    };
  },
  get_baseline(args, ctx) {
    const e = String(args.entity || "").toLowerCase();
    const hits = ctx.world.baseline.filter((b) => b.entity.toLowerCase() === e);
    return { entity: args.entity, baseline: hits.length ? hits : "no established baseline on record" };
  },
  timeline(args, ctx) {
    const e = String(args.entity || "").toLowerCase();
    const events = ctx.world.telemetry.filter(
      (ev) => ev.host.toLowerCase() === e || ev.account.toLowerCase() === e
    );
    return { entity: args.entity, events };
  },
  open_investigation(args, ctx) {
    const id = `C-${++ctx.caseCounter}`;
    ctx.cases.set(id, { findings: [], containments: [], escalations: [], summary: args.summary || "" });
    ctx.lastCase = id;
    return { case: id, opened: true };
  },
  raise_finding(args, ctx) {
    const c = getCase(ctx, args.case);
    if (!c) return { error: "no open case — call open_investigation first" };
    const finding = { entity: args.entity, ttp: args.ttp, confidence: args.confidence ?? null };
    c.findings.push(finding);
    return { recorded: finding, caseFindings: c.findings.length };
  },
  contain_host(args, ctx) {
    const c = getCase(ctx, args.case);
    if (!c) return { error: "no open case — call open_investigation first" };
    const host = String(args.host);
    c.containments.push(host);
    const benign = ctx.world.truth.benignHosts.includes(host);
    return {
      contained: host,
      businessImpact: benign ? "HIGH — this host appears benign; isolating it disrupts a real user" : "expected for a hostile host",
    };
  },
  escalate(args, ctx) {
    const c = getCase(ctx, args.case);
    if (!c) return { error: "no open case" };
    c.escalations.push(args.tier);
    return { escalated: args.tier };
  },
  close_case(args, ctx) {
    const c = getCase(ctx, args.case);
    if (!c) return ctx.grade("failure", { score: 0, rationale: "closed with no open case" });
    const T = ctx.world.truth;

    // Accept the BEHAVIORAL identification of the off-hours lateral pivot — not a single
    // literal token. A correct analyst may phrase it as MITRE codes (T1021 lateral
    // movement) or prose ("off-hours admin pivot", "lateral movement to the file server").
    // The other gates (right entity + contained-real + not-benign) prevent false positives,
    // so a permissive behavioral match here is safe and fair. Without it, a MITRE-coded
    // finding would score `failure` for word choice alone.
    const namedTtp = c.findings.some((f) => /pivot|lateral|t1021|off.?hours/i.test(String(f.ttp || "")) || String(f.ttp || "").toLowerCase() === T.ttp);
    const namedActor = c.findings.some((f) =>
      [T.compromisedAccount, T.compromisedHost, T.pivotHost].includes(String(f.entity))
    );
    const containedReal = c.containments.includes(T.compromisedHost) || c.containments.includes(T.pivotHost);
    const containedBenign = c.containments.some((h) => T.benignHosts.includes(h));

    const correct = namedTtp && namedActor && containedReal && !containedBenign;
    const reasons = [];
    if (!namedTtp) reasons.push("did not identify the off-hours-admin-pivot TTP");
    if (!namedActor) reasons.push("finding did not name the compromised account/host or the pivot target");
    if (!containedReal) reasons.push("did not contain the compromised/pivot host");
    if (containedBenign) reasons.push("contained a benign host (false positive with business impact)");

    return ctx.grade(correct ? "success" : "failure", {
      score: correct ? 1 : 0,
      rationale: correct
        ? "Identified the off-hours admin pivot by behavior and contained the right host without false positives."
        : `Incorrect: ${reasons.join("; ")}.`,
      findings: c.findings,
      containments: c.containments,
    });
  },
};

// Golden path → success; IOC-only naive path → failure. Proves the success signal is
// reachable and that the shortcut the engine must learn to avoid actually fails.
export function selftest({ call }) {
  const c = call("open_investigation", { summary: "triage off-hours FS-01 logon" }).case;
  call("raise_finding", { case: c, entity: "a.chen", ttp: "off-hours-admin-pivot", confidence: 0.9 });
  call("contain_host", { case: c, host: "FS-01", reason: "active pivot target" });
  const good = call("close_case", { case: c, verdict: "confirmed off-hours admin pivot via a.chen" });

  // Regression guard: a MITRE/behavioral finding (NO literal "pivot" word) must ALSO grade success.
  const c3 = call("open_investigation", { summary: "off-hours FS-01 access" }).case;
  call("raise_finding", { case: c3, entity: "FS-01", ttp: "T1021 lateral movement (WS-21->FS-01, off-hours); T1005 collection", confidence: 0.9 });
  call("contain_host", { case: c3, host: "WS-21", reason: "compromised admin host" });
  const behavioral = call("close_case", { case: c3, verdict: "lateral movement off-hours" });

  // Naive analyst: chases the rotating IOC alert, contains the benign VPN host WS-07.
  const c2 = call("open_investigation", { summary: "chase the IOC alert" }).case;
  call("raise_finding", { case: c2, entity: "WS-07", ttp: "c2-beacon", confidence: 0.8 });
  call("contain_host", { case: c2, host: "WS-07", reason: "newly-registered domain" });
  const bad = call("close_case", { case: c2, verdict: "malware on WS-07" });

  const pass = good.outcome === "success" && behavioral.outcome === "success" && bad.outcome === "failure";
  return { pass, golden: good.outcome, behavioral: behavioral.outcome, naive: bad.outcome, detail: pass ? "ok" : { good, behavioral, bad } };
}
