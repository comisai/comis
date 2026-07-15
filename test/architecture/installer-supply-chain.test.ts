import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");
const installer = readFileSync(join(repoRoot, "website", "public", "install.sh"), "utf8");
const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");

function dockerSection(start: string, end: string): string {
  const startIndex = dockerfile.indexOf(start);
  const endIndex = dockerfile.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing Dockerfile section start: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing Dockerfile section end: ${end}`).toBeGreaterThan(startIndex);
  return dockerfile.slice(startIndex, endIndex);
}

describe("installer supply-chain downloads are versioned and integrity checked", () => {
  it("uses an immutable, checksummed Homebrew installer instead of HEAD", () => {
    expect(installer).not.toContain("Homebrew/install/HEAD/install.sh");
    expect(installer).toMatch(/HOMEBREW_INSTALL_COMMIT="[0-9a-f]{40}"/);
    expect(installer).toContain("Homebrew/install/${HOMEBREW_INSTALL_COMMIT}/install.sh");
    expect(installer).toMatch(/HOMEBREW_INSTALL_SHA256="[0-9a-f]{64}"/);
    expect(installer).toMatch(/verify_file_sha256[^\n]*HOMEBREW_INSTALL_SHA256/);
  });

  it("downloads pinned uv and rustup artifacts with embedded per-architecture checksums", () => {
    expect(installer).not.toContain("https://astral.sh/uv/install.sh");
    expect(installer).not.toContain('download_file "https://sh.rustup.rs"');
    expect(installer).toMatch(/UV_VERSION="[0-9]+\.[0-9]+\.[0-9]+"/);
    expect(installer).toMatch(/RUSTUP_VERSION="[0-9]+\.[0-9]+\.[0-9]+"/);
    expect(installer).toMatch(/verify_file_sha256 "\$uv_archive" "\$uv_sha256"/);
    expect(installer).toMatch(/verify_file_sha256 "\$rustup_bin" "\$rustup_sha256"/);
    expect(installer).toMatch(/x86_64-unknown-linux-musl/);
    expect(installer).toMatch(/aarch64-unknown-linux-musl/);
    expect(installer).toMatch(/\/lib\/ld-musl-|\/etc\/alpine-release/);
  });

  it("verifies NodeSource scripts and the standalone Node archive before execution", () => {
    expect(installer).not.toContain("https://nodejs.org/dist/latest-v22.x/");
    expect(installer).toMatch(/NODE_STANDALONE_VERSION="[0-9]+\.[0-9]+\.[0-9]+"/);
    expect(installer).toMatch(/NODESOURCE_DEB_SETUP_SHA256="[0-9a-f]{64}"/);
    expect(installer).toMatch(/NODESOURCE_RPM_SETUP_SHA256="[0-9a-f]{64}"/);
    expect(installer).toMatch(/verify_file_sha256 "\$tmp" "\$NODESOURCE_DEB_SETUP_SHA256"/);
    expect(installer).toMatch(/verify_file_sha256 "\$tmp" "\$NODESOURCE_RPM_SETUP_SHA256"/);
    expect(installer).toMatch(/verify_file_sha256 "\$tmp_dir\/\$tarball_name" "\$node_sha256"/);
  });

  it("isolates NodeSource repository file modes from a restrictive caller umask", () => {
    const helper = installer.match(/run_nodesource_setup\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(helper, "NodeSource setup must have a dedicated umask boundary").not.toBe("");
    expect(helper, "root setup must create public apt metadata under umask 022").toMatch(
      /\(\s*umask 022;\s*exec bash "\$setup_script"\s*\)/,
    );
    expect(helper, "sudo setup must create public apt metadata under umask 022").toMatch(
      /sudo -E bash -c 'umask 022; exec bash "\$1"'/,
    );

    const setupCalls = installer.match(
      /run_quiet_step "Configuring NodeSource repository" run_nodesource_setup "\$tmp"/g,
    );
    expect(setupCalls, "every root and sudo apt, dnf, and yum path must use the umask boundary").toHaveLength(6);
  });

  it("pins optional browser npm packages in both host and container installers", () => {
    for (const source of [installer, dockerfile]) {
      expect(source).toMatch(/cloakbrowser@\$?\{?CLOAKBROWSER_NPM_VERSION\}?/);
      expect(source).toMatch(/playwright-core@\$?\{?PLAYWRIGHT_CORE_NPM_VERSION\}?/);
    }
  });

  it("Docker verifies DuckDB, uv, and rustup archives before installation", () => {
    expect(dockerfile).not.toMatch(/curl[^\n]*astral\.sh\/uv\/install\.sh/);
    expect(dockerfile).not.toMatch(/curl[^\n]*sh\.rustup\.rs/);
    for (const section of [
      dockerSection('ARG COMIS_DUCKDB_VERSION=', '# Install uv/uvx'),
      dockerSection('ARG COMIS_UV_VERSION=', '# Install rustup'),
      dockerSection('ARG COMIS_RUSTUP_VERSION=', '# Daemon process must see'),
    ]) {
      expect(section).toMatch(/sha256sum -c/);
      expect(section).toMatch(/amd64\).*sha256="[0-9a-f]{64}"/);
      expect(section).toMatch(/arm64\).*sha256="[0-9a-f]{64}"/);
    }

    expect(dockerSection('ARG COMIS_DUCKDB_VERSION=', '# Install uv/uvx')).toEqual(
      expect.stringContaining("1f2fa724fb054b3dbe1a9cbd13de5b76997d850e7087ec762ba88db04e0180cf"),
    );
    expect(dockerSection('ARG COMIS_DUCKDB_VERSION=', '# Install uv/uvx')).toEqual(
      expect.stringContaining("377f03fb9f17ab5a78f28f829cbfcb5333da8ab3c2d0788f27694f81df77ed29"),
    );
    expect(dockerSection('ARG COMIS_UV_VERSION=', '# Install rustup')).toEqual(
      expect.stringContaining("56dd1b66701ecb62fe896abb919444e4b83c5e8645cca953e6ddd496ff8a0feb"),
    );
    expect(dockerSection('ARG COMIS_UV_VERSION=', '# Install rustup')).toEqual(
      expect.stringContaining("eee8dd658d20e5ac85fec9c2326b6cbc9d83a1eef09ef07433e58698ac849591"),
    );
    expect(dockerSection('ARG COMIS_RUSTUP_VERSION=', '# Daemon process must see')).toEqual(
      expect.stringContaining("20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c"),
    );
    expect(dockerSection('ARG COMIS_RUSTUP_VERSION=', '# Daemon process must see')).toEqual(
      expect.stringContaining("e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c"),
    );
  });

  it("Docker fails closed when a declared runtime dependency cannot be installed", () => {
    for (const section of [
      dockerSection('ARG COMIS_DUCKDB_VERSION=', '# Install uv/uvx'),
      dockerSection('ARG COMIS_UV_VERSION=', '# Install rustup'),
      dockerSection('ARG COMIS_RUSTUP_VERSION=', '# Daemon process must see'),
    ]) {
      expect(section).not.toMatch(/\|\|\s*echo/);
      expect(section).toMatch(/\*\).*exit 1/);
    }
  });

  it("Docker fails when the requested CloakBrowser binary cannot be downloaded", () => {
    const section = dockerSection(
      'if [ "${COMIS_WITH_CLOAKBROWSER}" = "1" ]; then',
      'rm -rf /var/cache/apt/archives',
    );
    expect(section).not.toMatch(/cloakbrowser install[^\n]*\|\|\s*true/);
    expect(section).toMatch(/if ! su - comis -c [^\n]*cloakbrowser install/);
  });

  it("the ordinary Linux install path invokes the pinned uv and rust installers", () => {
    const mainStart = installer.indexOf("\nmain() {");
    const mainEnd = installer.indexOf('\nif [[ "${COMIS_INSTALL_SH_NO_RUN:-0}"', mainStart);
    const main = installer.slice(mainStart, mainEnd);
    expect(main).toMatch(/\n\s+install_uv\s*(?:\|\|[^\n]*)?\n/);
    expect(main).toMatch(/\n\s+install_rust\s*(?:\|\|[^\n]*)?\n/);
  });
});
