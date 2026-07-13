// SPDX-License-Identifier: Apache-2.0
/**
 * Test-naming architecture gate.
 *
 * Walks every *.test.ts file in the repository and asserts every
 * `describe(...)` / `it(...)` / `test(...)` description satisfies three
 * predicates:
 *
 *   (1) BLOCKLIST — does NOT match the anchored exact-match blocklist
 *       /^(works|happy path|test \d+|sanity|smoke)$/i. Applies to ALL
 *       three kinds (describe, it, test).
 *
 *   (2) MIN-LENGTH — is at least 20 characters. Applies to `it(...)` /
 *       `test(...)` only — `describe(...)` is the subject-under-test
 *       label (commonly a single function or class name) per BDD idiom
 *       and is not the use-case description.
 *
 *   (3) USE-CASE SHAPE — passes a permissive heuristic that accepts any
 *       of: (a) BDD precondition prefix (when / given / on), (b) any
 *       English-verb token anywhere in the description (curated stem
 *       set), (c) "Subject: detail" colon-pattern (e.g. "session:
 *       expired after TTL"), (d) test-numbering prefix like "Test 2 —"
 *       or "g)". The heuristic is intentionally lenient — noun-phrase
 *       descriptions that describe observable behavior are allowed, and
 *       false positives must be avoided. Applies to `it(...)` /
 *       `test(...)` only.
 *
 * Source-text parsing: `extractDescriptions(source)` strips JSDoc and
 * line comments BEFORE running the description regex. Without this,
 * docstring examples like `every it("...")` description ...` would be
 * captured as fake test calls. Templated descriptions (`describe(\`...
 * ${expr}...\`, ...)`) are not flagged because we only walk
 * STRING-LITERAL form first arguments — dynamic identifiers and
 * template-expression literals are skipped intentionally.
 *
 * Inline allowlist (`testNamingAllowlist` imported from
 * `test/support/architecture-allowlist.ts`) carries the current-state
 * offenders. The shrink ratchet in `allowlist-shrink.test.ts` enforces
 * the list SHRINKS monotonically over time — adding entries requires
 * PR-review citing the reason. Drive the allowlist toward empty by
 * renaming legacy short descriptions OR extending VERB_FORMS / heuristic
 * regexes.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { testNamingAllowlist } from "../support/architecture-allowlist.js";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

// ---------------------------------------------------------------------------
// PREDICATE 1: anchored exact-match blocklist (applies to ALL kinds)
// ---------------------------------------------------------------------------
const BLOCKLIST_RE = /^(works|happy path|test \d+|sanity|smoke)$/i;

// ---------------------------------------------------------------------------
// PREDICATE 3: use-case shape heuristic (applies to it / test only)
// ---------------------------------------------------------------------------
const BDD_RE = /^(when|given|on)\b/i;

/**
 * Test-numbering prefix conventions in the codebase: "Test 2 — ...",
 * "g) ...", "10) ...", "1. ...", "23b) ...". The description is
 * accepted because the body after the prefix is the use case.
 */
const TEST_NUM_PREFIX_RE = /^(test\s+\d+|[a-z]\)|\d+\)|\d+\.|\d+[a-z]\))/i;

/**
 * "Subject: detail" colon-pattern — e.g., "session: expired correctly
 * after TTL", "minimal mode: omits reaction section", "per-channel-peer
 * mode: per-channel per-peer". The detail portion (after `: `) is the
 * observable behavior; the subject is the scenario name. Common in
 * this codebase. Subject is one OR multiple words (separated by
 * spaces/hyphens); requires non-space after the colon.
 */
const SUBJECT_COLON_RE = /^[A-Za-z][\w\s-]*:\s+\S/;

/**
 * Curated English-verb stem set with common inflections. Membership
 * test = "this description contains at least one recognizable verb".
 * False negatives (legitimate descriptions whose verb is missing from
 * the set) are unblocked by adding the missing form here; that change
 * is reviewable in the PR.
 *
 * The set is intentionally large (~1400 forms) to minimize false
 * positives — a hard-fail gate must NEVER flag a legitimate use-case
 * description. Adding a verb is a one-line PR; renaming many test
 * descriptions is not.
 */
