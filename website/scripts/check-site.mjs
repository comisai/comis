// SPDX-License-Identifier: Apache-2.0
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(websiteDir, "dist");
const sourceDir = path.join(websiteDir, "src");
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function sameValues(actual, expected, message) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  }));
  return nested.flat();
}

function attributes(tag) {
  const result = new Map();
  for (const match of tag.matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) {
    result.set(match[1].toLowerCase(), match[2] ?? match[3] ?? "");
  }
  return result;
}

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((match) => match[0]);
}

function decodeHtml(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&nbsp;", " ");
}

function textContent(value) {
  return decodeHtml(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function metaContent(html, key) {
  for (const tag of tags(html, "meta")) {
    const attrs = attributes(tag);
    if (attrs.get("name") === key || attrs.get("property") === key) return attrs.get("content");
  }
  return undefined;
}

const expectedTitle = "Comis: Open-source agent runtime for governed execution";
const expectedDescription = "Self-hosted runtime for governed multi-agent workflows with scoped authority, bounded spend, recoverable context, and operational evidence.";
const expectedInstallCommand = "curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh | bash";
const approvedExternalLinks = new Set([
  "https://docs.comis.ai",
  "https://docs.comis.ai/installation",
  "https://github.com/comisai/comis",
  "https://github.com/comisai/comis/issues",
  "https://github.com/comisai/comis/discussions",
  "https://github.com/comisai/comis/blob/main/CONTRIBUTING.md",
  "https://github.com/comisai/comis/security",
  "https://github.com/comisai/comis/blob/main/THREAT_MODEL.md",
  "https://github.com/comisai/comis/blob/main/LICENSE",
]);

const sourcePages = (await listFiles(path.join(sourceDir, "pages")))
  .filter((file) => file.endsWith(".astro"))
  .map((file) => path.relative(path.join(sourceDir, "pages"), file));
sameValues(sourcePages, ["index.astro"], "Astro source routes");

const distFiles = await listFiles(distDir);
const htmlRoutes = distFiles
  .filter((file) => file.endsWith(".html"))
  .map((file) => path.relative(distDir, file));
sameValues(htmlRoutes, ["index.html"], "Generated HTML routes");

const html = await readFile(path.join(distDir, "index.html"), "utf8");
const mainMatch = html.match(/<main\b[^>]*>[\s\S]*?<\/main>/i);
check(Boolean(mainMatch), "Homepage must contain a main landmark");
const mainHtml = mainMatch?.[0] ?? "";

const sectionOrder = tags(mainHtml, "section").map((tag) => attributes(tag).get("data-section"));
sameValues(sectionOrder, ["hero", "why-comis", "workflows", "capabilities", "security", "install", "community"], "Homepage section order");

check(tags(html, "header").length === 1, "Homepage must contain one header landmark");
check(tags(html, "main").length === 1, "Homepage must contain one main landmark");
check(tags(html, "footer").length === 1, "Homepage must contain one footer landmark");
check(tags(html, "h1").length === 1, "Homepage must contain exactly one h1");

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
check(new Set(ids).size === ids.length, "Homepage IDs must be unique");
for (const section of tags(mainHtml, "section")) {
  const labelledBy = attributes(section).get("aria-labelledby");
  check(Boolean(labelledBy) && ids.includes(labelledBy), `Section ${attributes(section).get("data-section") ?? "unknown"} must reference an existing heading`);
}

const headings = [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((match) => textContent(match[1]));
sameValues(headings, [
  "From request to inspectable result.",
  "Govern execution, memory, security, authority, and cost as one system.",
  "Use Comis when agent work needs evidence, boundaries, and recovery.",
  "Operate agents across channels, tools, state, and schedules.",
  "Layered security with explicit boundaries.",
  "Install Comis on your infrastructure.",
  "Help make agent governance reproducible.",
], "Homepage h2 hierarchy");

const whySectionHtml = mainHtml.match(/<section\b[^>]*data-section="why-comis"[^>]*>[\s\S]*?<\/section>/i)?.[0] ?? "";
const advantageHeadings = [...whySectionHtml.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)].map((match) => textContent(match[1]));
sameValues(advantageHeadings, [
  "Typed execution",
  "Recoverable canonical context",
  "Provenance-aware memory",
  "Scoped authority and layered security",
  "Bounded spend",
  "Operational evidence",
], "Verified advantage hierarchy");

const mainText = textContent(mainHtml
  .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[\s\S]*?<\/style>/gi, " "));
const visibleMainText = textContent(mainHtml
  .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
  .replace(/<code\b[\s\S]*?<\/code>/gi, " "));
const wordCount = visibleMainText.match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
check(wordCount <= 750, `Visible homepage copy must remain at or below 750 words; received ${wordCount}`);

for (const requiredText of [
  "Apache-2.0 | Active development",
  "Run AI agents you can constrain, inspect, and recover.",
  "Comis gives AI platform and security teams a self-hosted runtime for governed multi-agent workflows, with scoped authority, bounded spend, recoverable context, provenance-aware memory, and operational evidence.",
  "Controls apply only to agents executing through Comis-controlled paths.",
  "Comis's advantage is coherence. Formal workflows, recoverable context, provenance-aware memory, scoped authority, bounded spend, and operational evidence share one governance model.",
  "Coordinate sequential and parallel DAG nodes with barriers, retries, budgets, and configured recovery.",
  "Keep messages and tool results available beneath summaries, then recover selected detail on demand.",
  "Rank and revise learned state using provenance, corroboration, trust ceilings, outcomes, and corrections.",
  "Treat models as untrusted with scoped state, capability gates, encrypted secrets, and content guards.",
  "Combine provider cost accounting, graph budgets, and opt-in spend ceilings.",
  "Connect traces, incident explanation, audits, fleet health, and recall diagnostics for investigation.",
  "Governed research and analysis",
  "Read-only operational investigation",
  "The installer can add Node.js and host dependencies, initialize data, and register systemd or PM2. On Linux it can also provision Chromium, Xvfb, and a dedicated service user.",
  "Linux with Bubblewrap is the recommended target. macOS isolation is best-effort and does not provide the same boundary.",
  "The ordinary exec tool can run directly on the host when its sandbox is disabled or unavailable.",
  "The default tool profile is full, and an empty per-agent secret allowlist is unrestricted. Narrow both before accepting untrusted input.",
  "Streaming consumers can receive deltas before the completed response passes its final output scan.",
  "Approval requests are available on explicitly wired paths when enabled; they are not a universal policy engine.",
  "Skill-declared permissions are advisory unless the same limits are enforced through runtime tool policy and deployment controls.",
  "Enterprise-oriented foundation, under active development:",
]) {
  check(mainText.includes(requiredText), `Required verified copy is missing: ${requiredText}`);
}

const installCommand = mainHtml.match(/<code\b[^>]*data-install-command[^>]*>([\s\S]*?)<\/code>/i)?.[1] ?? "";
check(textContent(installCommand) === expectedInstallCommand, "Primary installer command must be the hardened one-line install");
check(mainText.includes("curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh -o comis-install.sh"), "Review-first installer alternative is missing");
check(mainText.includes("bash comis-install.sh --dry-run"), "Installer dry-run command is missing");
check(mainText.includes("npm install --global comisai"), "Direct npm installation path is missing");
for (const pattern of [
  /\bblog\b/i,
  /\bcomparison\b/i,
  /\bcompetitor\b/i,
  /\bpersona(?:s)?\b/i,
  /cost savings/i,
  /\bbenchmark(?:s)?\b/i,
  /about the name/i,
  /good first issue/i,
  /discord\.gg/i,
]) {
  check(!pattern.test(visibleMainText), `Removed launch-stage content remains: ${pattern}`);
}
check(!/\b\d+(?:\.\d+)?%/.test(visibleMainText), "Unverified percentage claim remains in visible copy");

check(textContent(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "") === expectedTitle, "Page title does not match the approved title");
check(metaContent(html, "description") === expectedDescription, "Meta description does not match the approved description");
check(expectedTitle.length <= 60, "Page title exceeds 60 characters");
check(expectedDescription.length <= 160, "Meta description exceeds 160 characters");
check(metaContent(html, "og:type") === "website", "Open Graph type must be website");
check(metaContent(html, "og:title") === expectedTitle, "Open Graph title is incorrect");
check(metaContent(html, "og:description") === expectedDescription, "Open Graph description is incorrect");
check(metaContent(html, "og:url") === "https://comis.ai/", "Open Graph URL is incorrect");
const socialImageUrl = metaContent(html, "og:image") ?? "";
check(/^https:\/\/comis\.ai\/_astro\/comis-social-preview\.[\w-]+\.png$/.test(socialImageUrl), "Open Graph image URL is incorrect");
check(metaContent(html, "og:image:type") === "image/png", "Open Graph image type is incorrect");
check(metaContent(html, "og:image:width") === "1280", "Open Graph image width is incorrect");
check(metaContent(html, "og:image:height") === "640", "Open Graph image height is incorrect");
check(metaContent(html, "og:image:alt") === "Comis logo", "Open Graph image alt text is incorrect");
check(metaContent(html, "twitter:card") === "summary_large_image", "Twitter card type is incorrect");
check(metaContent(html, "twitter:image") === socialImageUrl, "Twitter image URL must match Open Graph");
check(metaContent(html, "twitter:image:alt") === "Comis logo", "Twitter image alt text is incorrect");

const canonical = tags(html, "link")
  .map((tag) => attributes(tag))
  .find((attrs) => attrs.get("rel") === "canonical")?.get("href");
check(canonical === "https://comis.ai/", "Canonical URL is incorrect");
check(attributes(tags(html, "html")[0] ?? "").get("lang") === "en", "Document language must be English");
const remoteStylesheets = tags(html, "link")
  .map((tag) => attributes(tag))
  .filter((attrs) => attrs.get("rel") === "stylesheet" && /^https?:/.test(attrs.get("href") ?? ""));
check(remoteStylesheets.length === 0, "Fonts and stylesheets must be self-hosted");

const structuredData = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
  .flatMap((match) => {
    try {
      const parsed = JSON.parse(match[1]);
      return Array.isArray(parsed["@graph"]) ? parsed["@graph"] : [parsed];
    } catch {
      failures.push("Structured data must contain valid JSON");
      return [];
    }
  });
check(structuredData.filter((entry) => entry["@type"] === "Organization").length === 1, "Structured data must contain one Organization");
check(structuredData.filter((entry) => entry["@type"] === "WebSite").length === 1, "Structured data must contain one WebSite");
check(structuredData.filter((entry) => entry["@type"] === "SoftwareSourceCode").length === 1, "Structured data must contain one SoftwareSourceCode entry");
check(structuredData.filter((entry) => entry["@type"] === "SoftwareApplication").length === 1, "Structured data must contain one SoftwareApplication entry");
const organization = structuredData.find((entry) => entry["@type"] === "Organization");
check(organization?.logo === "https://comis.ai/android-chrome-512x512.png", "Organization logo must use the square brand mark");
sameValues(organization?.sameAs ?? [], ["https://github.com/comisai"], "Organization sameAs profiles");
const sourceCode = structuredData.find((entry) => entry["@type"] === "SoftwareSourceCode");
check(sourceCode?.codeRepository === "https://github.com/comisai/comis", "SoftwareSourceCode must reference the public repository");
check(sourceCode?.license === "https://github.com/comisai/comis/blob/main/LICENSE", "SoftwareSourceCode must reference the Apache-2.0 license");
const application = structuredData.find((entry) => entry["@type"] === "SoftwareApplication");
check(application?.downloadUrl === "https://www.npmjs.com/package/comisai", "SoftwareApplication must reference the npm distribution");
check(application?.softwareRequirements === "Node.js 22.19 or newer", "SoftwareApplication must state the supported Node.js requirement");

const anchors = tags(html, "a").map((tag) => attributes(tag));
const firstFocusable = html.match(/<(?:a|button|input|select|textarea)\b[^>]*>/i)?.[0] ?? "";
const firstFocusableAttrs = attributes(firstFocusable);
check(firstFocusableAttrs.get("href") === "#main-content" && textContent(html.slice(html.indexOf(firstFocusable), html.indexOf("</a>", html.indexOf(firstFocusable)) + 4)) === "Skip to main content", "Skip link must be the first focusable control");
check(!anchors.some((attrs) => attrs.has("target")), "Links must open in the current tab");

for (const attrs of anchors) {
  const href = decodeHtml(attrs.get("href") ?? "");
  if (href.startsWith("#")) {
    check(ids.includes(href.slice(1)), `Fragment link does not resolve: ${href}`);
  } else if (href.startsWith("http")) {
    check(approvedExternalLinks.has(href), `Unapproved external link found: ${href}`);
    try { new URL(href); } catch { failures.push(`Invalid external URL: ${href}`); }
  } else {
    check(href === "/", `Unapproved local route found: ${href}`);
  }
}
for (const href of approvedExternalLinks) {
  check(anchors.some((attrs) => decodeHtml(attrs.get("href") ?? "") === href), `Approved destination is missing: ${href}`);
}

const footerHtml = html.match(/<footer\b[\s\S]*?<\/footer>/i)?.[0] ?? "";
const footerHrefs = tags(footerHtml, "a").map((tag) => attributes(tag).get("href"));
sameValues(footerHrefs, [
  "/",
  "https://docs.comis.ai",
  "https://github.com/comisai/comis",
  "https://github.com/comisai/comis/issues",
  "https://github.com/comisai/comis/security",
  "https://github.com/comisai/comis/blob/main/LICENSE",
], "Footer links");

for (const image of tags(html, "img")) {
  const attrs = attributes(image);
  check(attrs.has("alt"), `Image is missing alt text: ${attrs.get("src") ?? "unknown"}`);
  check(Number(attrs.get("width")) > 0 && Number(attrs.get("height")) > 0, `Image is missing intrinsic dimensions: ${attrs.get("src") ?? "unknown"}`);
}
check(tags(html, "img").every((tag) => attributes(tag).get("width") === "838" && attributes(tag).get("height") === "202"), "Logo dimensions must match the source image ratio");

const workflowList = mainHtml.match(/<ol\b[^>]*class="[^"]*workflow-list[^"]*"[^>]*>[\s\S]*?<\/ol>/i)?.[0] ?? "";
check(tags(workflowList, "li").length === 5, "Workflow must be an ordered list with five steps");
const workflowHeadings = [...workflowList.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)].map((match) => textContent(match[1]));
sameValues(workflowHeadings, ["Receive", "Route", "Coordinate", "Constrain", "Explain"], "Governed workflow hierarchy");
check(!/\bautoplay\b/i.test(html), "Autoplay media is prohibited");
check(!/\btarget="_blank"/i.test(html), "New-window links are prohibited");
check(!/\btabindex="[1-9]/i.test(html), "Positive tabindex is prohibited");
check(!/\bastro-island\b/i.test(html), "Client framework hydration is prohibited");
check(/<button\b[^>]*data-copy-button[^>]*\bhidden\b/i.test(html), "Copy enhancement must be hidden without JavaScript");
check(/aria-live="polite"/i.test(html), "Copy status must use a polite live region");
const executableScripts = tags(html, "script").filter((tag) => attributes(tag).get("type") !== "application/ld+json");
check(executableScripts.length === 1, `Homepage must contain one executable clipboard script; received ${executableScripts.length}`);
check(attributes(executableScripts[0] ?? "").get("src") === "/copy-command.js", "Clipboard enhancement must load from the local static script");

const quickStartSource = await readFile(path.join(websiteDir, "public", "copy-command.js"), "utf8");
for (const label of ["Copy command", "Copied", "Copy failed", "One-line installer command copied.", "Couldn’t copy. Select the command and copy it manually."]) {
  check(quickStartSource.includes(label), `Clipboard state is missing: ${label}`);
}
const cssSource = await readFile(path.join(sourceDir, "styles", "global.css"), "utf8");
check(cssSource.includes(":focus-visible"), "Visible focus styles are missing");
check(cssSource.includes('[tabindex="0"]):focus-visible'), "Focusable command region must share the site focus treatment");
check(cssSource.includes("outline: 3px solid var(--coral)"), "Focus outline must be three-pixel coral");
check(cssSource.includes("outline-offset: 3px"), "Focus outline offset must be three pixels");
check(cssSource.includes("min-height: 44px"), "Interactive targets must retain the 44-pixel minimum");
check(cssSource.includes("prefers-reduced-motion: reduce"), "Reduced-motion handling is missing");

const socialImagePath = path.join(distDir, new URL(socialImageUrl || "https://comis.ai/invalid").pathname.replace(/^\/+/, ""));
const socialImage = await readFile(socialImagePath);
check(socialImage.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "Social image must be a genuine PNG");
check(socialImage.subarray(12, 16).toString("ascii") === "IHDR", "Social image PNG must contain an IHDR header");
check(socialImage.readUInt32BE(16) === 1280 && socialImage.readUInt32BE(20) === 640, "Social image must be 1280×640");
check((await stat(socialImagePath)).size < 250_000, "Social image must remain under 250 KB");

const imageAssets = (await listFiles(path.join(distDir, "images"))).map((file) => path.basename(file)).sort();
sameValues(imageAssets, ["comis-logo.png"], "Generated image assets");
check(!distFiles.some((file) => /\.(?:jpe?g|mp4|webm)$/i.test(file)), "Removed image or video formats remain in the build");
for (const requiredAsset of [
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon.ico",
  "apple-touch-icon.png",
  "android-chrome-192x192.png",
  "android-chrome-512x512.png",
  "site.webmanifest",
  "install.sh",
  "copy-command.js",
  "robots.txt",
  "_headers",
  "fonts/inter-latin.woff2",
  "fonts/jetbrains-mono-latin.woff2",
  "sitemap-index.xml",
  "sitemap-0.xml",
]) {
  check(distFiles.includes(path.join(distDir, requiredAsset)), `Required built asset is missing: ${requiredAsset}`);
}

const sitemapIndex = await readFile(path.join(distDir, "sitemap-index.xml"), "utf8");
sameValues([...sitemapIndex.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]), ["https://comis.ai/sitemap-0.xml"], "Sitemap index entries");
const sitemap = await readFile(path.join(distDir, "sitemap-0.xml"), "utf8");
sameValues([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]), ["https://comis.ai/"], "Sitemap routes");
const robots = await readFile(path.join(distDir, "robots.txt"), "utf8");
check(robots.includes("Sitemap: https://comis.ai/sitemap-index.xml"), "robots.txt must reference the sitemap index");

