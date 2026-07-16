#!/usr/bin/env node
// Documentation gate: compile MDX, validate local routes and anchors, require
// complete navigation/index coverage, and pin a few high-value public claims to
// their code/package sources. Build tooling is exempt from production TDD; this
// command is self-verifying and exits non-zero on drift.

import { access, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { compile } from "@mdx-js/mdx";
import remarkFrontmatter from "remark-frontmatter";

const ROOT = process.cwd();
const DOCS_DIR = join(ROOT, "docs");
const DOCS_CONFIG = join(DOCS_DIR, "docs.json");
const failures = [];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".mdx")) yield full;
  }
}

function stripCodeFences(value) {
  return value.replace(/```[\s\S]*?```/g, "");
}

function slugifyHeading(raw) {
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\\([^\p{L}\p{N}\s_-])/gu, "$1")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function normalizedAnchorKey(raw) {
  return raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function collectAnchors(value) {
  const withoutFences = stripCodeFences(value);
  const anchors = new Set();
  const anchorKeys = new Set();
  const seen = new Map();

  for (const match of withoutFences.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    const base = slugifyHeading(match[1]);
    if (!base) continue;
    const duplicateIndex = seen.get(base) ?? 0;
    seen.set(base, duplicateIndex + 1);
    anchors.add(duplicateIndex === 0 ? base : `${base}-${duplicateIndex}`);
    anchorKeys.add(normalizedAnchorKey(match[1]));
  }

  for (const match of withoutFences.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) {
    anchors.add(match[1]);
    anchorKeys.add(normalizedAnchorKey(match[1]));
  }
  return { anchors, anchorKeys };
}

function pageIdForFile(file) {
  return relative(DOCS_DIR, file).replace(/\.mdx$/, "");
}

function publicRoute(pageId) {
  return pageId.endsWith("/index") ? pageId.slice(0, -6) : pageId;
}

function normalizeRoute(raw) {
  return raw.replace(/^\/+|\/+$/g, "");
}

function extractLocalLinks(value) {
  const withoutFences = stripCodeFences(value);
  const links = [];
  const markdown = /(?<!!)\[[^\]]+\]\((\/[^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  const jsx = /\bhref=["'](\/[^"']+)["']/g;
  for (const match of withoutFences.matchAll(markdown)) links.push(match[1]);
  for (const match of withoutFences.matchAll(jsx)) links.push(match[1]);
  return links;
}

function collectNavPages(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectNavPages(item, out);
  } else if (typeof value === "string") {
    out.push(value);
  } else if (value && typeof value === "object") {
    if ("pages" in value) collectNavPages(value.pages, out);
    if ("groups" in value) collectNavPages(value.groups, out);
  }
  return out;
}

function addFailure(message) {
  failures.push(`  ✗ ${message}`);
}

const documents = [];
for await (const file of walk(DOCS_DIR)) {
  const value = await readFile(file, "utf8");
  documents.push({
    file,
    value,
    pageId: pageIdForFile(file),
    ...collectAnchors(value),
  });

  try {
    await compile(
      { value, path: file },
      { format: "mdx", remarkPlugins: [remarkFrontmatter] },
    );
  } catch (err) {
    const loc = err?.line != null ? `:${err.line}:${err.column ?? 1}` : "";
    const reason = err?.reason ?? err?.message ?? String(err);
    addFailure(`${relative(ROOT, file)}${loc}\n      ${reason}`);
  }
}

const routeMap = new Map();
for (const document of documents) {
  routeMap.set(document.pageId, document);
  routeMap.set(publicRoute(document.pageId), document);
}

for (const document of documents) {
  if (
    /(?:curl|wget)[^\n]*https:\/\/(?:www\.)?comis\.ai\/install\.sh[^\n]*\|\s*(?:sudo\s+)?(?:bash|sh)\b/i.test(
      document.value,
    )
  ) {
    addFailure(
      `${relative(ROOT, document.file)} pipes the hosted installer directly to a shell; document download, inspection, --dry-run, then execution`,
    );
  }

  for (const rawLink of extractLocalLinks(document.value)) {
    let decoded;
    try {
      decoded = decodeURIComponent(rawLink);
    } catch {
      addFailure(`${relative(ROOT, document.file)} has malformed URL encoding: ${rawLink}`);
      continue;
    }

    const [pathPart, anchorPart] = decoded.split("#", 2);
    const route = normalizeRoute(pathPart || publicRoute(document.pageId));
    const target = routeMap.get(route);

    // Static assets are served outside the MDX route tree.
    if (!target && /\.(?:avif|gif|ico|jpe?g|png|svg|webp|zip|json)$/i.test(route)) continue;
    if (!target) {
      addFailure(`${relative(ROOT, document.file)} links to missing docs route: ${rawLink}`);
      continue;
    }
    if (
      anchorPart &&
      !target.anchors.has(anchorPart) &&
      !target.anchorKeys.has(normalizedAnchorKey(anchorPart))
    ) {
      addFailure(
        `${relative(ROOT, document.file)} links to missing anchor #${anchorPart} in ${relative(ROOT, target.file)}`,
      );
    }
  }
}

const docsConfig = JSON.parse(await readFile(DOCS_CONFIG, "utf8"));
const expectedTabs = ["Start here", "Use Comis", "Operate Comis", "Extend Comis", "Reference"];
const actualTabs = docsConfig.navigation?.tabs?.map((tab) => tab.tab) ?? [];
if (JSON.stringify(actualTabs) !== JSON.stringify(expectedTabs)) {
  addFailure(`docs/docs.json tabs must be: ${expectedTabs.join(" / ")}`);
}

const navPages = collectNavPages(docsConfig.navigation?.tabs ?? []);
const navCounts = new Map();
for (const page of navPages) navCounts.set(page, (navCounts.get(page) ?? 0) + 1);

const contentPageIds = documents
  .map((document) => document.pageId)
  .filter((pageId) => !pageId.startsWith("snippets/"));
for (const pageId of contentPageIds) {
  const count = navCounts.get(pageId) ?? 0;
  if (count !== 1) addFailure(`docs/docs.json must list ${pageId} exactly once (found ${count})`);
}
for (const [pageId, count] of navCounts) {
  if (!contentPageIds.includes(pageId)) addFailure(`docs/docs.json references missing page: ${pageId}`);
  if (count > 1) addFailure(`docs/docs.json lists ${pageId} ${count} times`);
}

const llms = await readFile(join(DOCS_DIR, "llms.txt"), "utf8");
const sitemap = await readFile(join(DOCS_DIR, "sitemap.md"), "utf8");
for (const pageId of contentPageIds) {
  const url = `https://docs.comis.ai/${publicRoute(pageId)}`;
  if (!llms.includes(url)) addFailure(`docs/llms.txt is missing ${url}`);
  if (!sitemap.includes(url)) addFailure(`docs/sitemap.md is missing ${url}`);
}

const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const nodeVersion = packageJson.engines?.node?.match(/\d+\.\d+\.\d+/)?.[0];
if (!nodeVersion) {
  addFailure("package.json engines.node must contain a concrete minimum version");
} else {
  for (const pageId of [
    "get-started/quickstart",
    "installation/requirements",
    "reference/node-permissions",
  ]) {
    if (!routeMap.get(pageId)?.value.includes(nodeVersion)) {
      addFailure(`${pageId}.mdx must state the package engine minimum ${nodeVersion}`);
    }
  }
}

const packageDirectories = (await readdir(join(ROOT, "packages"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const workspacePackageNames = [];
for (const directory of packageDirectories) {
  const manifest = JSON.parse(
    await readFile(join(ROOT, "packages", directory, "package.json"), "utf8"),
  );
  workspacePackageNames.push(manifest.name);
}
const packagesDoc = routeMap.get("developer-guide/packages")?.value ?? "";
const architectureDoc = routeMap.get("developer-guide/architecture")?.value ?? "";
if (!packagesDoc.includes(`${workspacePackageNames.length} TypeScript packages`)) {
  addFailure(
    `developer-guide/packages.mdx must state the current ${workspacePackageNames.length} packages`,
  );
}
if (!architectureDoc.includes(`All ${workspacePackageNames.length} packages`)) {
  addFailure(
    `developer-guide/architecture.mdx must state the current ${workspacePackageNames.length} packages`,
  );
}
for (const packageName of workspacePackageNames) {
  if (!packagesDoc.includes(`\`${packageName}\``)) {
    addFailure(`developer-guide/packages.mdx is missing workspace package ${packageName}`);
  }
}

const cliSource = await readFile(join(ROOT, "packages/cli/src/cli.ts"), "utf8");
const commandFiles = [...cliSource.matchAll(/from "\.\/commands\/([^".]+)\.js"/g)].map(
  (match) => match[1],
);
const sourceGroups = new Set();
for (const commandFile of commandFiles) {
  const source = await readFile(join(ROOT, `packages/cli/src/commands/${commandFile}.ts`), "utf8");
  const command = source.match(/\.command\("([a-z][a-z0-9-]*)/)?.[1];
  if (command) sourceGroups.add(command);
}
const cliDoc = routeMap.get("reference/cli")?.value ?? "";
const documentedGroups = new Set(
  [...cliDoc.matchAll(/^### `comis ([a-z][a-z0-9-]*)/gm)].map((match) => match[1]),
);
for (const command of sourceGroups) {
  if (!documentedGroups.has(command)) addFailure(`reference/cli.mdx is missing top-level command: ${command}`);
}
for (const command of documentedGroups) {
  if (!sourceGroups.has(command)) addFailure(`reference/cli.mdx documents unknown top-level command: ${command}`);
}
if (!cliDoc.includes(`**${sourceGroups.size} top-level command groups**`)) {
  addFailure(`reference/cli.mdx must state the current ${sourceGroups.size} top-level command groups`);
}

for (const requiredCommand of ["agent set-oauth-profile", "config audit", "sessions report"]) {
  if (!cliDoc.includes(requiredCommand)) addFailure(`reference/cli.mdx is missing ${requiredCommand}`);
}
const initSource = await readFile(join(ROOT, "packages/cli/src/commands/init.ts"), "utf8");
const initFlags = new Set([...initSource.matchAll(/--[a-z][a-z0-9-]+/g)].map((match) => match[0]));
for (const flag of initFlags) {
  if (!cliDoc.includes(flag)) addFailure(`reference/cli.mdx is missing init flag ${flag}`);
}

const canonicalTagline = "Open-source security-first runtime for AI agents that learn and act across sessions";
for (const [name, value] of [
  ["docs/docs.json", JSON.stringify(docsConfig)],
  ["docs/get-started/index.mdx", routeMap.get("get-started/index")?.value ?? ""],
  ["docs/llms.txt", llms],
  ["docs/sitemap.md", sitemap],
]) {
  if (!value.includes(canonicalTagline)) addFailure(`${name} is missing the canonical tagline`);
}

const campaignLine = "Let agents learn and act. Keep authority in the runtime.";
for (const [name, value] of [
  ["docs/get-started/index.mdx", routeMap.get("get-started/index")?.value ?? ""],
  ["docs/llms.txt", llms],
  ["docs/sitemap.md", sitemap],
]) {
  if (!value.includes(campaignLine)) addFailure(`${name} is missing the authority-and-learning campaign line`);
}

const benefitLine = "Governed learning. Bounded action. Recorded evidence.";
for (const [name, value] of [
  ["docs/get-started/index.mdx", routeMap.get("get-started/index")?.value ?? ""],
  ["docs/llms.txt", llms],
]) {
  if (!value.includes(benefitLine)) addFailure(`${name} is missing the public benefit line`);
}

for (const [name, value] of [
  ["README.md", await readFile(join(ROOT, "README.md"), "utf8")],
  ["packages/comis/README.md", await readFile(join(ROOT, "packages/comis/README.md"), "utf8")],
  ["docs/get-started/index.mdx", routeMap.get("get-started/index")?.value ?? ""],
  ["docs/get-started/how-it-works.mdx", routeMap.get("get-started/how-it-works")?.value ?? ""],
  ["docs/get-started/use-cases.mdx", routeMap.get("get-started/use-cases")?.value ?? ""],
  ["docs/reference/known-limitations.mdx", routeMap.get("reference/known-limitations")?.value ?? ""],
]) {
  if (value.includes("\u2014")) addFailure(`${name} contains an em dash`);
}

const highValueFiles = [
  "get-started/quickstart",
  "installation/index",
  "installation/requirements",
  "installation/install-linux",
  "installation/install-vps",
  "installation/install-render",
  "reference/cli",
].map((pageId) => routeMap.get(pageId)?.value ?? "").join("\n");
for (const stale of [
  /Friendly by nature\. Powerful by design\./i,
  /security@comis\.dev/i,
  /under\s+(?:5|five|10|ten)\s+minutes/i,
  /\b1\.0\.53\b/,
  /\b(?:17|24) command groups\b/i,
  /Node(?:\.js)?\s+22\+(?!\.)/i,
]) {
  if (stale.test(highValueFiles)) addFailure(`high-value public docs contain stale claim matching ${stale}`);
}

const openAiShapedSurface = [
  routeMap.get("reference/openai-api")?.value ?? "",
  routeMap.get("reference/http-gateway")?.value ?? "",
  routeMap.get("reference/index")?.value ?? "",
  routeMap.get("developer-guide/packages")?.value ?? "",
  llms,
  sitemap,
].join("\n");
for (const stale of [
  /OpenAI-Compatible API/i,
  /point any OpenAI-API-compatible client/i,
  /connect to Comis without modification/i,
  /for drop-in integration/i,
]) {
  if (stale.test(openAiShapedSurface)) {
    addFailure(`experimental /v1 docs contain a compatibility claim matching ${stale}`);
  }
}
const normalizedOpenAiShapedSurface = openAiShapedSurface.replace(/\*/g, "").replace(/\s+/g, " ");
for (const boundary of [
  "experimental",
  "OpenAI-shaped",
  "not a general compatibility guarantee",
]) {
  if (!normalizedOpenAiShapedSurface.includes(boundary)) {
    addFailure(`experimental /v1 docs are missing boundary language: ${boundary}`);
  }
}

const securitySurface = [
  routeMap.get("get-started/security")?.value ?? "",
  routeMap.get("security/index")?.value ?? "",
  routeMap.get("security/threat-model")?.value ?? "",
].join("\n").toLowerCase();
for (const requiredBoundary of [
  "disabled by default",
  "tool policy",
  "full",
  "mcp",
  "outside the exec sandbox",
  "streaming",
  "host",
]) {
  if (!securitySurface.includes(requiredBoundary)) {
    addFailure(`security overview is missing boundary language: ${requiredBoundary}`);
  }
}

try {
  await access(join(DOCS_DIR, "channels/msteams.mdx"));
} catch {
  addFailure("Microsoft Teams channel page is missing");
}
for (const [name, value] of [
  ["docs/docs.json", JSON.stringify(docsConfig)],
  ["docs/llms.txt", llms],
  ["docs/sitemap.md", sitemap],
]) {
  if (!value.includes("channels/msteams")) addFailure(`${name} is missing Microsoft Teams navigation`);
}

if (failures.length > 0) {
  console.error(`\n✗ Documentation check: ${failures.length} failure(s):\n`);
  console.error(failures.join("\n\n"));
  console.error("\nFix MDX syntax, local links/anchors, navigation coverage, or source-parity drift.\n");
  process.exit(1);
}

console.log(
  `✓ Documentation check: ${documents.length} MDX files, ${contentPageIds.length} navigable pages, ` +
    `${sourceGroups.size} CLI groups, links and anchors verified.`,
);