const VERB_FORMS: ReadonlySet<string> = new Set([
  // be / have / do families:
  "is","are","was","were","be","been","being","am",
  "has","have","had",
  "do","does","did","done",
  // Modals:
  "will","would","can","could","may","might","must","shall","should",
  // Core action verbs (with common inflections — s, es, ed, ing):
  "return","returns","returned","returning",
  "reject","rejects","rejected","rejecting",
  "neutralize","neutralizes","neutralized","neutralizing",
  "apply","applies","applied","applying",
  "dispatch","dispatches","dispatched","dispatching",
  "propagate","propagates","propagated","propagating",
  "redact","redacts","redacted","redacting",
  "validate","validates","validated","validating",
  "create","creates","created","creating",
  "emit","emits","emitted","emitting",
  "surface","surfaces","surfaced","surfacing",
  "summarize","summarizes","summarized","summarizing",
  "decode","decodes","decoded","decoding",
  "preserve","preserves","preserved","preserving",
  "export","exports","exported","exporting",
  "process","processes","processed","processing",
  "route","routes","routed","routing",
  "fall","falls","fell","falling","fallen",
  "wrap","wraps","wrapped","wrapping",
  "prune","prunes","pruned","pruning",
  "normalize","normalizes","normalized","normalizing",
  "invoke","invokes","invoked","invoking",
  "clear","clears","cleared","clearing",
  "seed","seeds","seeded","seeding",
  "track","tracks","tracked","tracking",
  "initialize","initializes","initialized","initializing",
  "degrade","degrades","degraded","degrading",
  "merge","merges","merged","merging",
  "produce","produces","produced","producing",
  "deduplicate","deduplicates","deduplicated","deduplicating",
  "allow","allows","allowed","allowing",
  "mark","marks","marked","marking",
  "cancel","cancels","cancelled","cancelling","canceled","canceling",
  "register","registers","registered","registering",
  "run","runs","ran","running",
  "delete","deletes","deleted","deleting",
  "collapse","collapses","collapsed","collapsing",
  "bind","binds","bound","binding",
  "build","builds","built","building",
  "skip","skips","skipped","skipping",
  "require","requires","required","requiring",
  "expose","exposes","exposed","exposing",
  "match","matches","matched","matching",
  "stamp","stamps","stamped","stamping",
  "throw","throws","thrown","throwing","threw",
  "catch","catches","caught","catching",
  "stop","stops","stopped","stopping",
  "complete","completes","completed","completing",
  "read","reads","reading",
  "write","writes","wrote","written","writing",
  "fire","fires","fired","firing",
  "open","opens","opened","opening",
  "close","closes","closed","closing",
  "listen","listens","listened","listening",
  "handle","handles","handled","handling",
  "forward","forwards","forwarded","forwarding",
  "cache","caches","cached","caching",
  "default","defaults","defaulted","defaulting",
  "configure","configures","configured","configuring",
  "load","loads","loaded","loading",
  "encode","encodes","encoded","encoding",
  "decompress","decompresses","decompressed","decompressing",
  "compose","composes","composed","composing",
  "nest","nests","nested","nesting",
  "provide","provides","provided","providing",
  "accept","accepts","accepted","accepting",
  "render","renders","rendered","rendering",
  "include","includes","included","including",
  "pass","passes","passed","passing",
  "call","calls","called","calling",
  "use","uses","used","using",
  "parse","parses","parsed","parsing",
  "block","blocks","blocked","blocking",
  "strip","strips","stripped","stripping",
  "detect","detects","detected","detecting",
  "log","logs","logged","logging",
  "show","shows","showed","shown","showing",
  "classify","classifies","classified","classifying",
  "extract","extracts","extracted","extracting",
  "set","sets","setting",
  "resolve","resolves","resolved","resolving",
  "remove","removes","removed","removing",
  "map","maps","mapped","mapping",
  "omit","omits","omitted","omitting",
  "respect","respects","respected","respecting",
  "convert","converts","converted","converting",
  "truncate","truncates","truncated","truncating",
  "filter","filters","filtered","filtering",
  "replace","replaces","replaced","replacing",
  "send","sends","sent","sending",
  "store","stores","stored","storing",
  "report","reports","reported","reporting",
  "inject","injects","injected","injecting",
  "ignore","ignores","ignored","ignoring",
  "format","formats","formatted","formatting",
  "warn","warns","warned","warning",
  "display","displays","displayed","displaying",
  "get","gets","got","getting",
  "exit","exits","exited","exiting",
  "contain","contains","contained","containing",
  "start","starts","started","starting",
  "fail","fails","failed","failing",
  "succeed","succeeds","succeeded","succeeding",
  "find","finds","found","finding",
  "finish","finishes","finished","finishing",
  "halt","halts","halted","halting",
  "abort","aborts","aborted","aborting",
  "drop","drops","dropped","dropping",
  "trim","trims","trimmed","trimming",
  "add","adds","added","adding",
  "insert","inserts","inserted","inserting",
  "update","updates","updated","updating",
  "output","outputs","outputted","outputting",
  "append","appends","appended","appending",
  "prepend","prepends","prepended","prepending",
  "leave","leaves","left","leaving",
  "keep","keeps","kept","keeping",
  "advance","advances","advanced","advancing",
  "reuse","reuses","reused","reusing",
  "revert","reverts","reverted","reverting",
  "restore","restores","restored","restoring",
  "retry","retries","retried","retrying",
  "expire","expires","expired","expiring",
  "publish","publishes","published","publishing",
  "subscribe","subscribes","subscribed","subscribing",
  "hash","hashes","hashed","hashing",
  "encrypt","encrypts","encrypted","encrypting",
  "decrypt","decrypts","decrypted","decrypting",
  "sign","signs","signed","signing",
  "verify","verifies","verified","verifying",
  "escape","escapes","escaped","escaping",
  "unescape","unescapes","unescaped","unescaping",
  "sanitize","sanitizes","sanitized","sanitizing",
  "substitute","substitutes","substituted","substituting",
  "coerce","coerces","coerced","coercing",
  "enforce","enforces","enforced","enforcing",
  "honor","honors","honored","honoring",
  "disable","disables","disabled","disabling",
  "enable","enables","enabled","enabling",
  "toggle","toggles","toggled","toggling",
  "notify","notifies","notified","notifying",
  "broadcast","broadcasts","broadcasted","broadcasting",
  "disconnect","disconnects","disconnected","disconnecting",
  "connect","connects","connected","connecting",
  "reconnect","reconnects","reconnected","reconnecting",
  "select","selects","selected","selecting",
  "join","joins","joined","joining",
  "aggregate","aggregates","aggregated","aggregating",
  "count","counts","counted","counting",
  "sum","sums","summed","summing",
  "increment","increments","incremented","incrementing",
  "decrement","decrements","decremented","decrementing",
  "reset","resets",
  "reboot","reboots","rebooted","rebooting",
  "restart","restarts","restarted","restarting",
  "recover","recovers","recovered","recovering",
  "attach","attaches","attached","attaching",
  "detach","detaches","detached","detaching",
  "mount","mounts","mounted","mounting",
  "unmount","unmounts","unmounted","unmounting",
  "terminate","terminates","terminated","terminating",
  "isolate","isolates","isolated","isolating",
  "partition","partitions","partitioned","partitioning",
  "namespace","namespaces","namespaced","namespacing",
  "scope","scopes","scoped","scoping",
  "delegate","delegates","delegated","delegating",
  "tee","tees","teed",
  "split","splits","splitting",
  "combine","combines","combined","combining",
  "order","orders","ordered","ordering",
  "sort","sorts","sorted","sorting",
  "reverse","reverses","reversed","reversing",
  "invert","inverts","inverted","inverting",
  "reflect","reflects","reflected","reflecting",
  "project","projects","projected","projecting",
  "extend","extends","extended","extending",
  "narrow","narrows","narrowed","narrowing",
  "widen","widens","widened","widening",
  "broaden","broadens","broadened","broadening",
  "pad","pads","padded","padding",
  "align","aligns","aligned","aligning",
  "justify","justifies","justified","justifying",
  "unwrap","unwraps","unwrapped","unwrapping",
  "deliver","delivers","delivered","delivering",
  "suppress","suppresses","suppressed","suppressing",
  "treat","treats","treated","treating",
  "capture","captures","captured","capturing",
  "generate","generates","generated","generating",
  "record","records","recorded","recording",
  "appear","appears","appeared","appearing",
  "raise","raises","raised","raising",
  "break","breaks","broke","broken","breaking",
  "fix","fixes","fixed","fixing",
  "guard","guards","guarded","guarding",
  "assert","asserts","asserted","asserting",
  "expect","expects","expected","expecting",
  "compute","computes","computed","computing",
  "measure","measures","measured","measuring",
  "cover","covers","covered","covering",
  "test","tests","tested","testing",
  "exist","exists","existed","existing",
  "consume","consumes","consumed","consuming",
  "persist","persists","persisted","persisting",
  "loop","loops","looped","looping",
  "iterate","iterates","iterated","iterating",
  "recurse","recurses","recursed","recursing",
  "trigger","triggers","triggered","triggering",
  "reach","reaches","reached","reaching",
  "follow","follows","followed","following",
  "list","lists","listed","listing",
  "enumerate","enumerates","enumerated","enumerating",
  "pin","pins","pinned","pinning",
  "reference","references","referenced","referencing",
  "recognize","recognizes","recognized","recognizing",
  "round-trip","round-trips","round-tripped","round-tripping",
  "fan","fans","fanned","fanning",
  "carry","carries","carried","carrying",
  "elide","elides","elided","eliding",
  "enrich","enriches","enriched","enriching",
  "expand","expands","expanded","expanding",
  "flush","flushes","flushed","flushing",
  "freeze","freezes","froze","frozen","freezing",
  "gate","gates","gated","gating",
  "happen","happens","happened","happening",
  "maintain","maintains","maintained","maintaining",
  "mask","masks","masked","masking",
  "materialize","materializes","materialized","materializing",
  "memorize","memorizes","memorized","memorizing",
  "mention","mentions","mentioned","mentioning",
  "migrate","migrates","migrated","migrating",
  "mock","mocks","mocked","mocking",
  "move","moves","moved","moving",
  "observe","observes","observed","observing",
  "own","owns","owned","owning",
  "patch","patches","patched","patching",
  "pick","picks","picked","picking",
  "point","points","pointed","pointing",
  "pop","pops","popped","popping",
  "post","posts","posted","posting",
  "prefer","prefers","preferred","preferring",
  "prepare","prepares","prepared","preparing",
  "prevent","prevents","prevented","preventing",
  "print","prints","printed","printing",
  "promote","promotes","promoted","promoting",
  "prompt","prompts","prompted","prompting",
  "protect","protects","protected","protecting",
  "pull","pulls","pulled","pulling",
  "push","pushes","pushed","pushing",
  "rebuild","rebuilds","rebuilt","rebuilding",
  "redirect","redirects","redirected","redirecting",
  "release","releases","released","releasing",
  "rename","renames","renamed","renaming",
  "reorder","reorders","reordered","reordering",
  "request","requests","requested","requesting",
  "retain","retains","retained","retaining",
  "review","reviews","reviewed","reviewing",
  "revoke","revokes","revoked","revoking",
  "roll","rolls","rolled","rolling",
  "rotate","rotates","rotated","rotating",
  "save","saves","saved","saving",
  "see","sees","saw","seen","seeing",
  "serialize","serializes","serialized","serializing",
  "settle","settles","settled","settling",
  "shadow","shadows","shadowed","shadowing",
  "share","shares","shared","sharing",
  "sleep","sleeps","slept","sleeping",
  "spawn","spawns","spawned","spawning",
  "support","supports","supported","supporting",
  "sweep","sweeps","swept","sweeping",
  "sync","syncs","synced","syncing",
  "take","takes","took","taken","taking",
  "tag","tags","tagged","tagging",
  "tolerate","tolerates","tolerated","tolerating",
  "transform","transforms","transformed","transforming",
  "translate","translates","translated","translating",
  "unblock","unblocks","unblocked","unblocking",
  "upgrade","upgrades","upgraded","upgrading",
  "wait","waits","waited","waiting",
  "walk","walks","walked","walking",
  "wire","wires","wired","wiring",
  "yield","yields","yielded","yielding",
  "distinguish","distinguishes","distinguished","distinguishing",
  "fans-out",
  "cap","caps","capped","capping",
  "label","labels","labeled","labelling","labeling",
  "exhibit","exhibits","exhibited","exhibiting",
  "link","links","linked","linking",
  "survive","survives","survived","surviving",
  "name","names","named","naming",
  "rounds","rounded","rounding",
  "accumulate","accumulates","accumulated","accumulating",
  "check","checks","checked","checking",
  "calculate","calculates","calculated","calculating",
  "account","accounts","accounted","accounting",
  "escalate","escalates","escalated","escalating",
  "group","groups","grouped","grouping",
  "repair","repairs","repaired","repairing",
  "import","imports","imported","importing",
  "continue","continues","continued","continuing",
  "offload","offloads","offloaded","offloading",
  "place","places","placed","placing",
  "mutate","mutates","mutated","mutating",
  "prioritize","prioritizes","prioritized","prioritizing",
  "background","backgrounds","backgrounded","backgrounding",
  "note","notes","noted","noting",
  "copy","copies","copied","copying",
  "repeat","repeats","repeated","repeating",
  "clamp","clamps","clamped","clamping",
  "exclude","excludes","excluded","excluding",
  "populate","populates","populated","populating",
  "override","overrides","overrode","overridden","overriding",
  "evict","evicts","evicted","evicting",
  "clean","cleans","cleaned","cleaning",
  "flag","flags","flagged","flagging",
  "execute","executes","executed","executing",
  "discover","discovers","discovered","discovering",
  "scan","scans","scanned","scanning",
  "rewrite","rewrites","rewrote","rewritten","rewriting",
  "score","scores","scored","scoring",
  "categorize","categorizes","categorized","categorizing",
  "fetch","fetches","fetched","fetching",
  "bucket","buckets","bucketed","bucketing",
  "collect","collects","collected","collecting",
  "defer","defers","deferred","deferring",
  "tokenize","tokenizes","tokenized","tokenizing",
  "roundtrip","roundtrips","roundtripped","roundtripping",
  "dispose","disposes","disposed","disposing",
  "differ","differs","differed","differing",
  "equal","equals","equaled","equaling",
  "disrupt","disrupts","disrupted","disrupting",
  "receive","receives","received","receiving",
  "become","becomes","became","becoming",
  "remain","remains","remained","remaining",
  "present","presents","presented","presenting",
  "hold","holds","held","holding",
  "claim","claims","claimed","claiming",
  "mean","means","meant","meaning",
  "exempt","exempts","exempted","exempting",
  "refresh","refreshes","refreshed","refreshing",
  "inspect","inspects","inspected","inspecting",
  "rethrow","rethrows","rethrown","rethrowing",
  "snap","snaps","snapped","snapping",
  "assign","assigns","assigned","assigning",
  "inherit","inherits","inherited","inheriting",
  "estimate","estimates","estimated","estimating",
  "relocate","relocates","relocated","relocating",
  "correct","corrects","corrected","correcting",
  "overwrite","overwrites","overwrote","overwritten","overwriting",
  "describe","describes","described","describing",
  "click","clicks","clicked","clicking",
  // Special operators commonly used in noun-phrase descriptions:
  "no","never","always","every","each","zero","none","empty","null","undefined",
  "after","before","with","without","once","still","only","more","less",
  "multiple","single","one","two","three","four","five","six","seven","eight","nine","ten",
  // Mode-prefix words common in this codebase ("minimal mode excludes", "full mode defers"):
  "minimal","full","preview","draft","strict","loose",
  // Additional verbs surfaced by self-test against the repo:
  "suspend","suspends","suspended","suspending",
  "resume","resumes","resumed","resuming",
  "bypass","bypasses","bypassed","bypassing",
  "meet","meets","met","meeting",
  "perform","performs","performed","performing",
  "specify","specifies","specified","specifying",
  "navigate","navigates","navigated","navigating",
  "decompose","decomposes","decomposed","decomposing",
  "zoom","zooms","zoomed","zooming",
  "double","doubles","doubled","doubling",
  "cycle","cycles","cycled","cycling",
  "shift","shifts","shifted","shifting",
  "rank","ranks","ranked","ranking",
  "concatenate","concatenates","concatenated","concatenating",
  "activate","activates","activated","activating",
  "allocate","allocates","allocated","allocating",
  "analyze","analyzes","analyzed","analyzing",
  "agree","agrees","agreed","agreeing",
  "compact","compacts","compacted","compacting",
  "delay","delays","delayed","delaying",
  "transition","transitions","transitioned","transitioning",
  "bail","bails","bailed","bailing",
  "debounce","debounces","debounced","debouncing",
  "cut","cuts","cutting",
  "press","presses","pressed","pressing",
  "switch","switches","switched","switching",
  "auto-detect","auto-detects","auto-detected","auto-detecting",
  "html-escape","html-escapes","html-escaped","html-escaping",
  "xml-escape","xml-escapes","xml-escaped","xml-escaping",
  "url-encode","url-encodes","url-encoded","url-encoding",
  "increase","increases","increased","increasing",
  "decrease","decreases","decreased","decreasing",
  "satisfy","satisfies","satisfied","satisfying",
  "discriminate","discriminates","discriminated","discriminating",
  "go","goes","went","gone","going",
  "highlight","highlights","highlighted","highlighting",
  "replay","replays","replayed","replaying",
  "redo","redoes","redoing","redid",
  "undo","undoes","undoing","undid",
  "empty","empties","emptied","emptying",
  "drag","drags","dragged","dragging",
  "drop","drops","dropped","dropping",
  "tab","tabs","tabbed","tabbing",
  "batch","batches","batched","batching",
  "quote","quotes","quoted","quoting",
  "re-classify","re-classifies","re-classified","re-classifying",
  "act","acts","acted","acting",
  "focus","focuses","focused","focusing",
  "retrieve","retrieves","retrieved","retrieving",
  "assemble","assembles","assembled","assembling",
  "reduce","reduces","reduced","reducing",
  "authenticate","authenticates","authenticated","authenticating",
  "fill","fills","filled","filling","pre-fill","pre-fills","pre-filled","pre-filling",
  "stamp","stamps","stamped","stamping",
  "key","keys","keyed","keying",
  "control","controls","controlled","controlling",
  "make","makes","made","making",
  "doubles","doubled","doubling",
  "pin","pins","pinned","pinning",
  "lock","locks","locked","locking",
  "unlock","unlocks","unlocked","unlocking",
  "lookup","lookups","looked","looking",
  "act","acts","acted","acting",
  "swap","swaps","swapped","swapping",
  "round","rounds","rounded","rounding",
  // Single-word verb-as-state forms (intransitive):
  "true","false",
  "ok","ok-with","ok-when",
  // Common prepositions / connectors at sentence start (often imply a state):
  "from","to","for","with","without","via","on","of","at","by","over","under","into","onto","upon","across","through",
  "after","before","once","until","while",
  // BDD-style scenario noun-prefixes also accepted:
  "scenario","case","example","precondition","postcondition","invariant","property",
  // More state/lifecycle verbs:
  "stays","stay","stayed","staying",
  "elapses","elapse","elapsed","elapsing",
  "wakes","wake","woke","woken","waking",
  // More verbs surfaced by self-test against the repo:
  "floor","floors","floored","flooring",
  "lowercase","lowercases","lowercased","lowercasing",
  "uppercase","uppercases","uppercased","uppercasing",
  "kill","kills","killed","killing",
  "index","indexes","indexed","indexing",
  "force","forces","forced","forcing",
  "embed","embeds","embedded","embedding",
  "drain","drains","drained","draining",
  "hit","hits","hitting",
  "null","nulls","nulled","nulling",
  "resize","resizes","resized","resizing",
  "rethrow","rethrows","rethrew","rethrown","rethrowing",
  "reformat","reformats","reformatted","reformatting",
  "squash","squashes","squashed","squashing",
  "rebase","rebases","rebased","rebasing",
  "suggest","suggests","suggested","suggesting",
  "thread","threads","threaded","threading",
  "unregister","unregisters","unregistered","unregistering",
  "unsubscribe","unsubscribes","unsubscribed","unsubscribing",
  "proceed","proceeds","proceeded","proceeding",
  "win","wins","won","winning",
  "abstain","abstains","abstained","abstaining",
  "re-export","re-exports","re-exported","re-exporting",
  "re-throw","re-throws","re-thrown","re-throwing",
  "semi-redact","semi-redacts","semi-redacted","semi-redacting",
  "free","frees","freed","freeing",
  "hide","hides","hid","hidden","hiding",
  "fallback","fallbacks",
  "pre-fire","pre-fires","pre-fired","pre-firing",
  "snapshot","snapshots","snapshotted","snapshotting",
  // VERB_FORMS extensions for legitimate heuristic-miss entries from
  // testNamingAllowlist. Each addition must be a common English verb /
  // verb-form-noun whose presence in a description signals legitimate
  // use-case intent. (BLOCKLIST_RE still catches bare anti-patterns like
  // "works" alone.)
  "declare","declares","declared","declaring",
  "work","works","worked","working",
  "isolation","enforcement",
]);