const headers = await readFile(path.join(distDir, "_headers"), "utf8");
for (const header of ["Content-Security-Policy", "Permissions-Policy", "Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options"]) {
  check(headers.includes(header), `Security header is missing: ${header}`);
}
check(!headers.includes("'unsafe-inline'"), "Content Security Policy must not allow inline scripts or styles");

const deploymentWorkflow = await readFile(path.join(websiteDir, "..", ".github", "workflows", "deploy-website.yml"), "utf8");
check(deploymentWorkflow.includes('wranglerVersion: "4.110.0"'), "Cloudflare deployment must pin the audited Wrangler release");

const packageJson = JSON.parse(await readFile(path.join(websiteDir, "package.json"), "utf8"));
sameValues(Object.keys(packageJson.dependencies).sort(), ["@astrojs/sitemap", "astro"], "Website runtime dependencies");
sameValues(Object.keys(packageJson.devDependencies).sort(), ["@tailwindcss/vite", "tailwindcss"], "Website development dependencies");
check(packageJson.dependencies.astro === "7.0.9", "Astro must stay on the audited release");

if (failures.length > 0) {
  console.error(`Website validation failed with ${failures.length} issue${failures.length === 1 ? "" : "s"}:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Website validation passed: one route, seven sections, ${wordCount} visible words, verified metadata and assets.`);
}