const WORD_TOKEN_RE = /[a-zA-Z][a-zA-Z'-]*/g;

function containsVerb(text: string): boolean {
  for (const m of text.matchAll(WORD_TOKEN_RE)) {
    if (VERB_FORMS.has(m[0].toLowerCase())) return true;
  }
  return false;
}

function isUseCaseShaped(text: string): boolean {
  return (
    BDD_RE.test(text) ||
    containsVerb(text) ||
    SUBJECT_COLON_RE.test(text) ||
    TEST_NUM_PREFIX_RE.test(text)
  );
}

// ---------------------------------------------------------------------------
// Source-text extraction — strip comments first, then match describe / it /
// test calls with a STRING-LITERAL first argument.
// ---------------------------------------------------------------------------

/**
 * Strip JSDoc / multi-line block comments AND single-line `//` comments
 * from TypeScript source. Replaces each comment with the same number of
 * NEWLINES (preserving line numbers) and SPACES (preserving columns).
 * This is good enough for description extraction — we don't need to
 * preserve exact contents.
 *
 * Limitation: regex-based comment stripping does not understand string
 * literals containing `//` or `/* `. For test files this is acceptable
 * (the description we want to match is always real code, and a string
 * literal with a `*\/` inside it would not nest correctly anyway).
 */
function stripComments(source: string): string {
  // 1. Replace block comments /* ... */ with whitespace of same shape.
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  // 2. Replace line comments // ... up to newline.
  out = out.replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
  return out;
}

interface Description {
  readonly kind: "describe" | "it" | "test";
  readonly text: string;
  readonly line: number;
}

const DESCRIPTION_CALL_RE =
  /\b(describe|it|test)\s*(?:\.\w+)?\s*\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$]|\\.)*)`)/g;

function extractDescriptions(source: string): readonly Description[] {
  const stripped = stripComments(source);
  const out: Description[] = [];
  for (const m of stripped.matchAll(DESCRIPTION_CALL_RE)) {
    const kind = m[1] as "describe" | "it" | "test";
    const text = m[2] ?? m[3] ?? m[4] ?? "";
    // 1-based line number of the match start position:
    const before = stripped.slice(0, m.index ?? 0);
    const line = before.split("\n").length;
    out.push({ kind, text, line });
  }
  return out;
}

// ---------------------------------------------------------------------------
// File walker — clone of test/architecture/coverage-gate.test.ts walker,
// adjusted to include *.test.ts (not exclude).
// ---------------------------------------------------------------------------

const EXCLUDED_DIRS = new Set([
  "__tests__",
  "__snapshots__",
  "dist",
  "node_modules",
  "__test-helpers",
  "fixtures",
]);

function walkTestFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walkTestFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
}

function repoRelative(absPath: string): string {
  return absPath.startsWith(REPO_ROOT)
    ? absPath.slice(REPO_ROOT.length + 1)
    : absPath;
}

// ---------------------------------------------------------------------------
// Allowlist for current-state offenders — defined in
// `test/support/architecture-allowlist.ts` as `testNamingAllowlist`.
//
// Each entry exempts a SINGLE (file, line) coordinate from predicate 2
// (min-length) or predicate 3 (use-case shape). The shrink-only ratchet
// in `test/architecture/allowlist-shrink.test.ts` enforces this list
// SHRINKS over time. Future changes add tests by renaming legacy short
// descriptions OR extending VERB_FORMS / heuristic regexes.
//
// Predicate 1 (anchored blocklist) is NEVER allowlisted — the codebase
// is at 0 blocklist matches, and any regression is a hard fail.
// ---------------------------------------------------------------------------

const allowlistKey = (file: string, line: number, text: string): string =>
  `${file}:${line}:${text}`;
const allowlistSet = new Set(
  testNamingAllowlist.map((e) => allowlistKey(e.file, e.line, e.text)),
);

function isAllowlisted(
  file: string,
  line: number,
  text: string,
): boolean {
  return allowlistSet.has(allowlistKey(file, line, text));
}

// ---------------------------------------------------------------------------
// One-time collection (shared across the 3 it blocks).
// ---------------------------------------------------------------------------

interface CollectedDescription {
  readonly file: string;
  readonly line: number;
  readonly kind: "describe" | "it" | "test";
  readonly text: string;
}

function collectAllDescriptions(): readonly CollectedDescription[] {
  const allFiles: string[] = [];
  walkTestFiles(resolve(REPO_ROOT, "packages"), allFiles);
  walkTestFiles(resolve(REPO_ROOT, "test"), allFiles);
  const out: CollectedDescription[] = [];
  for (const file of allFiles) {
    const source = readFileSync(file, "utf8");
    const rel = repoRelative(file);
    for (const d of extractDescriptions(source)) {
      out.push({ file: rel, line: d.line, kind: d.kind, text: d.text });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

describe("validates test-naming use-case description invariants", () => {
  const allDescriptions = collectAllDescriptions();

  it("rejects test descriptions matching the implementation-detail blocklist /^(works|happy path|test \\d+|sanity|smoke)$/i", () => {
    const violations = allDescriptions.filter(
      (d) =>
        BLOCKLIST_RE.test(d.text) &&
        !isAllowlisted(d.file, d.line, d.text),
    );
    expect(
      violations.map((v) => `${v.file}:${v.line} ${v.kind}("${v.text}")`),
      formatViolations({
        description:
          "No test, it, or describe description may match the anchored exact-match blocklist /^(works|happy path|test \\d+|sanity|smoke)$/i.",
        violations: violations.map((v) => ({
          file: v.file,
          line: v.line,
          snippet: `${v.kind}("${v.text}")`,
        })),
        suggestedFix:
          "Rename the descriptor to a use-case-shape phrase ≥20 chars (e.g., \"works\" → \"applies the configured policy when input matches\").",
        allowlistRef:
          "no allowlist — the blocklist is anchored exact-match (compound descriptors like \"smoke-level contract\" are NOT in the blocklist)",
      }),
    ).toEqual([]);
  });

  it("requires every it/test description to be at least 20 characters long", () => {
    const violations = allDescriptions.filter(
      (d) =>
        (d.kind === "it" || d.kind === "test") &&
        d.text.length < 20 &&
        !isAllowlisted(d.file, d.line, d.text),
    );
    expect(
      violations.map(
        (v) =>
          `${v.file}:${v.line} ${v.kind}("${v.text}") len=${v.text.length}`,
      ),
      formatViolations({
        description:
          "Every it/test description must be at least 20 characters to convey use-case intent. (describe descriptions are exempt — they name the subject-under-test, not the use case.)",
        violations: violations.map((v) => ({
          file: v.file,
          line: v.line,
          snippet: `${v.kind}("${v.text}") length=${v.text.length}`,
        })),
        suggestedFix:
          "Expand the descriptor to name the observable behavior in ≥20 characters. Anti-pattern: \"happy path\" (10), \"returns ok\" (10), \"works fine\" (10). Use-case-shape: \"returns Result.ok with payload when input is valid\" (50).",
        allowlistRef:
          "testNamingAllowlist (test/support/architecture-allowlist.ts) — for legitimate short descriptions or temporary deferrals",
      }),
    ).toEqual([]);
  });

  it("rejects it/test descriptions that fail the use-case shape heuristic (BDD prefix, embedded verb, subject:colon, or test-numbered prefix)", () => {
    const violations = allDescriptions.filter(
      (d) =>
        (d.kind === "it" || d.kind === "test") &&
        !isUseCaseShaped(d.text) &&
        !isAllowlisted(d.file, d.line, d.text),
    );
    expect(
      violations.map((v) => `${v.file}:${v.line} ${v.kind}("${v.text}")`),
      formatViolations({
        description:
          "Every it/test description must end in a recognizable use-case shape: (a) starts with BDD when/given/on, (b) contains a recognized verb anywhere, (c) is \"Subject: detail\" form, or (d) is test-numbered (\"Test N\", \"g)\", \"10)\").",
        violations: violations.map((v) => ({
          file: v.file,
          line: v.line,
          snippet: `${v.kind}("${v.text}")`,
        })),
        suggestedFix:
          "Rephrase to start with a verb (\"returns\", \"rejects\", \"applies\", ...) OR a BDD precondition (\"when X, ...\") OR use \"Subject: behavior\" form. If the heuristic misclassifies a legitimate description, either (1) add the missing verb to VERB_FORMS in test/architecture/test-naming.test.ts, or (2) add the (file, line, text) tuple to testNamingAllowlist with a justifying reason.",
        allowlistRef:
          "testNamingAllowlist (test/support/architecture-allowlist.ts) and VERB_FORMS (same file)",
      }),
    ).toEqual([]);
  });
});
