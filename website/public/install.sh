#!/bin/bash
set -euo pipefail

# Comis Installer for macOS and Linux
# Usage: curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh -o comis-install.sh
#        bash comis-install.sh --dry-run

BOLD='\033[1m'
ACCENT='\033[38;2;255;107;74m'       # coral         #FF6B4A
# shellcheck disable=SC2034
ACCENT_BRIGHT='\033[38;2;255;140;110m' # lighter coral
INFO='\033[38;2;148;163;184m'        # muted         #94A3B8
SUCCESS='\033[38;2;6;182;212m'       # teal          #06B6D4
WARN='\033[38;2;255;176;32m'         # amber
ERROR='\033[38;2;229;89;58m'         # coral-dark    #E5593A
MUTED='\033[38;2;100;116;139m'       # slate         #64748B
NC='\033[0m' # No Color

DEFAULT_TAGLINE="Let agents learn and act. Keep authority in the runtime."
MIN_NODE_VERSION="22.19.0"
NODE_STANDALONE_VERSION="22.19.0"
NODESOURCE_DEB_SETUP_SHA256="575583bbac2fccc0b5edd0dbc03e222d9f9dc8d724da996d22754d6411104fd1"
NODESOURCE_RPM_SETUP_SHA256="b0ed2b9b66002e7ee802e8777cf3a92b25f1ecc0129812dc6f59a43a536810cc"
HOMEBREW_INSTALL_COMMIT="c7952e40b7957268f61643152f4db725379b292e"
HOMEBREW_INSTALL_SHA256="99287f194a8b3c9e6b0203a11a5fa54518be57209343e6bb954dec4635796d9d"
UV_VERSION="0.11.8"
RUSTUP_VERSION="1.28.2"
RUST_TOOLCHAIN_VERSION="1.95.0"
CLOAKBROWSER_NPM_VERSION="0.4.10"
PLAYWRIGHT_CORE_NPM_VERSION="1.61.1"

ORIGINAL_PATH="${PATH:-}"

# Automation launchers may omit HOME. Bash can still resolve the invoking
# account's home through tilde expansion, which keeps all user-scoped paths
# anchored to the operating-system account instead of an arbitrary fallback.
if [[ -z "${HOME:-}" ]]; then
    resolved_invoking_home="$(cd ~ 2>/dev/null && pwd -P)" || true
    if [[ -z "$resolved_invoking_home" || "$resolved_invoking_home" != /* ]]; then
        printf 'Unable to resolve the invoking account home directory\n' >&2
        exit 1
    fi
    export HOME="$resolved_invoking_home"
fi

INSTALLER_TMPDIR="$(mktemp -d)"
chmod 0700 "$INSTALLER_TMPDIR"
TMPFILES=("$INSTALLER_TMPDIR")
cleanup_tmpfiles() {
    local f
    for f in "${TMPFILES[@]:-}"; do
        rm -rf "$f" 2>/dev/null || true
    done
}
trap cleanup_tmpfiles EXIT

mktempfile() {
    mktemp "${INSTALLER_TMPDIR}/file.XXXXXX"
}

resolve_brew_bin() {
    local brew_bin=""
    brew_bin="$(command -v brew 2>/dev/null || true)"
    if [[ -n "$brew_bin" ]]; then
        echo "$brew_bin"
        return 0
    fi
    if [[ -x "/opt/homebrew/bin/brew" ]]; then
        echo "/opt/homebrew/bin/brew"
        return 0
    fi
    if [[ -x "/usr/local/bin/brew" ]]; then
        echo "/usr/local/bin/brew"
        return 0
    fi
    return 1
}

activate_brew_for_session() {
    local brew_bin=""
    brew_bin="$(resolve_brew_bin || true)"
    if [[ -z "$brew_bin" ]]; then
        return 1
    fi
    if [[ -z "$(command -v brew 2>/dev/null || true)" && "${BREW_SHELLENV_ANNOUNCED:-0}" != "1" ]]; then
        ui_info "Found Homebrew at ${brew_bin}; exporting shellenv"
        BREW_SHELLENV_ANNOUNCED=1
    fi
    eval "$("$brew_bin" shellenv)"
    return 0
}

DOWNLOADER=""
detect_downloader() {
    if command -v curl &> /dev/null; then
        DOWNLOADER="curl"
        return 0
    fi
    if command -v wget &> /dev/null; then
        DOWNLOADER="wget"
        return 0
    fi
    ui_error "Missing downloader (curl or wget required)"
    exit 1
}

download_file() {
    local url="$1"
    local output="$2"
    if [[ -z "$DOWNLOADER" ]]; then
        detect_downloader
    fi
    if [[ "$DOWNLOADER" == "curl" ]]; then
        curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 1 --retry-connrefused -o "$output" "$url"
        return
    fi
    wget -q --https-only --secure-protocol=TLSv1_2 --tries=3 --timeout=20 -O "$output" "$url"
}

GUM_VERSION="${COMIS_GUM_VERSION:-0.17.0}"
GUM=""
GUM_STATUS="skipped"
GUM_REASON=""
LAST_NPM_INSTALL_CMD=""

is_non_interactive_shell() {
    if [[ "${NO_PROMPT:-0}" == "1" ]]; then
        return 0
    fi
    if [[ ! -t 0 || ! -t 1 ]]; then
        return 0
    fi
    return 1
}

gum_is_tty() {
    if [[ -n "${NO_COLOR:-}" ]]; then
        return 1
    fi
    if [[ "${TERM:-dumb}" == "dumb" ]]; then
        return 1
    fi
    if [[ -t 2 || -t 1 ]]; then
        return 0
    fi
    if (echo -n "" > /dev/tty) 2>/dev/null; then
        return 0
    fi
    return 1
}

gum_detect_os() {
    case "$(uname -s 2>/dev/null || true)" in
        Darwin) echo "Darwin" ;;
        Linux) echo "Linux" ;;
        *) echo "unsupported" ;;
    esac
}

gum_detect_arch() {
    case "$(uname -m 2>/dev/null || true)" in
        x86_64|amd64) echo "x86_64" ;;
        arm64|aarch64) echo "arm64" ;;
        i386|i686) echo "i386" ;;
        armv7l|armv7) echo "armv7" ;;
        armv6l|armv6) echo "armv6" ;;
        *) echo "unknown" ;;
    esac
}

verify_sha256sum_file() {
    local checksums="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum --ignore-missing -c "$checksums" >/dev/null 2>&1
        return $?
    fi
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 --ignore-missing -c "$checksums" >/dev/null 2>&1
        return $?
    fi
    return 1
}

verify_file_sha256() {
    local file="$1"
    local expected="$2"
    local actual=""
    if command -v sha256sum >/dev/null 2>&1; then
        actual="$(sha256sum "$file" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
        actual="$(shasum -a 256 "$file" | awk '{print $1}')"
    else
        return 1
    fi
    [[ "$actual" == "$expected" ]]
}

bootstrap_gum_temp() {
    GUM=""
    GUM_STATUS="skipped"
    GUM_REASON=""

    if is_non_interactive_shell; then
        GUM_REASON="non-interactive shell (auto-disabled)"
        return 1
    fi

    if ! gum_is_tty; then
        GUM_REASON="terminal does not support gum UI"
        return 1
    fi

    if command -v gum >/dev/null 2>&1; then
        GUM="gum"
        GUM_STATUS="found"
        GUM_REASON="already installed"
        return 0
    fi

    if ! command -v tar >/dev/null 2>&1; then
        GUM_REASON="tar not found"
        return 1
    fi

    local os arch asset base gum_tmpdir gum_path
    os="$(gum_detect_os)"
    arch="$(gum_detect_arch)"
    if [[ "$os" == "unsupported" || "$arch" == "unknown" ]]; then
        GUM_REASON="unsupported os/arch ($os/$arch)"
        return 1
    fi

    asset="gum_${GUM_VERSION}_${os}_${arch}.tar.gz"
    base="https://github.com/charmbracelet/gum/releases/download/v${GUM_VERSION}"

    gum_tmpdir="$(mktemp -d)"
    TMPFILES+=("$gum_tmpdir")

    if ! download_file "${base}/${asset}" "$gum_tmpdir/$asset"; then
        GUM_REASON="download failed"
        return 1
    fi

    if ! download_file "${base}/checksums.txt" "$gum_tmpdir/checksums.txt"; then
        GUM_REASON="checksum unavailable or failed"
        return 1
    fi

    if ! (cd "$gum_tmpdir" && verify_sha256sum_file "checksums.txt"); then
        GUM_REASON="checksum unavailable or failed"
        return 1
    fi

    if ! tar -xzf "$gum_tmpdir/$asset" -C "$gum_tmpdir" >/dev/null 2>&1; then
        GUM_REASON="extract failed"
        return 1
    fi

    gum_path="$(find "$gum_tmpdir" -type f -name gum 2>/dev/null | head -n1 || true)"
    if [[ -z "$gum_path" ]]; then
        GUM_REASON="gum binary missing after extract"
        return 1
    fi

    chmod +x "$gum_path" >/dev/null 2>&1 || true
    if [[ ! -x "$gum_path" ]]; then
        GUM_REASON="gum binary is not executable"
        return 1
    fi

    GUM="$gum_path"
    GUM_STATUS="installed"
    GUM_REASON="temp, verified"
    return 0
}

print_gum_status() {
    case "$GUM_STATUS" in
        found)
            ui_success "gum available (${GUM_REASON})"
            ;;
        installed)
            ui_success "gum bootstrapped (${GUM_REASON}, v${GUM_VERSION})"
            ;;
        *)
            if [[ -n "$GUM_REASON" && "$GUM_REASON" != "non-interactive shell (auto-disabled)" ]]; then
                ui_info "gum skipped (${GUM_REASON})"
            fi
            ;;
    esac
}

print_installer_banner() {
    if [[ -n "$GUM" ]]; then
        local title tagline hint card
        title="$("$GUM" style --foreground "#FF6B4A" --bold "Comis Installer")"
        tagline="$("$GUM" style --foreground "#94A3B8" "$TAGLINE")"
        hint="$("$GUM" style --foreground "#64748B" "modern installer mode")"
        card="$(printf '%s\n%s\n%s' "$title" "$tagline" "$hint")"
        "$GUM" style --border rounded --border-foreground "#FF6B4A" --padding "1 2" "$card"
        echo ""
        return
    fi

    echo ""
    echo -e "  ${BOLD}${SUCCESS}C${ACCENT}O${SUCCESS}M${ACCENT}I${SUCCESS}S${NC} ${MUTED}Installer${NC}"
    echo -e "  ${MUTED}${TAGLINE}${NC}"
    echo ""
}

detect_os_or_die() {
    OS="unknown"
    DISTRO="unknown"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macos"
        DISTRO="macos"
    elif [[ "$OSTYPE" == linux* ]] || [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
        OS="linux"
        if [[ -f /etc/os-release ]]; then
            # shellcheck disable=SC1091
            . /etc/os-release
            DISTRO="${ID:-unknown}"
        fi
    elif [[ "$OSTYPE" == cygwin* ]] || [[ "$OSTYPE" == msys* ]] || [[ "$OSTYPE" == mingw* ]]; then
        ui_error "Windows detected"
        echo "This installer is for macOS and Linux."
        echo "On Windows, install Node.js >=${MIN_NODE_VERSION} from https://nodejs.org, then run:"
        echo "  npm install -g comisai"
        exit 1
    fi

    if [[ "$OS" == "unknown" ]]; then
        ui_error "Unsupported operating system"
        echo "This installer supports macOS and Linux (including WSL)."
        exit 1
    fi

    ui_success "Detected: $OS ($DISTRO)"
}

ui_info() {
    local msg="$*"
    if [[ -n "$GUM" ]]; then
        "$GUM" log --level info "$msg"
    else
        echo -e "  ${MUTED}·${NC} ${msg}"
    fi
}

ui_warn() {
    local msg="$*"
    if [[ -n "$GUM" ]]; then
        "$GUM" log --level warn "$msg"
    else
        echo -e "  ${WARN}⚠${NC} ${msg}"
    fi
}

ui_success() {
    local msg="$*"
    if [[ -n "$GUM" ]]; then
        local mark
        mark="$("$GUM" style --foreground "#06B6D4" --bold "✓")"
        echo "  ${mark} ${msg}"
    else
        echo -e "  ${SUCCESS}✓${NC} ${msg}"
    fi
}

ui_error() {
    local msg="$*"
    if [[ -n "$GUM" ]]; then
        "$GUM" log --level error "$msg"
    else
        echo -e "  ${ERROR}✗${NC} ${msg}"
    fi
}

INSTALL_STAGE_TOTAL=4
INSTALL_STAGE_CURRENT=0

ui_section() {
    local title="$1"
    if [[ -n "$GUM" ]]; then
        "$GUM" style --bold --foreground "#06B6D4" --padding "1 0" "$title"
    else
        echo ""
        echo -e "  ${SUCCESS}${BOLD}${title}${NC}"
    fi
}

ui_stage() {
    local title="$1"
    INSTALL_STAGE_CURRENT=$((INSTALL_STAGE_CURRENT + 1))
    ui_section "[${INSTALL_STAGE_CURRENT}/${INSTALL_STAGE_TOTAL}] ${title}"
}

ui_kv() {
    local key="$1"
    local value="$2"
    if [[ -n "$GUM" ]]; then
        local key_part value_part
        key_part="$("$GUM" style --foreground "#64748B" --width 20 "$key")"
        value_part="$("$GUM" style --bold "$value")"
        "$GUM" join --horizontal "$key_part" "$value_part"
    else
        echo -e "  ${MUTED}${key}${NC}  ${BOLD}${value}${NC}"
    fi
}

ui_panel() {
    local content="$1"
    if [[ -n "$GUM" ]]; then
        "$GUM" style --border rounded --border-foreground "#64748B" --padding "0 1" "$content"
    else
        echo "$content"
    fi
}

planned_data_directory() {
    local target_home="$HOME"
    if should_create_dedicated_user; then
        target_home=""
        if command -v getent >/dev/null 2>&1; then
            target_home="$(getent passwd "$COMIS_USER" 2>/dev/null | cut -d: -f6 || true)"
        fi
        if [[ -z "$target_home" ]]; then
            target_home="/home/${COMIS_USER}"
        fi
    fi
    printf '%s/.comis\n' "$target_home"
}

show_install_plan() {
    local detected_checkout="$1"
    local package_target=""
    local browser_runtime="disabled"
    local egress_logging="disabled (no iptables changes; opt in with COMIS_ENABLE_EGRESS_LOGGING=1)"

    ui_section "Install plan"
    ui_kv "OS" "$OS"
    ui_kv "Install method" "$INSTALL_METHOD"
    if [[ -n "$COMIS_TARBALL" ]]; then
        package_target="local tarball: ${COMIS_TARBALL}"
    elif [[ "$INSTALL_METHOD" == "npm" && "$USE_BETA" == "1" ]]; then
        package_target="comisai@beta (falls back to comisai@latest)"
    elif [[ "$INSTALL_METHOD" == "npm" ]]; then
        package_target="comisai@${COMIS_VERSION}"
    elif [[ -n "$detected_checkout" ]]; then
        package_target="local source checkout: ${detected_checkout}"
    else
        package_target="https://github.com/comisai/comis.git -> ${GIT_DIR}"
    fi
    ui_kv "Package target" "$package_target"
    ui_kv "Node.js requirement" ">=${MIN_NODE_VERSION}"
    if [[ "$USE_BETA" == "1" ]]; then
        ui_kv "Beta channel" "enabled"
    fi
    if [[ "$INSTALL_METHOD" == "git" ]]; then
        ui_kv "Git directory" "$GIT_DIR"
        ui_kv "Git update" "$GIT_UPDATE"
        if [[ "$GIT_UPDATE" == "1" ]]; then
            ui_kv "Local changes" "auto-stashed before pull, then restored"
        fi
    fi
    if [[ -n "$detected_checkout" ]]; then
        ui_kv "Detected checkout" "$detected_checkout"
    fi
    if should_create_dedicated_user; then
        ui_kv "Run as user" "$COMIS_USER"
    fi
    if [[ -n "${RESOLVED_SERVICE_MANAGER:-}" ]]; then
        ui_kv "Service manager" "$RESOLVED_SERVICE_MANAGER"
    fi
    if [[ "$WITH_BROWSER" == "1" && "$WITH_CLOAKBROWSER" == "1" ]]; then
        browser_runtime="CloakBrowser"
    elif [[ "$WITH_BROWSER" == "1" && "$WITH_XVFB" == "1" ]]; then
        browser_runtime="Chromium + Xvfb headed runtime"
    elif [[ "$WITH_BROWSER" == "1" ]]; then
        browser_runtime="Chromium headless runtime"
    fi
    ui_kv "Browser runtime" "$browser_runtime"
    if [[ "$ENABLE_EGRESS_LOGGING" == "1" ]]; then
        if should_create_dedicated_user; then
            egress_logging="enabled (rate-limited iptables LOG+ACCEPT; outbound packet metadata enters kernel logs)"
        else
            egress_logging="requested (applies only to Linux systemd with a dedicated user)"
        fi
    fi
    ui_kv "Egress logging" "$egress_logging"
    ui_kv "Data directory" "$(planned_data_directory)"
    ui_kv "Host changes" "CLI, dependencies, runtime, and selected service as needed"
    ui_kv "Downloads" "npm/GitHub and OS/runtime package sources as needed"
    if [[ "$NO_AUTOSTART" == "1" ]]; then
        ui_kv "Boot persistence" "disabled (--no-autostart)"
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
        ui_kv "Dry run" "yes"
    fi
    if [[ "$NO_INIT" == "1" ]]; then
        ui_kv "Init" "skipped"
    fi
    ui_info "No installation changes have been made. Use --dry-run to stop after this plan."
}

show_footer_links() {
    local docs_url="https://docs.comis.ai"
    if [[ -n "$GUM" ]]; then
        local content
        content="$(printf '%s\n%s' "Need help?" "Docs: ${docs_url}")"
        ui_panel "$content"
    else
        echo ""
        echo -e "Docs: ${INFO}${docs_url}${NC}"
    fi
}

needs_shell_reload() {
    local bin_dir=""
    if [[ "$INSTALL_METHOD" == "git" ]]; then
        bin_dir="$HOME/.local/bin"
    else
        bin_dir="$(npm_global_bin_dir 2>/dev/null || true)"
    fi
    if [[ -z "$bin_dir" ]]; then
        return 1
    fi
    ! path_has_dir "$ORIGINAL_PATH" "$bin_dir"
}

show_next_step() {
    local cmd="$1"
    local hint="${2:-}"
    local reload=false
    if needs_shell_reload; then
        reload=true
    fi
    echo ""
    if [[ -n "$GUM" ]]; then
        local lines=()
        if [[ "$reload" == "true" ]]; then
            lines+=("$("$GUM" style --foreground "#FFB020" "  Open a new terminal, then:")")
        fi
        lines+=("$("$GUM" style --bold --foreground "#06B6D4" "  $ ${cmd}")")
        if [[ -n "$hint" ]]; then
            lines+=("$("$GUM" style --foreground "#94A3B8" "  ${hint}")")
        fi
        local body=""
        body="$(printf '%s\n' "Next step:" "${lines[@]}")"
        "$GUM" style --border rounded --border-foreground "#FF6B4A" --padding "0 2" "$body"
    else
        echo -e "${ACCENT}${BOLD}Next step:${NC}"
        if [[ "$reload" == "true" ]]; then
            echo -e "  ${WARN}Open a new terminal, then:${NC}"
        fi
        echo -e "  ${SUCCESS}\$ ${cmd}${NC}"
        if [[ -n "$hint" ]]; then
            echo -e "  ${MUTED}${hint}${NC}"
        fi
    fi
    echo ""
}

ui_celebrate() {
    local msg="$1"
    if [[ -n "$GUM" ]]; then
        "$GUM" style --bold --foreground "#06B6D4" "$msg"
    else
        echo -e "  ${SUCCESS}${BOLD}${msg}${NC}"
    fi
}

is_shell_function() {
    local name="${1:-}"
    [[ -n "$name" ]] && declare -F "$name" >/dev/null 2>&1
}

run_with_spinner() {
    local title="$1"
    shift

    if [[ -n "$GUM" ]] && gum_is_tty && ! is_shell_function "${1:-}"; then
        local gum_err rc_file cmd_quoted rc_quoted gum_status wrapped_rc
        gum_err="$(mktempfile)"
        rc_file="$(mktempfile)"
        rm -f "$rc_file"
        printf -v cmd_quoted '%q ' "$@"
        printf -v rc_quoted '%q' "$rc_file"
        gum_status=0
        "$GUM" spin --spinner dot --title "$title" -- \
            bash -c "${cmd_quoted}; printf %s \$? >${rc_quoted}" 2>"$gum_err" || gum_status=$?
        # The sentinel is the ground truth for the step's outcome - gum's own
        # exit code is not. A gum that cannot drive the terminal can exit 0
        # without running the command at all, and a swallowed non-zero here
        # turns a failed step into a green checkmark.
        wrapped_rc="$(cat "$rc_file" 2>/dev/null || true)"
        rm -f "$rc_file" 2>/dev/null || true
        if [[ "$wrapped_rc" =~ ^[0-9]+$ ]]; then
            return "$wrapped_rc"
        fi
        if [[ "$gum_status" -eq 130 || "$gum_status" -eq 143 ]]; then
            # Interrupted (SIGINT/SIGTERM) - don't rerun the command
            return "$gum_status"
        fi
        # No sentinel: gum never ran the command (raw mode / ioctl / TTY init
        # failure). Disable it for the rest of the install and run spinner-less.
        GUM=""
        GUM_STATUS="skipped"
        GUM_REASON="gum could not run in this terminal"
        if [[ -s "$gum_err" ]]; then
            cat "$gum_err" >&2
        fi
        ui_warn "Spinner unavailable in this terminal; continuing without spinner"
        "$@"
        return $?
    fi

    "$@"
}

SPINNER_FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
SPINNER_PID=""

start_spinner() {
    local title="$1"
    (
        local i=0
        while true; do
            printf '\r  %b %s...' "${SUCCESS}${SPINNER_FRAMES[$i]}${NC}" "$title"
            i=$(( (i + 1) % ${#SPINNER_FRAMES[@]} ))
            sleep 0.1
        done
    ) &
    SPINNER_PID=$!
}

stop_spinner() {
    local title="$1"
    local ok="${2:-true}"
    if [[ -n "$SPINNER_PID" ]]; then
        kill "$SPINNER_PID" 2>/dev/null
        wait "$SPINNER_PID" 2>/dev/null || true
        SPINNER_PID=""
    fi
    if [[ "$ok" == "true" ]]; then
        printf '\r  %b %s   \n' "${SUCCESS}✓${NC}" "$title"
    else
        printf '\r  %b %s   \n' "${ERROR}✗${NC}" "$title"
    fi
}

run_quiet_step() {
    local title="$1"
    shift

    if [[ "$VERBOSE" == "1" ]]; then
        run_with_spinner "$title" "$@"
        return $?
    fi

    local log
    log="$(mktempfile)"

    if [[ -n "$GUM" ]] && gum_is_tty && ! is_shell_function "${1:-}"; then
        local cmd_quoted=""
        local log_quoted=""
        printf -v cmd_quoted '%q ' "$@"
        printf -v log_quoted '%q' "$log"
        if run_with_spinner "$title" bash -c "${cmd_quoted}>${log_quoted} 2>&1"; then
            return 0
        fi
    else
        start_spinner "$title"
        "$@" >"$log" 2>&1
        local rc=$?
        if [[ "$rc" -eq 0 ]]; then
            stop_spinner "$title" true
            return 0
        fi
        stop_spinner "$title" false
    fi

    if [[ -s "$log" ]]; then
        tail -n 20 "$log" >&2 || true
    fi
    ui_error "${title} failed - re-run with --verbose for details"
    return 1
}

cleanup_npm_comis_paths() {
    local npm_root=""
    npm_root="$(npm root -g 2>/dev/null || true)"
    if [[ -z "$npm_root" || "$npm_root" != *node_modules* ]]; then
        return 1
    fi
    rm -rf "$npm_root"/.comisai-* "$npm_root"/comisai 2>/dev/null || true
}

extract_comis_conflict_path() {
    local log="$1"
    local path=""
    path="$(sed -n 's/.*File exists: //p' "$log" | head -n1)"
    if [[ -z "$path" ]]; then
        path="$(sed -n 's/.*EEXIST: file already exists, //p' "$log" | head -n1)"
    fi
    if [[ -n "$path" ]]; then
        echo "$path"
        return 0
    fi
    return 1
}

cleanup_comis_bin_conflict() {
    local bin_path="$1"
    if [[ -z "$bin_path" || ( ! -e "$bin_path" && ! -L "$bin_path" ) ]]; then
        return 1
    fi
    local npm_bin=""
    npm_bin="$(npm_global_bin_dir 2>/dev/null || true)"
    if [[ -n "$npm_bin" && "$bin_path" != "$npm_bin/comis" ]]; then
        case "$bin_path" in
            "/opt/homebrew/bin/comis"|"/usr/local/bin/comis")
                ;;
            *)
                return 1
                ;;
        esac
    fi
    if [[ -L "$bin_path" ]]; then
        local target=""
        target="$(readlink "$bin_path" 2>/dev/null || true)"
        if [[ "$target" == *"/node_modules/comisai/"* ]]; then
            rm -f "$bin_path"
            ui_info "Removed stale comis symlink at ${bin_path}"
            return 0
        fi
        return 1
    fi
    local backup=""
    backup="${bin_path}.bak-$(date +%Y%m%d-%H%M%S)"
    if mv "$bin_path" "$backup"; then
        ui_info "Moved existing comis binary to ${backup}"
        return 0
    fi
    return 1
}

npm_log_indicates_missing_build_tools() {
    local log="$1"
    if [[ -z "$log" || ! -f "$log" ]]; then
        return 1
    fi

    grep -Eiq "(not found: make|make: command not found|cmake: command not found|CMAKE_MAKE_PROGRAM is not set|Could not find CMAKE|gyp ERR! find Python|no developer tools were found|is not able to compile a simple test program|It seems that \"make\" is not installed in your system|It seems that the used \"cmake\" doesn't work properly)" "$log"
}

wait_for_apt_lock() {
    # On fresh VPS, unattended-upgrades often holds the dpkg lock.
    # Wait up to 120 seconds for it to finish.
    local waited=0
    while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do
        if [[ "$waited" -eq 0 ]]; then
            ui_info "Waiting for unattended-upgrades to finish..."
        fi
        sleep 5
        waited=$((waited + 5))
        if [[ "$waited" -ge 120 ]]; then
            ui_warn "dpkg lock still held after 120s - trying anyway"
            break
        fi
    done
}

install_build_tools_linux() {
    require_sudo
    export DEBIAN_FRONTEND=noninteractive

    if command -v apt-get &> /dev/null; then
        wait_for_apt_lock
        # python3-venv: agent exec tool needs venvs for pip installs
        # ffmpeg: media processing (TTS, audio/video)
        # bubblewrap: sandbox for secure command execution
        # tmux: durable terminal-driver sessions (drive.durable, default on) run inside a
        #   detached tmux server so they SURVIVE a daemon restart (re-attach by name);
        #   absent ⇒ graceful degrade to a non-durable pty drive + a logged WARN
        # pipx, golang-go: agent exec sandbox toolchain coverage (pipx for Python CLIs
        #   that don't fit uvx's ephemeral-run model; golang-go for `go install`)
        # ca-certificates curl wget unzip xz-utils bzip2: required by language installers
        #   (rustup, pipx, go modules, npm tarballs, deno, bun) inside bwrap; missing any
        #   one of these causes silent TLS failures or mid-extraction crashes
        local apt_pkgs="build-essential python3 python3-venv python3-pip pipx make g++ cmake pkg-config ffmpeg bubblewrap tmux golang-go ca-certificates curl wget unzip xz-utils bzip2"
        if is_root; then
            run_quiet_step "Updating package index" apt-get update || ui_warn "Package index update had errors (continuing)"
            run_quiet_step "Installing system packages" apt-get install -y -qq $apt_pkgs
        else
            run_quiet_step "Updating package index" sudo apt-get update || ui_warn "Package index update had errors (continuing)"
            run_quiet_step "Installing system packages" sudo apt-get install -y -qq $apt_pkgs
        fi
        apply_apparmor_bwrap_profile
        return 0
    fi

    if command -v dnf &> /dev/null; then
        if is_root; then
            run_quiet_step "Installing system packages" dnf install -y gcc gcc-c++ make cmake pkgconf-pkg-config python3 python3-pip ffmpeg bubblewrap tmux systemd-devel golang pipx unzip xz ca-certificates curl wget
        else
            run_quiet_step "Installing system packages" sudo dnf install -y gcc gcc-c++ make cmake pkgconf-pkg-config python3 python3-pip ffmpeg bubblewrap tmux systemd-devel golang pipx unzip xz ca-certificates curl wget
        fi
        return 0
    fi

    if command -v yum &> /dev/null; then
        if is_root; then
            run_quiet_step "Installing system packages" yum install -y gcc gcc-c++ make cmake pkgconf-pkg-config python3 python3-pip ffmpeg bubblewrap tmux systemd-devel golang pipx unzip xz ca-certificates curl wget
        else
            run_quiet_step "Installing system packages" sudo yum install -y gcc gcc-c++ make cmake pkgconf-pkg-config python3 python3-pip ffmpeg bubblewrap tmux systemd-devel golang pipx unzip xz ca-certificates curl wget
        fi
        return 0
    fi

    if command -v apk &> /dev/null; then
        if is_root; then
            run_quiet_step "Installing build tools" apk add --no-cache build-base python3 py3-pipx go cmake unzip xz ca-certificates curl wget
        else
            run_quiet_step "Installing build tools" sudo apk add --no-cache build-base python3 py3-pipx go cmake unzip xz ca-certificates curl wget
        fi
        return 0
    fi

    ui_warn "Could not detect package manager for auto-installing build tools"
    return 1
}

# xvfb_present
# ------------
# Ground truth for whether the Xvfb runtime exists. The companion unit's
# ExecStart uses /usr/bin/Xvfb, so managed headed mode is impossible without it.
# Service-manager capability is checked separately: systemd-user cannot own the
# system companion and downshifts even when the binary is present.
xvfb_present() {
    [[ -x /usr/bin/Xvfb ]] || command -v Xvfb >/dev/null 2>&1
}

# install_xvfb_pkg <install-cmd...>
# --------------------------------
# Install the Xvfb package for HEADED mode. Best-effort UPGRADE, never a hard
# requirement: if the install fails (or the binary still isn't present after),
# downshift WITH_XVFB=0 so the rest of the install treats this as a headless
# browser - the browser tool then works with the Chromium installed just above,
# just without headed mode. Called only when WITH_XVFB is set.
install_xvfb_pkg() {
    [[ "$WITH_XVFB" == "1" ]] || return 0
    run_quiet_step "Installing Xvfb (headed mode)" "$@" && xvfb_present && return 0
    WITH_XVFB=0
    ui_warn "Xvfb install failed - falling back to headless Chromium (browser tool still works; headed mode disabled)"
}

# install_browser_deps_linux
# --------------------------
# Install the Chromium runtime that packages/skills/src/tools/browser uses.
# Idempotent - apt/dnf/yum/apk skip already-installed packages. The browser is
# on-by-default (the browser tool ships enabled); only skipped by --without-browser.
#
# Stock-Chromium path. If you adopt CloakBrowser instead, swap the Chromium
# package out for `cloakbrowser` (npm/pip) - the shared libs below are still
# required either way (CloakBrowser is a patched Chromium, not a static AppImage).
install_browser_deps_linux() {
    [[ "$WITH_BROWSER" == "1" ]] || return 0
    [[ "$OS" == "linux" ]] || return 0

    export DEBIAN_FRONTEND=noninteractive
    local sudo_cmd=""
    is_root || sudo_cmd="sudo"

    if command -v apt-get &> /dev/null; then
        wait_for_apt_lock
        # Headless shared libs needed regardless of which browser we end up
        # with. Ubuntu 24.04 (noble) renamed several libs in the time_t-64bit
        # transition: libasound2 → libasound2t64, libatk1.0-0 → libatk1.0-0t64,
        # libatk-bridge2.0-0 → ...t64, libatspi2.0-0 → ...t64, libcups2 → ...t64.
        # Provides: works for *resolving* old names already-depended-on but
        # `apt install libasound2` directly fails on noble (no such package).
        # Pick the actual installable name for each.
        local _pick_pkg
        _pick_pkg() {
            local base="$1"
            local cand
            cand="$(apt-cache policy "$base" 2>/dev/null | awk '/Candidate:/{print $2; exit}')"
            if [[ -n "$cand" && "$cand" != "(none)" ]]; then
                printf '%s' "$base"
                return
            fi
            cand="$(apt-cache policy "${base}t64" 2>/dev/null | awk '/Candidate:/{print $2; exit}')"
            if [[ -n "$cand" && "$cand" != "(none)" ]]; then
                printf '%s' "${base}t64"
            fi
            # Empty output if neither exists - apt-get drops it from the list.
        }
        local apt_browser_libs=""
        for base in libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
                    libatspi2.0-0 libcups2 libxkbcommon0 libxcomposite1 \
                    libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 \
                    libpango-1.0-0 libcairo2 libdrm2 fonts-liberation \
                    fonts-noto-color-emoji libasound2; do
            local resolved
            resolved="$(_pick_pkg "$base")"
            [[ -n "$resolved" ]] && apt_browser_libs="${apt_browser_libs} ${resolved}"
        done
        run_quiet_step "Installing browser shared libs" \
            $sudo_cmd apt-get install -y -qq $apt_browser_libs || \
            ui_warn "Browser shared-lib install had errors"

        local installed_browser=""

        # When --with-cloakbrowser is set, skip the Chrome install - the
        # binary will come from CloakBrowser via npm, installed for the
        # service user by install_cloakbrowser() after the user exists.
        # We still need the headless shared libs (installed above) and Xvfb
        # if requested.
        if [[ "$WITH_CLOAKBROWSER" == "1" ]]; then
            ui_info "CloakBrowser mode - Chrome install skipped (binary comes via npm later)"
            install_xvfb_pkg $sudo_cmd apt-get install -y -qq xvfb
            return 0
        fi

        # Browser binary. On Ubuntu 24.04 (noble) and newer, the `chromium`
        # deb is gone - only a snap-shim `chromium-browser` exists. Snap
        # chromium under systemd ProtectHome=read-only is unreliable, so on
        # apt systems we prefer the real Google Chrome deb (which Comis's
        # findChrome() probes at /usr/bin/google-chrome*).
        local chromium_candidate=""
        chromium_candidate="$(apt-cache policy chromium 2>/dev/null | awk '/Candidate:/{print $2; exit}')"
        if [[ -n "$chromium_candidate" && "$chromium_candidate" != "(none)" ]]; then
            if run_quiet_step "Installing Chromium" \
                $sudo_cmd apt-get install -y -qq chromium; then
                installed_browser="chromium"
            fi
        fi
        if [[ -z "$installed_browser" ]]; then
            ui_info "No real Chromium deb available; installing Google Chrome"
            # Pin the apt repo via a signed-by keyring so we don't pollute the
            # global trust store. The systemd unit's findChrome() walks Chrome,
            # Brave, Edge, Chromium in that order - Chrome wins.
            $sudo_cmd install -d -m 0755 /etc/apt/keyrings
            if curl -fsSL --proto '=https' --tlsv1.2 \
                https://dl.google.com/linux/linux_signing_key.pub \
                | $sudo_cmd gpg --dearmor --yes -o /etc/apt/keyrings/google-chrome.gpg 2>/dev/null; then
                $sudo_cmd chmod 0644 /etc/apt/keyrings/google-chrome.gpg
                echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
                    | $sudo_cmd tee /etc/apt/sources.list.d/google-chrome.list >/dev/null
                $sudo_cmd chmod 0644 /etc/apt/sources.list.d/google-chrome.list
                if run_quiet_step "Updating Google Chrome repository" \
                    $sudo_cmd apt-get update -qq; then
                    if run_quiet_step "Installing Google Chrome" \
                        $sudo_cmd apt-get install -y -qq google-chrome-stable; then
                        installed_browser="google-chrome"
                    fi
                fi
            fi
        fi
        if [[ -z "$installed_browser" ]]; then
            ui_warn "No Chromium/Chrome could be installed - browser tool will not start"
        fi
        # Some Debian/Ubuntu releases ship the binary as `chromium-browser`;
        # chrome-detection.ts probes both, but keep a symlink for predictability.
        if [[ ! -x /usr/bin/chromium && -x /usr/bin/chromium-browser ]]; then
            $sudo_cmd ln -sf /usr/bin/chromium-browser /usr/bin/chromium || true
        fi
        install_xvfb_pkg $sudo_cmd apt-get install -y -qq xvfb
        return 0
    fi

    if command -v dnf &> /dev/null; then
        run_quiet_step "Installing browser runtime" $sudo_cmd dnf install -y \
            chromium nss nspr atk at-spi2-atk at-spi2-core cups-libs libdrm \
            libxkbcommon mesa-libgbm pango cairo alsa-lib liberation-fonts \
            google-noto-emoji-color-fonts || \
            ui_warn "Browser dep install had errors"
        install_xvfb_pkg $sudo_cmd dnf install -y xorg-x11-server-Xvfb
        return 0
    fi

    if command -v yum &> /dev/null; then
        run_quiet_step "Installing browser runtime" $sudo_cmd yum install -y \
            chromium nss nspr atk at-spi2-atk at-spi2-core cups-libs libdrm \
            libxkbcommon mesa-libgbm pango cairo alsa-lib liberation-fonts || \
            ui_warn "Browser dep install had errors"
        install_xvfb_pkg $sudo_cmd yum install -y xorg-x11-server-Xvfb
        return 0
    fi

    if command -v apk &> /dev/null; then
        run_quiet_step "Installing browser runtime" $sudo_cmd apk add --no-cache \
            chromium nss freetype harfbuzz ca-certificates ttf-freefont \
            font-noto-emoji || ui_warn "Browser dep install had errors"
        install_xvfb_pkg $sudo_cmd apk add --no-cache xvfb
        return 0
    fi

    ui_warn "No supported package manager for browser deps; install Chromium + libs manually"
    return 1
}

# install_cloakbrowser
# --------------------
# Install the CloakBrowser npm wrapper + alternative Chromium runtime into the
# current user's $HOME. Only meaningful when --with-cloakbrowser is set.
# Must run AS the user the daemon will run as so the cache lands at the
# right ~/.cloakbrowser/ path that chrome-detection.ts probes.
#
# Skipped when:
#   * --with-cloakbrowser not set
#   * Running as root in the root-with-dedicated-user flow (deferred to
#     the reexec'd child running as the comis user)
#
# Lazy fallback: if the npm install or binary download fails, we warn but
# don't fatal - the daemon would still come up; the browser tool would just
# error on first use. Operator can rerun: npx cloakbrowser install
install_cloakbrowser() {
    [[ "$WITH_CLOAKBROWSER" == "1" ]] || return 0
    [[ "$OS" == "linux" ]] || return 0

    # When root in the dedicated-user flow, defer - the reexec'd comis-user
    # invocation will hit this function from the non-root branch and do the
    # install with the right HOME.
    if is_root; then
        local target_user="${COMIS_USER:-comis}"
        if getent passwd "$target_user" >/dev/null 2>&1; then
            ui_info "CloakBrowser install deferred until the installer continues as '${target_user}'"
            return 0
        fi
        # No target user - root install is fine (rare path: --no-user).
    fi

    if ! command -v npm >/dev/null 2>&1; then
        ui_warn "npm not on PATH; cannot install CloakBrowser"
        return 1
    fi

    # Pin the wrapper to a dedicated dir so we don't tangle with the global
    # comisai install or any other npm prefix the user has set. Skip
    # `npm init -y` because it derives the package name from the dirname
    # and rejects names starting with "." - write a minimal package.json
    # directly so the dotted hidden path works.
    local cloak_pkg_dir="$HOME/.cloakbrowser-wrapper"
    mkdir -p "$cloak_pkg_dir" 2>/dev/null || true
    if [[ ! -f "$cloak_pkg_dir/package.json" ]]; then
        cat > "$cloak_pkg_dir/package.json" <<'JSON'
{
  "name": "cloakbrowser-wrapper",
  "version": "0.0.0",
  "private": true,
  "description": "Installer-managed CloakBrowser wrapper for the Comis browser tool."
}
JSON
    fi
    local cloak_log
    cloak_log="$(mktempfile)"
    if ! (cd "$cloak_pkg_dir" && npm install --no-audit --no-fund --silent --save-exact \
              "cloakbrowser@${CLOAKBROWSER_NPM_VERSION}" \
              "playwright-core@${PLAYWRIGHT_CORE_NPM_VERSION}" >"$cloak_log" 2>&1); then
        ui_warn "CloakBrowser npm install failed"
        if [[ "$VERBOSE" == "1" ]]; then
            tail -n 20 "$cloak_log" >&2 || true
        fi
        return 1
    fi
    ui_success "CloakBrowser npm wrapper installed at ${cloak_pkg_dir}"

    # Pre-pull the alternative Chromium runtime (~140-210 MB). Lands at
    # $HOME/.cloakbrowser/chromium-<version>/. Filter the verbose download
    # progress lines so the install output stays readable.
    local cloak_bin="${cloak_pkg_dir}/node_modules/.bin/cloakbrowser"
    if [[ ! -x "$cloak_bin" ]]; then
        ui_warn "CloakBrowser CLI not found after npm install"
        return 1
    fi
    if "$cloak_bin" install 2>&1 \
        | grep -vE "Download progress:" \
        | grep -E "Downloading|Download complete|Checksum|Binary ready|Newer Chromium|Background update|Extracting|Cache|already|installed" \
        | head -10; then
        :
    fi
    if "$cloak_bin" info 2>/dev/null | grep -q 'Installed:[[:space:]]*true'; then
        local cloak_version
        cloak_version="$("$cloak_bin" info 2>/dev/null | awk '/Version:/{print $2; exit}')"
        ui_success "CloakBrowser binary cached at \$HOME/.cloakbrowser/ (v${cloak_version})"
        return 0
    fi

    ui_warn "CloakBrowser binary did not finalize; will lazy-download on first use"
    return 1
}

# apply_apparmor_bwrap_profile
# ----------------------------
# Ubuntu 23.10+ ships with `kernel.apparmor_restrict_unprivileged_userns=1`,
# which denies user-namespace creation unless the calling binary has an
# AppArmor profile that grants `userns`. bubblewrap ships no such profile,
# so the exec sandbox fails with "bwrap: setting up uid map: Permission denied"
# on any agent-issued shell command. Writing a tiny permissive profile for
# /usr/bin/bwrap restores normal sandboxing.
#
# Safe to call on non-AppArmor distros (RHEL/Fedora) - returns early when
# AppArmor isn't active or the bwrap binary isn't present.
apparmor_bwrap_profile_is_managed() {
    local profile="$1"
    [[ -f "$profile" && ! -L "$profile" ]] || return 1
    [[ "$(sed -n '1p' "$profile")" == "# managed-by: comis-installer" ]] || return 1
    local recorded body computed=""
    recorded="$(sed -n '2s/^# checksum: //p' "$profile")"
    [[ "$recorded" =~ ^[a-f0-9]{64}$ ]] || return 1
    body="$(tail -n +3 "$profile")"
    if command -v sha256sum >/dev/null 2>&1; then
        computed="$(printf '%s' "$body" | sha256sum | cut -d' ' -f1)"
    elif command -v shasum >/dev/null 2>&1; then
        computed="$(printf '%s' "$body" | shasum -a 256 | cut -d' ' -f1)"
    fi
    [[ -n "$computed" && "$computed" == "$recorded" ]]
}

apply_apparmor_bwrap_profile() {
    if ! command -v bwrap >/dev/null 2>&1; then
        return 0
    fi
    if [ ! -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
        return 0
    fi
    if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" != "1" ]; then
        return 0
    fi
    if [ ! -d /etc/apparmor.d ] || ! command -v apparmor_parser >/dev/null 2>&1; then
        return 0
    fi

    local profile=/etc/apparmor.d/bwrap
    if [[ -e "$profile" || -L "$profile" ]] && ! apparmor_bwrap_profile_is_managed "$profile"; then
        if grep -Fxq "# managed-by: comis-installer" "$profile" 2>/dev/null; then
            ui_error "Installer-managed AppArmor profile at ${profile} was modified; refusing to overwrite it"
            return 1
        fi
        ui_warn "Existing AppArmor profile at ${profile} is not installer-managed; leaving it untouched"
        return 0
    fi

    local parser_cmd=(apparmor_parser)
    if ! is_root; then
        parser_cmd=(sudo apparmor_parser)
    fi

    local body
    body="$(cat <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
PROFILE
)"
    local checksum=""
    if command -v sha256sum >/dev/null 2>&1; then
        checksum="$(printf '%s' "$body" | sha256sum | cut -d' ' -f1)"
    elif command -v shasum >/dev/null 2>&1; then
        checksum="$(printf '%s' "$body" | shasum -a 256 | cut -d' ' -f1)"
    fi
    if [[ -z "$checksum" ]]; then
        ui_warn "No SHA-256 utility available; leaving the AppArmor profile untouched"
        return 0
    fi
    local tmp staged
    tmp="$(mktempfile)"
    {
        printf '# managed-by: comis-installer\n# checksum: %s\n' "$checksum"
        printf '%s\n' "$body"
    } > "$tmp"
    staged="${profile}.comis.$$"
    if ! maybe_sudo install -m 0644 -o root -g root "$tmp" "$staged" \
        || ! maybe_sudo mv -f "$staged" "$profile"; then
        maybe_sudo rm -f "$staged" 2>/dev/null || true
        ui_warn "Could not write the AppArmor profile atomically"
        return 0
    fi
    run_quiet_step "Loading AppArmor profile for bubblewrap" "${parser_cmd[@]}" -r "$profile" \
        || ui_warn "apparmor_parser -r failed - exec sandbox may fail until bwrap profile is loaded"
}

# install_egress_logging
# ----------------------
# Optional logging-only preparation for a network egress allowlist.
#
# The agent's exec sandbox runs with bwrap --share-net (full host network
# access) because the daemon's regex command filter cannot inspect the contents
# of files the agent writes and then executes. Without an OS-level egress
# restriction, a malicious skill, MCP server, or prompt injection can write a
# script that opens an outbound connection and bypass every command-string
# defense. The actual security boundary has to be a uid-scoped iptables
# allowlist (or seccomp BPF filter on connect()) - this function lays the
# groundwork.
#
# When COMIS_ENABLE_EGRESS_LOGGING=1 is set, this function creates the
# COMIS_EGRESS chain in logging-only mode and wires outbound traffic from the
# comis uid through it. ACCEPT continues unchanged so nothing is blocked. The
# rate-limited LOG rule records packet metadata in the kernel journal under the
# "comis-egress: " prefix, which can reveal remote destinations.
#
# Enforcement remains an explicit operator action: after the observation
# window, replace the catch-all ACCEPT with destination-specific ACCEPTs
# followed by a final DROP.
#
# Disabled by default. Idempotent when enabled: skipped if the chain already
# exists. Also skipped if iptables is unavailable or the comis user does not
# yet exist. Non-fatal - failures cannot block the rest of the install.
install_egress_logging() {
    [[ "$ENABLE_EGRESS_LOGGING" == "1" ]] || return 0

    if ! command -v iptables >/dev/null 2>&1; then
        ui_warn "iptables not available - skipping egress logging"
        return 0
    fi

    if ! id "$COMIS_USER" >/dev/null 2>&1; then
        ui_warn "Skipping egress logging (user '$COMIS_USER' does not exist yet)"
        return 0
    fi

    local sudo_prefix=""
    if ! is_root; then
        sudo_prefix="sudo "
    fi

    # Idempotent: skip if our chain already exists
    if $sudo_prefix iptables -L COMIS_EGRESS -n >/dev/null 2>&1; then
        ui_info "Egress logging already configured (chain COMIS_EGRESS exists)"
        return 0
    fi

    if ! $sudo_prefix iptables -N COMIS_EGRESS 2>/dev/null; then
        ui_warn "Could not create COMIS_EGRESS chain - skipping egress logging"
        return 0
    fi

    # Bound diagnostic log volume, then accept traffic unchanged. This mode
    # observes destinations but does not enforce policy.
    if ! $sudo_prefix iptables -A COMIS_EGRESS -m limit --limit 10/minute --limit-burst 20 \
        -j LOG --log-prefix "comis-egress: " --log-level 6 2>/dev/null; then
        ui_warn "Could not add the rate-limited LOG rule - egress logging remains disabled"
        $sudo_prefix iptables -F COMIS_EGRESS 2>/dev/null || true
        $sudo_prefix iptables -X COMIS_EGRESS 2>/dev/null || true
        return 0
    fi
    if ! $sudo_prefix iptables -A COMIS_EGRESS -j ACCEPT 2>/dev/null; then
        ui_warn "Could not add the ACCEPT rule - egress logging remains disabled"
        $sudo_prefix iptables -F COMIS_EGRESS 2>/dev/null || true
        $sudo_prefix iptables -X COMIS_EGRESS 2>/dev/null || true
        return 0
    fi

    # Hook the chain into OUTPUT, scoped to the comis uid only.
    if ! $sudo_prefix iptables -A OUTPUT -m owner --uid-owner "$COMIS_USER" -j COMIS_EGRESS 2>/dev/null; then
        ui_warn "Could not wire COMIS_EGRESS into OUTPUT - egress logging remains disabled"
        $sudo_prefix iptables -F COMIS_EGRESS 2>/dev/null || true
        $sudo_prefix iptables -X COMIS_EGRESS 2>/dev/null || true
        return 0
    fi

    ui_success "Egress logging enabled by COMIS_ENABLE_EGRESS_LOGGING=1 for user '$COMIS_USER'"
    ui_info "  Review captured destinations:  journalctl -k | grep 'comis-egress:'"
    ui_info "  This diagnostic chain does not enforce an allowlist; design and test firewall policy separately"
    ui_info "  Remove installer-created rules: bash comis-install.sh --uninstall --purge"
    return 0
}

install_uv() {
    # uv/uvx: Python package runner used by MCP servers that distribute via PyPI
    # (e.g. nanobanana). Installed system-wide from a pinned release archive so
    # the service user picks up uvx on PATH without shell-profile modifications.
    # Non-fatal: Python-based MCP servers are optional; a failure here shouldn't
    # block the rest of the install.
    if command -v uvx &> /dev/null; then
        ui_success "uv already installed ($(uvx --version 2>/dev/null | head -1 || echo present))"
        return 0
    fi

    local uv_target uv_sha256
    local libc="gnu"
    if [[ -f /etc/alpine-release ]] || ls /lib/ld-musl-*.so.1 >/dev/null 2>&1; then
        libc="musl"
    fi
    case "$(uname -m)-${libc}" in
        x86_64-gnu|amd64-gnu)
            uv_target="x86_64-unknown-linux-gnu"
            uv_sha256="56dd1b66701ecb62fe896abb919444e4b83c5e8645cca953e6ddd496ff8a0feb"
            ;;
        aarch64-gnu|arm64-gnu)
            uv_target="aarch64-unknown-linux-gnu"
            uv_sha256="eee8dd658d20e5ac85fec9c2326b6cbc9d83a1eef09ef07433e58698ac849591"
            ;;
        x86_64-musl|amd64-musl)
            uv_target="x86_64-unknown-linux-musl"
            uv_sha256="de82507d12e31cfc86c1c776238f7c248e48e40d996dedc812d64fdd31c6ed12"
            ;;
        aarch64-musl|arm64-musl)
            uv_target="aarch64-unknown-linux-musl"
            uv_sha256="29418befb64f926a2dba3473e8e69acd00b36fb845d85344ef11321a993ad8f5"
            ;;
        *)
            ui_warn "No verified uv artifact for $(uname -m) - Python-based MCP servers will be unavailable"
            return 0
            ;;
    esac

    local uv_tmpdir uv_archive uv_url
    uv_tmpdir="$(mktemp -d)"
    TMPFILES+=("$uv_tmpdir")
    uv_archive="${uv_tmpdir}/uv.tar.gz"
    uv_url="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uv_target}.tar.gz"
    if ! download_file "$uv_url" "$uv_archive"; then
        ui_warn "Could not download uv ${UV_VERSION} - Python-based MCP servers will be unavailable"
        return 0
    fi
    if ! verify_file_sha256 "$uv_archive" "$uv_sha256"; then
        ui_warn "uv ${UV_VERSION} checksum verification failed - refusing to install"
        return 0
    fi
    if ! tar -xzf "$uv_archive" -C "$uv_tmpdir"; then
        ui_warn "uv ${UV_VERSION} archive extraction failed"
        return 0
    fi

    local uv_bin="${uv_tmpdir}/uv-${uv_target}/uv"
    local uvx_bin="${uv_tmpdir}/uv-${uv_target}/uvx"
    if [[ ! -x "$uv_bin" || ! -x "$uvx_bin" ]]; then
        ui_warn "uv ${UV_VERSION} archive did not contain uv and uvx"
        return 0
    fi
    if is_root; then
        run_quiet_step "Installing uv (for Python-based MCP servers)" \
            install -m 0755 "$uv_bin" "$uvx_bin" /usr/local/bin/ \
            || ui_warn "uv install failed - Python-based MCP servers will be unavailable"
    else
        run_quiet_step "Installing uv (for Python-based MCP servers)" \
            sudo install -m 0755 "$uv_bin" "$uvx_bin" /usr/local/bin/ \
            || ui_warn "uv install failed - Python-based MCP servers will be unavailable"
    fi
    return 0
}

install_rust() {
    # cargo/rustc: Rust toolchain used by agent exec sandbox for `cargo install`
    # of Rust CLIs. Installed system-wide from a pinned rustup binary so the
    # service user picks up cargo on PATH without shell-profile modifications.
    # Non-fatal: Rust-based tools are optional; a failure here shouldn't block
    # the rest of the install.
    if command -v cargo &> /dev/null; then
        ui_success "rust already installed ($(cargo --version 2>/dev/null | head -1 || echo present))"
        return 0
    fi

    local rustup_target rustup_sha256
    local libc="gnu"
    if [[ -f /etc/alpine-release ]] || ls /lib/ld-musl-*.so.1 >/dev/null 2>&1; then
        libc="musl"
    fi
    case "$(uname -m)-${libc}" in
        x86_64-gnu|amd64-gnu)
            rustup_target="x86_64-unknown-linux-gnu"
            rustup_sha256="20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c"
            ;;
        aarch64-gnu|arm64-gnu)
            rustup_target="aarch64-unknown-linux-gnu"
            rustup_sha256="e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c"
            ;;
        x86_64-musl|amd64-musl)
            rustup_target="x86_64-unknown-linux-musl"
            rustup_sha256="e6599a1c7be58a2d8eaca66a80e0dc006d87bbcf780a58b7343d6e14c1605cb2"
            ;;
        aarch64-musl|arm64-musl)
            rustup_target="aarch64-unknown-linux-musl"
            rustup_sha256="a97c8f56d7462908695348dd8c71ea6740c138ce303715793a690503a94fc9a9"
            ;;
        *)
            ui_warn "No verified rustup artifact for $(uname -m) - Rust-based tools will be unavailable"
            return 0
            ;;
    esac

    local rustup_tmpdir rustup_bin rustup_url
    rustup_tmpdir="$(mktemp -d)"
    TMPFILES+=("$rustup_tmpdir")
    rustup_bin="${rustup_tmpdir}/rustup-init"
    rustup_url="https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${rustup_target}/rustup-init"
    if ! download_file "$rustup_url" "$rustup_bin"; then
        ui_warn "Could not download rustup ${RUSTUP_VERSION} - Rust-based tools will be unavailable"
        return 0
    fi
    if ! verify_file_sha256 "$rustup_bin" "$rustup_sha256"; then
        ui_warn "rustup ${RUSTUP_VERSION} checksum verification failed - refusing to install"
        return 0
    fi
    chmod 0755 "$rustup_bin"

    # CARGO_HOME=/usr/local/cargo + RUSTUP_HOME=/usr/local/rustup: system-wide
    # install so the daemon service user picks up cargo on PATH. --profile minimal
    # keeps the install lean (no docs, no extra components). --no-modify-path
    # skips shell-profile mutation (we symlink into /usr/local/bin instead, so
    # cargo is reachable inside bwrap which binds /usr RO).
    local rustup_args=(--profile minimal --no-modify-path --default-toolchain "$RUST_TOOLCHAIN_VERSION" -y)
    if is_root; then
        run_quiet_step "Installing rust (for cargo-based tools)" \
            env CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup "$rustup_bin" "${rustup_args[@]}" \
            || { ui_warn "rustup install failed - Rust-based tools will be unavailable"; return 0; }
        # Symlink toolchain binaries into /usr/local/bin so they're on PATH inside
        # bwrap (which binds /usr RO via SYSTEM_RO_PATHS). The CARGO_HOME/bin dir
        # is NOT on the default PATH and NOT inside the bwrap RO bind set.
        for bin in cargo rustc rustup; do
            ln -sf "/usr/local/cargo/bin/$bin" "/usr/local/bin/$bin" 2>/dev/null || true
        done
        write_rustup_profile_d
    else
        run_quiet_step "Installing rust (for cargo-based tools)" \
            sudo env CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup "$rustup_bin" "${rustup_args[@]}" \
            || { ui_warn "rustup install failed - Rust-based tools will be unavailable"; return 0; }
        for bin in cargo rustc rustup; do
            sudo ln -sf "/usr/local/cargo/bin/$bin" "/usr/local/bin/$bin" 2>/dev/null || true
        done
        write_rustup_profile_d
    fi
    return 0
}

# write_rustup_profile_d
# ----------------------
# Without RUSTUP_HOME exported, the rustup multiplexer can't find the system
# toolchain at /usr/local/rustup and fails with "could not choose a version of
# cargo to run, because no default is configured" - even when the symlinks at
# /usr/local/bin/{cargo,rustc} exist. Set it system-wide for login shells via
# /etc/profile.d. The systemd unit also sets Environment=RUSTUP_HOME for the
# daemon process (so bwrap children inherit it via wrapEnv's pass-through).
write_rustup_profile_d() {
    local profile=/etc/profile.d/rustup.sh
    local write_cmd="tee"
    if ! is_root; then
        write_cmd="sudo tee"
    fi
    $write_cmd "$profile" >/dev/null <<'PROFILE'
# Comis-managed: makes the system rustup install discoverable to all login shells.
export RUSTUP_HOME=/usr/local/rustup
export CARGO_HOME=/usr/local/cargo
PROFILE
    if is_root; then
        chmod 644 "$profile" 2>/dev/null || true
    else
        sudo chmod 644 "$profile" 2>/dev/null || true
    fi
}

install_build_tools_macos() {
    local ok=true
    local brew_bin=""

    if ! xcode-select -p >/dev/null 2>&1; then
        ui_info "Installing Xcode Command Line Tools (required for make/clang)"
        xcode-select --install >/dev/null 2>&1 || true
        if ! xcode-select -p >/dev/null 2>&1; then
            ui_warn "Xcode Command Line Tools are not ready yet"
            ui_info "Complete the installer dialog, then re-run this installer"
            ok=false
        fi
    fi

    if ! command -v cmake >/dev/null 2>&1; then
        brew_bin="$(resolve_brew_bin || true)"
        if [[ -n "$brew_bin" ]]; then
            activate_brew_for_session || true
            run_quiet_step "Installing cmake" "$brew_bin" install cmake
        else
            ui_warn "Homebrew not available; cannot auto-install cmake"
            ok=false
        fi
    fi

    if ! command -v make >/dev/null 2>&1; then
        ui_warn "make is still unavailable"
        ok=false
    fi
    if ! command -v cmake >/dev/null 2>&1; then
        ui_warn "cmake is still unavailable"
        ok=false
    fi

    [[ "$ok" == "true" ]]
}

auto_install_build_tools_for_npm_failure() {
    local log="$1"
    if ! npm_log_indicates_missing_build_tools "$log"; then
        return 1
    fi

    ui_warn "Detected missing native build tools; attempting automatic setup"
    if [[ "$OS" == "linux" ]]; then
        install_build_tools_linux || return 1
    elif [[ "$OS" == "macos" ]]; then
        install_build_tools_macos || return 1
    else
        return 1
    fi
    ui_success "Build tools setup complete"
    return 0
}

run_npm_global_install() {
    local spec="$1"
    local log="$2"

    local -a cmd
    cmd=(env "SHARP_IGNORE_GLOBAL_LIBVIPS=$SHARP_IGNORE_GLOBAL_LIBVIPS" npm --loglevel "$NPM_LOGLEVEL")
    if [[ -n "$NPM_SILENT_FLAG" ]]; then
        cmd+=("$NPM_SILENT_FLAG")
    fi
    cmd+=(--no-fund --no-audit install -g "$spec")
    local cmd_display=""
    printf -v cmd_display '%q ' "${cmd[@]}"
    LAST_NPM_INSTALL_CMD="${cmd_display% }"

    if [[ "$VERBOSE" == "1" ]]; then
        "${cmd[@]}" 2>&1 | tee "$log"
        return $?
    fi

    if [[ -n "$GUM" ]] && gum_is_tty; then
        local cmd_quoted=""
        local log_quoted=""
        printf -v cmd_quoted '%q ' "${cmd[@]}"
        printf -v log_quoted '%q' "$log"
        run_with_spinner "Installing Comis package" bash -c "${cmd_quoted}>${log_quoted} 2>&1"
        return $?
    fi

    start_spinner "Installing Comis package"
    env "SHARP_IGNORE_GLOBAL_LIBVIPS=$SHARP_IGNORE_GLOBAL_LIBVIPS" \
        npm --silent --no-fund --no-audit install -g "$spec" >"$log" 2>&1
    local rc=$?
    if [[ "$rc" -eq 0 ]]; then
        stop_spinner "Comis package installed" true
    else
        stop_spinner "Comis package install failed" false
    fi
    return "$rc"
}

extract_npm_debug_log_path() {
    local log="$1"
    local path=""
    path="$(sed -n -E 's/.*A complete log of this run can be found in:[[:space:]]*//p' "$log" | tail -n1)"
    if [[ -n "$path" ]]; then
        echo "$path"
        return 0
    fi

    path="$(grep -Eo '/[^[:space:]]+_logs/[^[:space:]]+debug[^[:space:]]*\.log' "$log" | tail -n1 || true)"
    if [[ -n "$path" ]]; then
        echo "$path"
        return 0
    fi

    return 1
}

extract_first_npm_error_line() {
    local log="$1"
    grep -E 'npm (ERR!|error)|ERR!' "$log" | head -n1 || true
}

extract_npm_error_code() {
    local log="$1"
    sed -n -E 's/^npm (ERR!|error) code[[:space:]]+([^[:space:]]+).*$/\2/p' "$log" | head -n1
}

extract_npm_error_syscall() {
    local log="$1"
    sed -n -E 's/^npm (ERR!|error) syscall[[:space:]]+(.+)$/\2/p' "$log" | head -n1
}

extract_npm_error_errno() {
    local log="$1"
    sed -n -E 's/^npm (ERR!|error) errno[[:space:]]+(.+)$/\2/p' "$log" | head -n1
}

print_npm_failure_diagnostics() {
    local spec="$1"
    local log="$2"
    local debug_log=""
    local first_error=""
    local error_code=""
    local error_syscall=""
    local error_errno=""

    ui_warn "npm install failed for ${spec}"
    if [[ -n "${LAST_NPM_INSTALL_CMD}" ]]; then
        echo "  Command: ${LAST_NPM_INSTALL_CMD}"
    fi
    echo "  Installer log: ${log}"

    error_code="$(extract_npm_error_code "$log")"
    if [[ -n "$error_code" ]]; then
        echo "  npm code: ${error_code}"
    fi

    error_syscall="$(extract_npm_error_syscall "$log")"
    if [[ -n "$error_syscall" ]]; then
        echo "  npm syscall: ${error_syscall}"
    fi

    error_errno="$(extract_npm_error_errno "$log")"
    if [[ -n "$error_errno" ]]; then
        echo "  npm errno: ${error_errno}"
    fi

    debug_log="$(extract_npm_debug_log_path "$log" || true)"
    if [[ -n "$debug_log" ]]; then
        echo "  npm debug log: ${debug_log}"
    fi

    first_error="$(extract_first_npm_error_line "$log")"
    if [[ -n "$first_error" ]]; then
        echo "  First npm error: ${first_error}"
    fi
}

install_comis_npm() {
    local spec="$1"
    local log
    log="$(mktempfile)"
    if ! run_npm_global_install "$spec" "$log"; then
        local attempted_build_tool_fix=false
        if auto_install_build_tools_for_npm_failure "$log"; then
            attempted_build_tool_fix=true
            ui_info "Retrying npm install after build tools setup"
            if run_npm_global_install "$spec" "$log"; then
                ui_success "Comis npm package installed"
                return 0
            fi
        fi

        print_npm_failure_diagnostics "$spec" "$log"

        if [[ "$VERBOSE" != "1" ]]; then
            if [[ "$attempted_build_tool_fix" == "true" ]]; then
                ui_warn "npm install still failed after build tools setup; showing last log lines"
            else
                ui_warn "npm install failed; showing last log lines"
            fi
            tail -n 80 "$log" >&2 || true
        fi

        if grep -q "ENOTEMPTY: directory not empty, rename .*comisai" "$log"; then
            ui_warn "npm left stale directory; cleaning and retrying"
            cleanup_npm_comis_paths
            if run_npm_global_install "$spec" "$log"; then
                ui_success "Comis npm package installed"
                return 0
            fi
            return 1
        fi
        if grep -q "EEXIST" "$log"; then
            local conflict=""
            conflict="$(extract_comis_conflict_path "$log" || true)"
            if [[ -n "$conflict" ]] && cleanup_comis_bin_conflict "$conflict"; then
                if run_npm_global_install "$spec" "$log"; then
                    ui_success "Comis npm package installed"
                    return 0
                fi
                return 1
            fi
            ui_error "npm failed because a comis binary already exists"
            if [[ -n "$conflict" ]]; then
                ui_info "Remove or move ${conflict}, then retry"
            fi
            ui_info "Or rerun with: npm install -g --force ${spec}"
        fi
        return 1
    fi
    ui_success "Comis npm package installed"
    repair_comisai_bundled_deps || true
    ensure_node_pty_built || true
    return 0
}

# Workaround for an npm quirk with bundledDependencies + native deps: after
# `npm install -g comisai(.tgz)`, some transitive deps (notably `bindings`)
# end up as empty directories that fail at runtime. Running `npm install`
# inside the installed package triggers a proper reify pass that nests the
# missing deps correctly. Idempotent and fast on a clean install.
# resolve_comisai_install_dir
# ---------------------------
# Echo the directory of the globally-installed `comisai` package, or nothing if
# it can't be located. Shared by the post-install native-dep fixups
# (repair_comisai_bundled_deps, ensure_node_pty_built).
resolve_comisai_install_dir() {
    local npm_root=""
    npm_root="$(npm root -g 2>/dev/null || true)"
    if [[ -n "$npm_root" && -d "${npm_root}/comisai" ]]; then
        echo "${npm_root}/comisai"
        return 0
    fi
    if [[ -d "/usr/lib/node_modules/comisai" ]]; then
        echo "/usr/lib/node_modules/comisai"
        return 0
    fi
    return 1
}

# comisai_cli_loads
# -----------------
# Behavioral canary for the bundled-deps prune: actually load the installed
# CLI entry (the `comis` bin target). The sentinel checks in
# repair_comisai_bundled_deps catch the two KNOWN prune shapes cheaply; this
# catches every shape by construction - an upgrade over an existing prefix
# pruned @earendil-works/pi-tui (a transitive dep of pi-coding-agent), which
# left both sentinels green while `comis --version` died with
# ERR_MODULE_NOT_FOUND. Returns 0 when the CLI loads (or when there is no
# entry to probe - an unexpected layout must not force a reify).
comisai_cli_loads() {
    local comisai_dir="$1"
    if [[ ! -f "${comisai_dir}/dist/cli-entry.js" ]]; then
        return 0
    fi
    ( cd "$comisai_dir" && node dist/cli-entry.js --version >/dev/null 2>&1 )
}

repair_comisai_bundled_deps() {
    local comisai_dir=""
    comisai_dir="$(resolve_comisai_install_dir || true)"
    if [[ -z "$comisai_dir" ]]; then
        return 0
    fi

    # `npm install -g comisai(.tgz)` has two known failure modes around the
    # package's bundledDependencies, both of which leave the daemon unable to
    # boot (ERR_MODULE_NOT_FOUND at startup):
    #   1. A bundled native-dep dir (bindings) lands EMPTY.
    #   2. Transitive deps of a NON-bundled direct dep get skipped entirely -
    #      e.g. @earendil-works/pi-coding-agent's `glob`. This is especially
    #      likely on a reinstall/upgrade over an existing global prefix, where
    #      npm prunes them. The narrow "empty bindings" heuristic misses this.
    # A full reify inside the install dir nests the missing deps correctly and
    # is idempotent (a near-no-op on an already-complete tree). Detect either
    # symptom and reify; the reify never runs when the tree is already healthy.
    local bindings_dir="${comisai_dir}/node_modules/bindings"
    local pca_dir="${comisai_dir}/node_modules/@earendil-works/pi-coding-agent"
    local needs_repair=false
    if [[ -d "$bindings_dir" && -z "$(ls -A "$bindings_dir" 2>/dev/null)" ]]; then
        needs_repair=true
    fi
    # `glob` is a representative transitive dep of pi-coding-agent; its absence
    # signals the broader pruning. Check both hoisted and nested locations.
    if [[ -d "$pca_dir" \
          && ! -d "${comisai_dir}/node_modules/glob" \
          && ! -d "${pca_dir}/node_modules/glob" ]]; then
        needs_repair=true
    fi
    # Behavioral canary - catches the prune shapes the sentinels don't (the
    # pi-tui class: sentinels clean, CLI load-broken).
    if [[ "$needs_repair" != "true" ]] && ! comisai_cli_loads "$comisai_dir"; then
        needs_repair=true
    fi
    if [[ "$needs_repair" != "true" ]]; then
        return 0
    fi

    ui_info "Repairing bundled dependency tree (one-time fix)"
    if ( cd "$comisai_dir" && npm install --no-save --no-fund --no-audit >/dev/null 2>&1 ); then
        local repair_ok=true
        if [[ -d "$bindings_dir" && ! -f "${bindings_dir}/bindings.js" ]]; then
            repair_ok=false
        fi
        if [[ -d "$pca_dir" \
              && ! -d "${comisai_dir}/node_modules/glob" \
              && ! -d "${pca_dir}/node_modules/glob" ]]; then
            repair_ok=false
        fi
        if ! comisai_cli_loads "$comisai_dir"; then
            repair_ok=false
        fi
        if [[ "$repair_ok" == "true" ]]; then
            ui_success "Dependency tree repaired"
        else
            ui_warn "Dependency tree repair incomplete; daemon may not start correctly"
            ui_info "Manually: cd ${comisai_dir} && npm install"
        fi
    else
        ui_warn "Dependency tree repair failed; daemon may not start correctly"
        ui_info "Manually: cd ${comisai_dir} && npm install"
    fi
}

# ensure_node_pty_built
# ---------------------
# node-pty is an OPTIONAL native dependency that powers the terminal tool's
# real-PTY backend (interactive TUIs like vim, full-screen CLIs). It ships NO
# Linux prebuild, so on Linux it must compile from source (node-gyp) during
# `npm install -g comisai`.
#
# Because it is OPTIONAL, a failed compile leaves `npm install` at exit 0 with
# node-pty silently absent - npm never surfaces the failure, so the reactive
# build-tools recovery in install_comis_npm (which keys off a NON-zero npm exit)
# can't fire. At runtime the terminal tool then falls back to a degraded pipe
# backend with only a WARN in the daemon log. This function converts that silent
# degrade into either a successful targeted rebuild or a clear, actionable
# warning at install time.
#
# Linux-only: macOS ships a darwin prebuild, so node-pty always loads there.
# Non-fatal: the daemon runs fine without node-pty (degraded terminal tool only),
# so nothing here may abort the install - every path returns 0.
ensure_node_pty_built() {
    [[ "$OS" == "linux" ]] || return 0

    local comisai_dir=""
    comisai_dir="$(resolve_comisai_install_dir || true)"
    [[ -n "$comisai_dir" ]] || return 0

    # Already loadable (compiled during the npm install)? Nothing to do.
    # Resolve from the package dir so a nested OR hoisted node-pty both count.
    if ( cd "$comisai_dir" && node -e "require('node-pty')" >/dev/null 2>&1 ); then
        return 0
    fi

    ui_info "Building node-pty (real-PTY backend for the terminal tool)"

    # The C toolchain is normally installed proactively by install_node on the
    # root/sudo path. If a compiler is somehow still missing and we can elevate,
    # install it now (idempotent). On a non-root / no-sudo install we cannot, and
    # the rebuild below will fail into the degraded-mode warning.
    if ! command -v make >/dev/null 2>&1 || { ! command -v cc >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1; }; then
        if is_root || { command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; }; then
            install_build_tools_linux || true
        fi
    fi

    # Pin the rebuild to the exact version the installed package declares - read
    # it from the on-disk package.json so the installer never drifts from the
    # source-of-truth pin in packages/comis/package.json.
    local pinned=""
    pinned="$(node -e "const o=require('${comisai_dir}/package.json').optionalDependencies||{};process.stdout.write(o['node-pty']||'')" 2>/dev/null || true)"
    local spec="node-pty"
    [[ -n "$pinned" ]] && spec="node-pty@${pinned}"

    # Targeted compile inside the global package (mirrors
    # repair_comisai_bundled_deps). --no-save leaves package.json untouched.
    ( cd "$comisai_dir" && npm install "$spec" --no-save --no-fund --no-audit >/dev/null 2>&1 ) || true

    if ( cd "$comisai_dir" && node -e "require('node-pty')" >/dev/null 2>&1 ); then
        ui_success "node-pty built (terminal tool: full PTY support)"
        return 0
    fi

    ui_warn "node-pty could not be built - the terminal tool will run in degraded pipe mode"
    ui_info "  Piped commands still work; interactive TUIs (vim, full-screen CLIs) need a real PTY."
    ui_info "  To enable later (requires make, gcc/g++, python3):"
    ui_info "    cd ${comisai_dir} && npm install ${spec}"
    return 0
}

TAGLINE="$DEFAULT_TAGLINE"

NO_INIT=${COMIS_NO_INIT:-0}
NO_PROMPT=${COMIS_NO_PROMPT:-0}
# Skip the dedicated 'comis' user and install for the invoking user instead
NO_USER="${COMIS_NO_USER:-0}"
# Original CLI args, captured before parsing - replayed verbatim by the sudo re-exec
ORIGINAL_ARGS=()
DRY_RUN=${COMIS_DRY_RUN:-0}
INSTALL_METHOD=${COMIS_INSTALL_METHOD:-}
COMIS_VERSION=${COMIS_VERSION:-latest}
USE_BETA=${COMIS_BETA:-0}
GIT_DIR_DEFAULT="${HOME}/comis"
GIT_DIR=${COMIS_GIT_DIR:-$GIT_DIR_DEFAULT}
GIT_UPDATE=${COMIS_GIT_UPDATE:-1}
SHARP_IGNORE_GLOBAL_LIBVIPS="${SHARP_IGNORE_GLOBAL_LIBVIPS:-1}"
NPM_LOGLEVEL="${COMIS_NPM_LOGLEVEL:-error}"
NPM_SILENT_FLAG="--silent"
VERBOSE="${COMIS_VERBOSE:-0}"
COMIS_BIN=""
SELECTED_NODE_BIN=""
PNPM_CMD=()
HELP=0

# Local-tarball install (bypasses npm registry). When set, overrides --version.
COMIS_TARBALL="${COMIS_TARBALL:-}"

# Service manager selection (auto|systemd|systemd-user|pm2|none)
SERVICE_MANAGER="${COMIS_SERVICE:-auto}"
# Skip boot-persistence registration (pm2 startup / systemctl enable)
NO_AUTOSTART="${COMIS_NO_AUTOSTART:-0}"
# Install + enable but do not start the service yet
NO_SERVICE_START="${COMIS_NO_SERVICE_START:-0}"
# Optional Linux packet-metadata logging. Exact opt-in only: any value other
# than 1 leaves iptables unchanged.
ENABLE_EGRESS_LOGGING="${COMIS_ENABLE_EGRESS_LOGGING:-0}"

# Browser-tool provisioning is on by default because the browser tool ships
# enabled. A fresh install provisions Chromium and its headless shared libraries.
# System-service installs also request Xvfb and a virtual-display companion unit;
# systemd-user installs downshift to headless before the install plan is shown.
# STRICTLY best-effort: the call sites guard it (`install_browser_deps_linux || true`,
# `render_xvfb_unit || ui_warn`), so a box where Chromium/Xvfb can't install - or a
# rootless install - still gets a working daemon. An unavailable browser runtime
# fails honestly at use. Opt out of the whole stack with
# `--without-browser` / `COMIS_WITH_BROWSER=0`, or keep headless-only (drop the Xvfb
# headed stack) with `--without-xvfb` / `COMIS_WITH_XVFB=0`, for a minimal footprint.
# CloakBrowser stays opt-in (`--with-cloakbrowser`) - it swaps Chrome for an alternative
# Chromium runtime, not an additive capability. WITH_XVFB / WITH_CLOAKBROWSER imply WITH_BROWSER.
WITH_BROWSER="${COMIS_WITH_BROWSER:-1}"
WITH_XVFB="${COMIS_WITH_XVFB:-1}"
WITH_CLOAKBROWSER="${COMIS_WITH_CLOAKBROWSER:-0}"
# Internal integration seam for containers that start Xvfb in their entrypoint.
# Ordinary host installs leave this off and require the managed system unit.
XVFB_EXTERNAL_RUNTIME="${COMIS_XVFB_EXTERNAL_RUNTIME:-0}"
[[ "$WITH_XVFB" == "1" ]] && WITH_BROWSER=1
[[ "$WITH_CLOAKBROWSER" == "1" ]] && WITH_BROWSER=1

# Uninstall flags
UNINSTALL=0
PURGE="${COMIS_PURGE:-0}"
REMOVE_USER_FLAG="${COMIS_REMOVE_USER:-0}"
ASSUME_YES=0
UNINSTALL_TARGET_USER=""
UNINSTALL_TARGET_HOME=""
UNINSTALL_TARGET_IS_DEDICATED=0
FULL_UNINSTALL_NOOP=0
# Root-owned receipt that keeps the dedicated target and account provenance
# available after the service, package, or data directory has been removed.
INSTALL_RECEIPT_FILE="/var/lib/comis-installer/receipt"

# Populated by resolve_service_template_vars
COMIS_NODE_BIN=""
COMIS_DAEMON_JS=""
COMIS_SVC_USER=""
COMIS_SVC_GROUP=""
COMIS_SVC_HOME=""
COMIS_DATA_DIR=""
COMIS_CONFIG_FILE=""
COMIS_ENV_FILE="/etc/comis/env"
COMIS_WORKING_DIR=""
# Resolved service manager (auto → concrete value)
RESOLVED_SERVICE_MANAGER=""

print_usage() {
    cat <<EOF
Comis installer (macOS + Linux)

Usage:
  curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh -o comis-install.sh
  bash comis-install.sh [options]

Review before installing:
  less comis-install.sh
  bash comis-install.sh --dry-run

Install options:
  --install-method, --method npm|git   Install via npm (default) or from a git checkout
  --npm                                Shortcut for --install-method npm
  --git, --github                      Shortcut for --install-method git
  --version <version|dist-tag>         npm install: version (default: latest)
  --beta                               Use beta if available, else latest
  --tarball <path>                     Install from a local .tgz (bypasses npm registry)
  --git-dir, --dir <path>              Checkout directory (default: ~/comis)
  --no-git-update                      Skip git pull for existing checkout
  --user <name>                        Dedicated Linux user (default: comis)
  --no-user                            Install for the invoking user (skip the dedicated user;
                                       non-root Linux installs otherwise offer to re-run with sudo)
  --no-init                            Skip interactive init (non-interactive)
  --no-prompt                          Disable prompts (required in CI/automation)
  --dry-run                            Print what would happen (no changes)
  --verbose                            Print debug output (set -x, npm verbose)
  --help, -h                           Show this help

Service options (how to run the daemon):
  --service auto|systemd|systemd-user|pm2|none
                                       auto (default) picks systemd on Linux+root, systemd-user on
                                       Linux non-root, pm2 on macOS. Use 'none' to skip registration
                                       (CI / manual control).
  --no-autostart                       Install service but skip boot persistence (no systemctl enable /
                                       pm2 startup). Useful when you lack admin rights.
  --no-service-start                   Register + enable but do not start the daemon yet.

Browser tool:
  --with-browser                       Install Chromium + headless shared libs and widen
                                       the systemd sandbox so the agent browser tool can
                                       run on this host. ON by default (the browser tool
                                       ships enabled); best-effort, so a host where Chromium
                                       can't install still gets a working daemon.
  --without-browser                    Opt out of the default browser provisioning for a
                                       minimal footprint (skips Chromium + headless libs).
                                       The browser tool stays enabled but fails at use for
                                       lack of a runtime. Same as COMIS_WITH_BROWSER=0.
  --with-xvfb                          Implies --with-browser. Also installs Xvfb and
                                       registers a virtual-display companion unit so the
                                       browser tool can run workflows that require a
                                       visible display server.
                                       ON by default; best-effort. systemd-user installs
                                       downshift to headless mode with a warning.
  --without-xvfb                       Keep the default headless browser but drop the
                                       heavier Xvfb headed stack + companion unit.
                                       Same as COMIS_WITH_XVFB=0.
  --with-cloakbrowser                  Implies --with-browser. Installs an optional
                                       alternative Chromium runtime. It does not guarantee
                                       access, fingerprint evasion, or IP reputation. Review
                                       its separate binary license and your target sites'
                                       terms before use. See
                                       https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md

Network diagnostics (Linux systemd with a dedicated user):
  COMIS_ENABLE_EGRESS_LOGGING=0|1      Disabled by default. Set to 1 to create a
                                       uid-scoped iptables LOG+ACCEPT chain. It logs
                                       outbound packet metadata to the kernel journal,
                                       limited to 10 entries per minute with a burst of 20.
                                       It does not restrict traffic. --purge removes the chain.

Uninstall:
  --uninstall                          Remove Comis (keeps data by default)
  --purge                              With --uninstall: also delete ~/.comis, /etc/comis, /var/log/comis, and the COMIS_EGRESS iptables chain
  --remove-user                        Linux+root only: fully remove installer-owned Comis artifacts and the dedicated user (implies --purge)
                                       Shared host runtimes and OS packages are preserved
  --yes                                Skip interactive confirmation prompts

Environment variables:
  COMIS_INSTALL_METHOD=git|npm
  COMIS_VERSION=latest|next|<semver>
  COMIS_BETA=0|1
  COMIS_TARBALL=/path/to/comisai.tgz
  COMIS_GIT_DIR=...
  COMIS_GIT_UPDATE=0|1
  COMIS_USER=comis                    Dedicated user for Linux installs
  COMIS_NO_USER=0|1                   Skip the dedicated user (install for the invoking user)
  COMIS_SERVICE=auto|systemd|systemd-user|pm2|none
  COMIS_NO_AUTOSTART=1
  COMIS_NO_SERVICE_START=1
  COMIS_WITH_BROWSER=0|1               (default 1 - set 0 for a minimal footprint)
  COMIS_WITH_XVFB=0|1                   (default 1 - set 0 to keep headless-only)
  COMIS_WITH_CLOAKBROWSER=0|1
  COMIS_ENABLE_EGRESS_LOGGING=0|1       Default: 0 (disabled)
  COMIS_PURGE=1
  COMIS_REMOVE_USER=1
  COMIS_NO_PROMPT=1
  COMIS_DRY_RUN=1
  COMIS_NO_INIT=1
  COMIS_VERBOSE=1
  COMIS_NPM_LOGLEVEL=error|warn|notice  Default: error
  SHARP_IGNORE_GLOBAL_LIBVIPS=0|1    Default: 1

Examples:
  bash comis-install.sh --dry-run
  bash comis-install.sh --no-init
  bash comis-install.sh --service none
  bash comis-install.sh --uninstall --purge --yes
  sudo bash comis-install.sh --uninstall --remove-user --yes
EOF
}

require_option_value() {
    local option="$1"
    local value="${2:-}"
    if [[ -z "$value" || "$value" == --* ]]; then
        ui_error "Missing value for ${option}"
        echo "Run: bash comis-install.sh --help"
        exit 2
    fi
}

validate_local_tarball_preflight() {
    [[ -z "$COMIS_TARBALL" ]] && return 0
    if [[ -L "$COMIS_TARBALL" ]]; then
        ui_error "--tarball must not be a symbolic link: ${COMIS_TARBALL}"
        return 1
    fi
    if [[ ! -e "$COMIS_TARBALL" ]]; then
        ui_error "--tarball path does not exist: ${COMIS_TARBALL}"
        return 1
    fi
    if [[ ! -f "$COMIS_TARBALL" ]]; then
        ui_error "--tarball must be a regular file: ${COMIS_TARBALL}"
        return 1
    fi
    if ! tar -tzf "$COMIS_TARBALL" >/dev/null 2>&1; then
        ui_error "--tarball is not a readable gzip archive: ${COMIS_TARBALL}"
        return 1
    fi
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --no-init|--no-onboard)
                NO_INIT=1
                shift
                ;;
            --init|--onboard)
                NO_INIT=0
                shift
                ;;
            --dry-run)
                DRY_RUN=1
                shift
                ;;
            --verbose)
                VERBOSE=1
                shift
                ;;
            --no-prompt)
                NO_PROMPT=1
                shift
                ;;
            --help|-h)
                HELP=1
                shift
                ;;
            --install-method|--method)
                require_option_value "$1" "${2:-}"
                INSTALL_METHOD="$2"
                shift 2
                ;;
            --version)
                require_option_value "$1" "${2:-}"
                COMIS_VERSION="$2"
                shift 2
                ;;
            --beta)
                USE_BETA=1
                shift
                ;;
            --npm)
                INSTALL_METHOD="npm"
                shift
                ;;
            --git|--github)
                INSTALL_METHOD="git"
                shift
                ;;
            --git-dir|--dir)
                require_option_value "$1" "${2:-}"
                GIT_DIR="$2"
                shift 2
                ;;
            --no-git-update)
                GIT_UPDATE=0
                shift
                ;;
            --user)
                require_option_value "$1" "${2:-}"
                COMIS_USER="$2"
                shift 2
                ;;
            --no-user)
                NO_USER=1
                shift
                ;;
            --tarball)
                require_option_value "$1" "${2:-}"
                COMIS_TARBALL="$2"
                INSTALL_METHOD="npm"
                shift 2
                ;;
            --tarball=*)
                COMIS_TARBALL="${1#*=}"
                INSTALL_METHOD="npm"
                shift
                ;;
            --service)
                require_option_value "$1" "${2:-}"
                SERVICE_MANAGER="$2"
                shift 2
                ;;
            --service=*)
                SERVICE_MANAGER="${1#*=}"
                shift
                ;;
            --no-autostart)
                NO_AUTOSTART=1
                shift
                ;;
            --no-service-start)
                NO_SERVICE_START=1
                shift
                ;;
            --with-browser)
                WITH_BROWSER=1
                shift
                ;;
            --without-browser)
                # Opt out of the entire default browser stack (minimal footprint -
                # skips Chromium, the headless shared libs, and the Xvfb headed unit).
                # The browser TOOL stays enabled in config but fails honestly at use
                # for lack of a runtime. Must also zero WITH_XVFB / WITH_CLOAKBROWSER
                # so the pre-parse `WITH_XVFB=1 ⟹ WITH_BROWSER=1` implication can't
                # silently re-enable the stack.
                WITH_BROWSER=0
                WITH_XVFB=0
                WITH_CLOAKBROWSER=0
                shift
                ;;
            --without-xvfb)
                # Keep the (default) headless browser but drop the heavier Xvfb headed
                # stack + its companion unit. Same as COMIS_WITH_XVFB=0.
                WITH_XVFB=0
                shift
                ;;
            --with-xvfb)
                WITH_BROWSER=1
                WITH_XVFB=1
                shift
                ;;
            --with-cloakbrowser)
                WITH_BROWSER=1
                WITH_CLOAKBROWSER=1
                shift
                ;;
            --uninstall)
                UNINSTALL=1
                shift
                ;;
            --purge)
                PURGE=1
                shift
                ;;
            --remove-user)
                REMOVE_USER_FLAG=1
                PURGE=1
                shift
                ;;
            --yes|-y)
                ASSUME_YES=1
                shift
                ;;
            *)
                ui_error "Unknown option: $1"
                echo "Run: bash comis-install.sh --help"
                exit 2
                ;;
        esac
    done
}

configure_verbose() {
    if [[ "$VERBOSE" != "1" ]]; then
        return 0
    fi
    if [[ "$NPM_LOGLEVEL" == "error" ]]; then
        NPM_LOGLEVEL="notice"
    fi
    NPM_SILENT_FLAG=""
    set -x
}

is_promptable() {
    if [[ "$NO_PROMPT" == "1" ]]; then
        return 1
    fi
    if (echo -n "" > /dev/tty) 2>/dev/null; then
        return 0
    fi
    return 1
}

prompt_choice() {
    local prompt="$1"
    local answer=""
    if ! is_promptable; then
        return 1
    fi
    echo -e "$prompt" > /dev/tty
    read -r answer < /dev/tty || true
    echo "$answer"
}

choose_install_method_interactive() {
    local detected_checkout="$1"

    if ! is_promptable; then
        return 1
    fi

    if [[ -n "$GUM" ]] && gum_is_tty; then
        local header selection
        header="Detected Comis checkout in: ${detected_checkout}
Choose install method"
        selection="$("$GUM" choose \
            --header "$header" \
            --cursor-prefix "> " \
            "git  . update this checkout and use it" \
            "npm  . install globally via npm" < /dev/tty || true)"

        case "$selection" in
            git*)
                echo "git"
                return 0
                ;;
            npm*)
                echo "npm"
                return 0
                ;;
        esac
        return 1
    fi

    local choice=""
    choice="$(prompt_choice "$(cat <<EOF
${WARN}->${NC} Detected a Comis source checkout in: ${INFO}${detected_checkout}${NC}
Choose install method:
  1) Update this checkout (git) and use it
  2) Install global via npm (migrate away from git)
Enter 1 or 2:
EOF
)" || true)"

    case "$choice" in
        1)
            echo "git"
            return 0
            ;;
        2)
            echo "npm"
            return 0
            ;;
    esac

    return 1
}

detect_comis_checkout() {
    local dir="$1"
    if [[ ! -f "$dir/package.json" ]]; then
        return 1
    fi
    if [[ ! -f "$dir/pnpm-workspace.yaml" ]]; then
        return 1
    fi
    if ! grep -q '"name"[[:space:]]*:[[:space:]]*"comis-workspace"' "$dir/package.json" 2>/dev/null; then
        return 1
    fi
    echo "$dir"
    return 0
}

is_macos_admin_user() {
    if [[ "$OS" != "macos" ]]; then
        return 0
    fi
    if is_root; then
        return 0
    fi
    id -Gn "$(id -un)" 2>/dev/null | grep -qw "admin"
}

print_homebrew_admin_fix() {
    local current_user
    current_user="$(id -un 2>/dev/null || echo "${USER:-current user}")"
    ui_error "Homebrew installation requires a macOS Administrator account"
    echo "Current user (${current_user}) is not in the admin group."
    echo "Fix options:"
    echo "  1) Use an Administrator account and re-run the installer."
    echo "  2) Ask an Administrator to grant admin rights, then sign out/in:"
    echo "     sudo dseditgroup -o edit -a ${current_user} -t user admin"
    echo "Then retry:"
    echo "  curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh -o comis-install.sh"
    echo "  bash comis-install.sh --dry-run"
    echo "  bash comis-install.sh"
}

install_homebrew() {
    local brew_bin=""
    if [[ "$OS" == "macos" ]]; then
        brew_bin="$(resolve_brew_bin || true)"
        if [[ -z "$brew_bin" ]]; then
            if ! is_macos_admin_user; then
                print_homebrew_admin_fix
                exit 1
            fi
            ui_info "Homebrew not found, installing"
            local homebrew_installer
            homebrew_installer="$(mktempfile)"
            if ! download_file "https://raw.githubusercontent.com/Homebrew/install/${HOMEBREW_INSTALL_COMMIT}/install.sh" "$homebrew_installer"; then
                ui_error "Could not download the pinned Homebrew installer"
                exit 1
            fi
            if ! verify_file_sha256 "$homebrew_installer" "$HOMEBREW_INSTALL_SHA256"; then
                ui_error "Homebrew installer checksum verification failed"
                exit 1
            fi
            run_quiet_step "Installing Homebrew" /bin/bash "$homebrew_installer"

            if ! activate_brew_for_session; then
                ui_warn "Homebrew install completed but brew is still unavailable in this shell"
            fi
            ui_success "Homebrew installed"
        else
            activate_brew_for_session || true
            ui_success "Homebrew already installed"
        fi
    fi
}

node_version_is_supported() {
    local version="${1:-}"
    version="${version#v}"
    if [[ ! "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)([-+].*)?$ ]]; then
        return 1
    fi

    local major="${BASH_REMATCH[1]}"
    local minor="${BASH_REMATCH[2]}"
    local patch="${BASH_REMATCH[3]}"
    local suffix="${BASH_REMATCH[4]:-}"
    local min_major min_minor min_patch
    IFS=. read -r min_major min_minor min_patch <<<"$MIN_NODE_VERSION"

    if (( 10#$major != 10#$min_major )); then
        (( 10#$major > 10#$min_major ))
        return $?
    fi
    if (( 10#$minor != 10#$min_minor )); then
        (( 10#$minor > 10#$min_minor ))
        return $?
    fi
    if (( 10#$patch != 10#$min_patch )); then
        (( 10#$patch > 10#$min_patch ))
        return $?
    fi
    [[ "$suffix" != -* ]]
}

print_active_node_paths() {
    if ! command -v node &> /dev/null; then
        return 1
    fi
    local node_path node_version npm_path npm_version
    node_path="$(command -v node 2>/dev/null || true)"
    node_version="$(node -v 2>/dev/null || true)"
    ui_info "Active Node.js: ${node_version:-unknown} (${node_path:-unknown})"

    if command -v npm &> /dev/null; then
        npm_path="$(command -v npm 2>/dev/null || true)"
        npm_version="$(npm -v 2>/dev/null || true)"
        ui_info "Active npm: ${npm_version:-unknown} (${npm_path:-unknown})"
    fi
    return 0
}

ensure_macos_node22_active() {
    if [[ "$OS" != "macos" ]]; then
        return 0
    fi

    local brew_bin=""
    local brew_node_prefix=""
    brew_bin="$(resolve_brew_bin || true)"
    if [[ -n "$brew_bin" ]]; then
        activate_brew_for_session || true
        brew_node_prefix="$("$brew_bin" --prefix node@22 2>/dev/null || true)"
        if [[ -n "$brew_node_prefix" && -x "${brew_node_prefix}/bin/node" ]]; then
            export PATH="${brew_node_prefix}/bin:$PATH"
            refresh_shell_command_cache
        fi
    fi

    if has_supported_node; then
        return 0
    fi

    local active_path active_version
    active_path="$(command -v node 2>/dev/null || echo "not found")"
    active_version="$(node -v 2>/dev/null || echo "missing")"

    ui_error "Node.js >=${MIN_NODE_VERSION} is required, but this shell is using ${active_version} (${active_path})"
    if [[ -n "$brew_node_prefix" ]]; then
        echo "Add this to your shell profile and restart shell:"
        echo "  export PATH=\"${brew_node_prefix}/bin:\$PATH\""
    else
        echo "Ensure Homebrew node@22 is first on PATH, then rerun installer."
    fi
    return 1
}

check_node() {
    if command -v node &> /dev/null; then
        local active_version=""
        active_version="$(node -v 2>/dev/null || true)"
        if has_supported_node; then
            ui_success "Node.js ${active_version} found"
            print_active_node_paths || true
            return 0
        fi
        if [[ -n "$active_version" ]]; then
            ui_info "Node.js ${active_version} found; Comis requires >=${MIN_NODE_VERSION}"
        else
            ui_info "Node.js version could not be parsed; installing >=${MIN_NODE_VERSION}"
        fi
        return 1
    else
        ui_info "Node.js not found, installing it now"
        return 1
    fi
}

node_version_from_binary() {
    local node_bin="$1"
    if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
        return 1
    fi
    "$node_bin" -p 'process.versions.node' 2>/dev/null || true
}

node_is_supported_binary() {
    local node_bin="$1"
    local version=""
    version="$(node_version_from_binary "$node_bin")"
    if [[ -z "$version" ]]; then
        return 1
    fi
    node_version_is_supported "$version"
}

has_supported_node() {
    local node_bin=""
    node_bin="$(command -v node 2>/dev/null || true)"
    if [[ -z "$node_bin" ]]; then
        return 1
    fi
    node_is_supported_binary "$node_bin"
}

prepend_path_dir() {
    local dir="${1%/}"
    if [[ -z "$dir" || ! -d "$dir" ]]; then
        return 1
    fi
    local current=":${PATH:-}:"
    current="${current//:${dir}:/:}"
    current="${current#:}"
    current="${current%:}"
    if [[ -n "$current" ]]; then
        export PATH="${dir}:${current}"
    else
        export PATH="${dir}"
    fi
    hash -r 2>/dev/null || true
}

ensure_supported_node_on_path() {
    if has_supported_node; then
        SELECTED_NODE_BIN="$(command -v node 2>/dev/null || true)"
        return 0
    fi

    local -a candidates=()
    local candidate=""
    while IFS= read -r candidate; do
        [[ -n "$candidate" ]] && candidates+=("$candidate")
    done < <(type -aP node 2>/dev/null || true)
    candidates+=(
        "/usr/bin/node"
        "/usr/local/bin/node"
        "/opt/homebrew/bin/node"
        "/opt/homebrew/opt/node@22/bin/node"
        "/usr/local/opt/node@22/bin/node"
    )

    local seen=":"
    for candidate in "${candidates[@]}"; do
        if [[ -z "$candidate" || ! -x "$candidate" ]]; then
            continue
        fi
        case "$seen" in
            *":$candidate:"*) continue ;;
        esac
        seen="${seen}${candidate}:"

        if node_is_supported_binary "$candidate"; then
            prepend_path_dir "$(dirname "$candidate")" || continue
            SELECTED_NODE_BIN="$candidate"
            ui_info "Using Node.js runtime at ${candidate}"
            return 0
        fi
    done

    return 1
}

original_path_node_bin() {
    if [[ -z "${ORIGINAL_PATH:-}" ]]; then
        return 1
    fi
    PATH="$ORIGINAL_PATH" command -v node 2>/dev/null || true
}

original_path_has_supported_node() {
    local node_bin=""
    node_bin="$(original_path_node_bin)"
    if [[ -z "$node_bin" ]]; then
        return 1
    fi
    node_is_supported_binary "$node_bin"
}

find_comis_entry_path() {
    local npm_root=""
    npm_root="$(npm root -g 2>/dev/null || true)"
    if [[ -z "$npm_root" ]]; then
        return 1
    fi
    local entry_js="${npm_root}/comisai/dist/cli.js"
    if [[ -f "$entry_js" ]]; then
        echo "$entry_js"
        return 0
    fi
    return 1
}

install_comis_compat_shim() {
    if [[ "$INSTALL_METHOD" != "npm" ]]; then
        return 0
    fi
    if original_path_has_supported_node; then
        return 0
    fi

    local node_bin="${SELECTED_NODE_BIN:-}"
    if [[ -z "$node_bin" ]]; then
        node_bin="$(command -v node 2>/dev/null || true)"
    fi
    if [[ -z "$node_bin" || ! -x "$node_bin" ]] || ! node_is_supported_binary "$node_bin"; then
        return 1
    fi

    local entry_path=""
    entry_path="$(find_comis_entry_path || true)"
    if [[ -z "$entry_path" ]]; then
        return 1
    fi

    local target_dir="$HOME/.local/bin"
    ensure_user_local_bin_on_path

    mkdir -p "$target_dir"
    local shim_path="${target_dir}/comis"
    cat > "$shim_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$node_bin" "$entry_path" "\$@"
EOF
    chmod +x "$shim_path"
    refresh_shell_command_cache
    ui_warn "Configured comis shim at ${shim_path} for Node $("$node_bin" -v 2>/dev/null || echo ">=${MIN_NODE_VERSION}")"
    return 0
}

install_node_standalone() {
    # Download a pinned Node.js archive directly from nodejs.org and verify its
    # embedded release checksum before extraction.
    local arch
    arch="$(uname -m)"
    local node_arch
    case "$arch" in
        x86_64|amd64) node_arch="x64" ;;
        aarch64|arm64) node_arch="arm64" ;;
        armv7l) node_arch="armv7l" ;;
        *)
            ui_warn "Unsupported architecture ($arch) for standalone Node.js install"
            return 1
            ;;
    esac

    local node_os
    case "$OS" in
        linux) node_os="linux" ;;
        macos) node_os="darwin" ;;
        *) return 1 ;;
    esac

    local node_sha256=""
    case "${node_os}-${node_arch}" in
        linux-x64) node_sha256="c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2" ;;
        linux-arm64) node_sha256="0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc" ;;
        linux-armv7l) node_sha256="91ea7b35edf17d351177da671ea8b40ee8e42d83f6397ab1b66767e50c7d87a9" ;;
        darwin-x64) node_sha256="41796082f45db51738d1902cae84fa4f699ff6d2550321361424e8bfe6ea1939" ;;
        darwin-arm64) node_sha256="1c3a9e78da501bbc1f0c99fbbb69bb7c722bc7a9bf30128b21ea502f3905892a" ;;
        *)
            ui_warn "No verified Node.js archive for ${node_os}-${node_arch}"
            return 1
            ;;
    esac

    local tarball_name="node-v${NODE_STANDALONE_VERSION}-${node_os}-${node_arch}.tar.xz"
    local download_url="https://nodejs.org/dist/v${NODE_STANDALONE_VERSION}/${tarball_name}"
    local tmp_dir
    tmp_dir="$(mktemp -d)"
    TMPFILES+=("$tmp_dir")

    ui_info "Downloading ${tarball_name}..."
    if ! download_file "$download_url" "$tmp_dir/$tarball_name"; then
        ui_warn "Node.js download failed"
        return 1
    fi
    if ! verify_file_sha256 "$tmp_dir/$tarball_name" "$node_sha256"; then
        ui_warn "Node.js ${NODE_STANDALONE_VERSION} checksum verification failed"
        return 1
    fi
    if ! tar xf "$tmp_dir/$tarball_name" -C "$tmp_dir" >/dev/null 2>&1; then
        ui_warn "Node.js archive extraction failed"
        return 1
    fi

    local extracted_dir=""
    extracted_dir="$(find "$tmp_dir" -maxdepth 1 -type d -name 'node-v*' 2>/dev/null | head -1 || true)"
    if [[ -z "$extracted_dir" || ! -d "$extracted_dir" ]]; then
        ui_warn "Node.js extraction failed"
        return 1
    fi

    local comis_node_dir bin_dir
    if is_root; then
        comis_node_dir="/usr/local/lib/comis-node"
        bin_dir="/usr/local/bin"
    else
        comis_node_dir="$HOME/.comis/node"
        bin_dir="$HOME/.local/bin"
        ensure_user_local_bin_on_path
    fi
    rm -rf "$comis_node_dir"
    mkdir -p "$(dirname "$comis_node_dir")" "$bin_dir"
    mv "$extracted_dir" "$comis_node_dir"

    ln -sf "$comis_node_dir/bin/node" "$bin_dir/node"
    ln -sf "$comis_node_dir/bin/npm" "$bin_dir/npm"
    ln -sf "$comis_node_dir/bin/npx" "$bin_dir/npx"
    ln -sf "$comis_node_dir/bin/corepack" "$bin_dir/corepack"
    export PATH="$comis_node_dir/bin:$PATH"
    refresh_shell_command_cache

    local installed_ver=""
    installed_ver="$("$comis_node_dir/bin/node" --version 2>/dev/null || true)"
    ui_success "Node.js ${installed_ver} installed to ${comis_node_dir}"
    return 0
}

run_nodesource_setup() {
    local setup_script="$1"

    if is_root; then
        ( umask 022; exec bash "$setup_script" )
        return $?
    fi

    sudo -E bash -c 'umask 022; exec bash "$1"' _ "$setup_script"
}

install_node() {
    if [[ "$OS" == "macos" ]]; then
        ui_info "Installing Node.js via Homebrew"
        if run_quiet_step "Installing node@22" brew install node@22; then
            brew link node@22 --overwrite --force 2>/dev/null || true
            if ensure_macos_node22_active; then
                ui_success "Node.js installed"
                print_active_node_paths || true
            else
                ui_warn "Homebrew node@22 not active; trying standalone download from nodejs.org"
                if ! install_node_standalone; then
                    ui_error "Could not install Node.js"
                    echo "Please install Node.js >=${MIN_NODE_VERSION} manually: https://nodejs.org"
                    exit 1
                fi
            fi
        else
            ui_warn "Homebrew install failed; trying standalone download from nodejs.org"
            if ! install_node_standalone; then
                ui_error "Could not install Node.js"
                echo "Please install Node.js >=${MIN_NODE_VERSION} manually: https://nodejs.org"
                exit 1
            fi
        fi
    elif [[ "$OS" == "linux" ]]; then
        local nodesource_ok=false

        # Try NodeSource first (system-managed, gets security updates via apt/dnf).
        # Both build tools and NodeSource require root/sudo.
        if is_root || (command -v sudo &> /dev/null && sudo -n true 2>/dev/null); then
            ui_info "Installing system packages (build tools, python3-venv, ffmpeg, bubblewrap)"
            if install_build_tools_linux; then
                ui_success "Build tools installed"
            else
                ui_warn "Continuing without auto-installing build tools"
            fi

            ui_info "Installing Node.js via NodeSource"
            require_sudo
            if command -v apt-get &> /dev/null; then
                wait_for_apt_lock
                local tmp
                tmp="$(mktempfile)"
                if download_file "https://deb.nodesource.com/setup_22.x" "$tmp" \
                    && verify_file_sha256 "$tmp" "$NODESOURCE_DEB_SETUP_SHA256"; then
                    if is_root; then
                        run_quiet_step "Configuring NodeSource repository" run_nodesource_setup "$tmp" && \
                        run_quiet_step "Installing Node.js" apt-get install -y -qq nodejs && \
                        nodesource_ok=true
                    else
                        run_quiet_step "Configuring NodeSource repository" run_nodesource_setup "$tmp" && \
                        run_quiet_step "Installing Node.js" sudo apt-get install -y -qq nodejs && \
                        nodesource_ok=true
                    fi
                fi
            elif command -v dnf &> /dev/null; then
                local tmp
                tmp="$(mktempfile)"
                if download_file "https://rpm.nodesource.com/setup_22.x" "$tmp" \
                    && verify_file_sha256 "$tmp" "$NODESOURCE_RPM_SETUP_SHA256"; then
                    if is_root; then
                        run_quiet_step "Configuring NodeSource repository" run_nodesource_setup "$tmp" && \
                        run_quiet_step "Installing Node.js" dnf install -y nodejs && \
                        nodesource_ok=true
                    else
                        run_quiet_step "Configuring NodeSource repository" run_nodesource_setup "$tmp" && \
                        run_quiet_step "Installing Node.js" sudo dnf install -y nodejs && \
                        nodesource_ok=true
                    fi
                fi
            elif command -v yum &> /dev/null; then
                local tmp
                tmp="$(mktempfile)"
                if download_file "https://rpm.nodesource.com/setup_22.x" "$tmp" \
                    && verify_file_sha256 "$tmp" "$NODESOURCE_RPM_SETUP_SHA256"; then
                    if is_root; then
                        run_quiet_step "Configuring NodeSource repository" run_nodesource_setup "$tmp" && \
                        run_quiet_step "Installing Node.js" yum install -y nodejs && \
                        nodesource_ok=true
                    else
                        run_quiet_step "Configuring NodeSource repository" run_nodesource_setup "$tmp" && \
                        run_quiet_step "Installing Node.js" sudo yum install -y nodejs && \
                        nodesource_ok=true
                    fi
                fi
            fi
        fi

        if [[ "$nodesource_ok" == "true" ]]; then
            ui_success "Node.js v22 installed"
            print_active_node_paths || true
        else
            # Fallback: download directly from nodejs.org (no sudo required)
            ui_warn "NodeSource install unavailable or failed; trying standalone download from nodejs.org"
            if ! install_node_standalone; then
                ui_error "Could not install Node.js"
                echo "Please install Node.js >=${MIN_NODE_VERSION} manually: https://nodejs.org"
                exit 1
            fi
        fi
    fi

    detect_nvm_and_warn
}

detect_nvm_and_warn() {
    local nvm_dir="${NVM_DIR:-}"
    if [[ -z "$nvm_dir" ]] && [[ -f "${HOME}/.nvm/nvm.sh" ]]; then
        nvm_dir="${HOME}/.nvm"
    fi

    if [[ -z "$nvm_dir" ]]; then
        return 0
    fi

    local node_path
    node_path="$(command -v node 2>/dev/null || true)"

    if [[ -n "$node_path" && "$node_path" == *".nvm"* ]]; then
        local current_version
        current_version="$(node -v 2>/dev/null || true)"

        if ! node_version_is_supported "$current_version"; then
            ui_warn ""
            ui_warn "NVM detected with old default Node version"
            ui_warn "   Your shell is using NVM's Node ${current_version}, but Comis requires >=${MIN_NODE_VERSION}"
            ui_warn ""
            ui_info "To fix this, run:"
            ui_info "  nvm install 22"
            ui_info "  nvm use 22"
            ui_info "  nvm alias default 22"
            ui_warn ""
            ui_warn "Then restart your terminal and run the installer again."
            exit 1
        fi
    fi
}

check_git() {
    if command -v git &> /dev/null; then
        ui_success "Git already installed"
        return 0
    fi
    ui_info "Git not found, installing it now"
    return 1
}

is_root() {
    [[ "$(id -u)" -eq 0 ]]
}

validate_comis_user_name() {
    if [[ ! "$COMIS_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || [[ "${#COMIS_USER}" -gt 32 ]]; then
        ui_error "Invalid dedicated Linux user name"
        return 1
    fi
}

has_sudo() {
    command -v sudo >/dev/null 2>&1
}

COMIS_USER="${COMIS_USER:-comis}"
COMIS_REEXEC="${COMIS_REEXEC:-0}"

should_create_dedicated_user() {
    # Only on Linux, only when running as root, not re-exec'd, not opted out
    # via --no-user, and only when we're actually going to register a
    # system-scope systemd service that benefits from a dedicated user. For
    # --service none, systemd-user, or pm2, install as the invoking user so
    # `comis` is immediately on their PATH.
    [[ "$OS" == "linux" ]] && is_root && [[ "$COMIS_REEXEC" != "1" ]] \
        && [[ "$NO_USER" != "1" ]] \
        && [[ "$RESOLVED_SERVICE_MANAGER" == "systemd" ]]
}

# Decide how a Linux non-root install proceeds. The dedicated-user layout is
# the default - the daemon should not run as the login user (whose ~/.ssh and
# ~/.aws stay readable to it) just because the installer wasn't run as root.
# Prints exactly one strategy token:
#   dedicated-prompt - ask for consent, then re-run the installer under sudo
#   current-user     - proceed as the invoking user (opt-out or not applicable)
#   refuse-no-prompt - cannot ask (no TTY / --no-prompt): explicit choice required
#   refuse-no-sudo   - cannot elevate: needs root or an explicit opt-out
nonroot_install_strategy() {
    if [[ "$OS" != "linux" ]] || is_root || [[ "$COMIS_REEXEC" == "1" ]] \
        || [[ "$NO_USER" == "1" ]] || [[ "$SERVICE_MANAGER" != "auto" ]] \
        || ! has_working_systemd; then
        echo "current-user"
        return 0
    fi
    if ! has_sudo; then
        echo "refuse-no-sudo"
        return 0
    fi
    if is_promptable; then
        echo "dedicated-prompt"
    else
        echo "refuse-no-prompt"
    fi
}

prompt_dedicated_user_consent() {
    local answer=""
    answer="$(prompt_choice "Comis installs under a dedicated '${COMIS_USER}' system user (recommended).\nContinue with sudo? [Y/n] ")" || return 1
    case "$answer" in
        ""|y|Y|yes|Yes|YES) return 0 ;;
        *) return 1 ;;
    esac
}

elevate_install_to_root() {
    local script_copy rc=0
    script_copy="$(mktempfile)"
    stage_install_script "$script_copy"
    ui_info "Re-running the installer with sudo"
    sudo env COMIS_ENABLE_EGRESS_LOGGING="$ENABLE_EGRESS_LOGGING" \
        bash "$script_copy" ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"} || rc=$?
    exit "$rc"
}

enforce_dedicated_user_default() {
    local strategy
    strategy="$(nonroot_install_strategy)"
    if [[ "$strategy" == "current-user" ]]; then
        return 0
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
        case "$strategy" in
            dedicated-prompt)
                ui_info "Dry run: would offer to re-run with sudo and install under the dedicated '${COMIS_USER}' user (--no-user opts out)"
                ;;
            *)
                ui_info "Dry run: a real run would stop here - a non-root install needs sudo (dedicated '${COMIS_USER}' user) or an explicit --no-user"
                ;;
        esac
        return 0
    fi

    case "$strategy" in
        dedicated-prompt)
            if prompt_dedicated_user_consent; then
                elevate_install_to_root
                # Unreachable: elevate_install_to_root exits with the re-run's status
                exit 1
            fi
            ui_info "Installing for the current user instead (config under \$HOME/.comis)"
            NO_USER=1
            return 0
            ;;
        refuse-no-sudo)
            ui_error "Comis installs under a dedicated '${COMIS_USER}' system user by default, and sudo is not available to elevate."
            echo "  Recommended:  re-run this installer as root"
            echo "  Alternative:  add --no-user (or COMIS_NO_USER=1) to install for the current user"
            exit 2
            ;;
        refuse-no-prompt)
            ui_error "A non-root install needs an explicit choice when prompts are unavailable."
            echo "  Recommended (dedicated '${COMIS_USER}' user):  re-run with sudo"
            echo "  Current-user install:                        add --no-user (or COMIS_NO_USER=1)"
            exit 2
            ;;
    esac
}

comis_user_exists() {
    id "$COMIS_USER" &>/dev/null
}

install_receipt_raw_value() {
    local key="$1"
    awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2); exit }' "$INSTALL_RECEIPT_FILE"
}

install_receipt_home_is_safe() {
    local receipt_home="$1"
    [[ "$receipt_home" =~ ^/[A-Za-z0-9._/-]+$ ]] || return 1
    [[ "$receipt_home" != "/" && "$receipt_home" != *"//"* \
        && "$receipt_home" != *"/../"* && "$receipt_home" != *"/./"* \
        && "$receipt_home" != *"/.." && "$receipt_home" != *"/." ]]
}

install_identity_marker_path() {
    local target_home="$1"
    printf '%s/.comis-installer-identity\n' "$target_home"
}

install_identity_marker_is_valid() {
    local target_home="$1"
    local identity_token="$2"
    local marker
    marker="$(install_identity_marker_path "$target_home")"
    [[ "$identity_token" =~ ^[a-f0-9]{64}$ ]] || return 1
    [[ -d "$target_home" && ! -L "$target_home" ]] || return 1
    [[ -f "$marker" && ! -L "$marker" ]] || return 1
    [[ "$(tr -d '[:space:]' < "$marker" 2>/dev/null || true)" == "$identity_token" ]] || return 1
    local marker_stat
    marker_stat="$(stat -c '%u:%g:%a' "$marker" 2>/dev/null \
        || stat -f '%u:%g:%Lp' "$marker" 2>/dev/null || true)"
    [[ "$marker_stat" == "0:0:400" ]]
}

install_account_identity_comment() {
    local identity_token="$1"
    [[ "$identity_token" =~ ^[a-f0-9]{64}$ ]] || return 1
    printf 'Comis AI agent platform [%s]\n' "$identity_token"
}

install_account_has_identity_comment() {
    local target_user="$1"
    local passwd_comment
    passwd_comment="$(getent passwd "$target_user" 2>/dev/null | cut -d: -f5)"
    [[ "$passwd_comment" =~ ^Comis\ AI\ agent\ platform\ \[[a-f0-9]{64}\]$ ]]
}

install_home_identity_is_valid() {
    local target_home="$1"
    local target_uid="$2"
    local target_gid="$3"
    local identity_token="$4"
    install_identity_marker_is_valid "$target_home" "$identity_token" || return 1
    local home_stat
    home_stat="$(stat -c '%u:%g' "$target_home" 2>/dev/null \
        || stat -f '%u:%g' "$target_home" 2>/dev/null || true)"
    [[ "$home_stat" == "${target_uid}:${target_gid}" ]]
}

install_owned_account_is_current() {
    local target_user="$1"
    local target_home="$2"
    local target_uid="$3"
    local target_gid="$4"
    local identity_token="$5"
    local created_group="$6"
    id "$target_user" >/dev/null 2>&1 || return 1
    local passwd_home passwd_comment current_uid current_gid
    passwd_home="$(getent passwd "$target_user" 2>/dev/null | cut -d: -f6)"
    passwd_comment="$(getent passwd "$target_user" 2>/dev/null | cut -d: -f5)"
    current_uid="$(id -u "$target_user" 2>/dev/null || true)"
    current_gid="$(id -g "$target_user" 2>/dev/null || true)"
    [[ "$passwd_home" == "$target_home" && "$current_uid" == "$target_uid" \
        && "$current_gid" == "$target_gid" ]] || return 1
    [[ "$passwd_comment" == "$(install_account_identity_comment "$identity_token")" ]] || return 1
    install_home_identity_is_valid \
        "$target_home" "$target_uid" "$target_gid" "$identity_token" || return 1
    if [[ "$created_group" == "1" ]]; then
        [[ "$(getent group "$target_user" 2>/dev/null | cut -d: -f3)" == "$target_gid" ]] || return 1
    fi
}

generate_install_identity_token() {
    local identity_token
    identity_token="$(od -An -N32 -tx1 /dev/urandom 2>/dev/null | tr -d '[:space:]')"
    [[ "$identity_token" =~ ^[a-f0-9]{64}$ ]] || return 1
    printf '%s\n' "$identity_token"
}

write_install_identity_marker() {
    local target_home="$1"
    local identity_token="$2"
    local marker
    marker="$(install_identity_marker_path "$target_home")"
    [[ -d "$target_home" && ! -L "$target_home" ]] || return 1
    if [[ -e "$marker" || -L "$marker" ]]; then
        install_identity_marker_is_valid "$target_home" "$identity_token"
        return
    fi
    local tmp
    tmp="$(mktempfile)"
    printf '%s\n' "$identity_token" > "$tmp"
    install -m 0400 -o root -g root "$tmp" "$marker"
    install_identity_marker_is_valid "$target_home" "$identity_token"
}

install_receipt_is_valid() {
    [[ -f "$INSTALL_RECEIPT_FILE" && ! -L "$INSTALL_RECEIPT_FILE" ]] || return 1
    [[ "$(grep -Fxc "# managed-by: comis-installer" "$INSTALL_RECEIPT_FILE" 2>/dev/null || true)" == "1" ]] || return 1

    local key
    for key in target_user target_home target_uid target_gid created_user created_group decommission_state identity_token; do
        [[ "$(grep -c "^${key}=" "$INSTALL_RECEIPT_FILE" 2>/dev/null || true)" == "1" ]] || return 1
    done
    awk '
        /^# managed-by: comis-installer$/ { next }
        /^(target_user|target_home|target_uid|target_gid|created_user|created_group|decommission_state|identity_token)=/ { next }
        { exit 1 }
    ' "$INSTALL_RECEIPT_FILE" || return 1

    local receipt_user receipt_home receipt_uid receipt_gid created_user created_group decommission_state identity_token
    receipt_user="$(install_receipt_raw_value target_user)"
    receipt_home="$(install_receipt_raw_value target_home)"
    receipt_uid="$(install_receipt_raw_value target_uid)"
    receipt_gid="$(install_receipt_raw_value target_gid)"
    created_user="$(install_receipt_raw_value created_user)"
    created_group="$(install_receipt_raw_value created_group)"
    decommission_state="$(install_receipt_raw_value decommission_state)"
    identity_token="$(install_receipt_raw_value identity_token)"
    [[ "$receipt_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || return 1
    install_receipt_home_is_safe "$receipt_home" || return 1
    [[ "$receipt_uid" =~ ^[0-9]+$ && "$receipt_gid" =~ ^[0-9]+$ ]] || return 1
    [[ "$created_user" =~ ^[01]$ && "$created_group" =~ ^[01]$ ]] || return 1
    [[ "$decommission_state" =~ ^(active|removing|removed)$ ]] || return 1
    if [[ "$created_user" == "1" ]]; then
        [[ "$identity_token" =~ ^[a-f0-9]{64}$ ]] || return 1
    else
        [[ "$identity_token" == "none" ]] || return 1
    fi

    if [[ "$decommission_state" == "active" ]]; then
        id "$receipt_user" >/dev/null 2>&1 || return 1
        if [[ "$created_user" == "1" ]]; then
            install_owned_account_is_current "$receipt_user" "$receipt_home" \
                "$receipt_uid" "$receipt_gid" "$identity_token" "$created_group" || return 1
        else
            local passwd_home current_uid current_gid
            passwd_home="$(getent passwd "$receipt_user" 2>/dev/null | cut -d: -f6)"
            current_uid="$(id -u "$receipt_user" 2>/dev/null || true)"
            current_gid="$(id -g "$receipt_user" 2>/dev/null || true)"
            [[ "$passwd_home" == "$receipt_home" && "$current_uid" == "$receipt_uid" \
                && "$current_gid" == "$receipt_gid" ]] || return 1
        fi
    fi

    if [[ "$INSTALL_RECEIPT_FILE" == "/var/lib/comis-installer/receipt" ]]; then
        [[ "$(stat -c '%u:%g:%a' "$INSTALL_RECEIPT_FILE" 2>/dev/null || true)" == "0:0:600" ]] || return 1
    fi
}

install_receipt_value() {
    local key="$1"
    install_receipt_is_valid || return 1
    install_receipt_raw_value "$key"
}

install_receipt_matches_target() {
    local target_user="$1"
    local target_home="$2"
    local receipt_user receipt_home
    receipt_user="$(install_receipt_value target_user 2>/dev/null || true)"
    receipt_home="$(install_receipt_value target_home 2>/dev/null || true)"
    [[ -n "$receipt_user" && "$receipt_user" == "$target_user" ]] \
        && [[ "$receipt_home" == /* && "$receipt_home" != "/" ]] \
        && [[ "$receipt_home" == "$target_home" ]]
}

install_receipt_created_user() {
    local target_user="$1"
    local target_home="$2"
    install_receipt_matches_target "$target_user" "$target_home" \
        && [[ "$(install_receipt_value created_user 2>/dev/null || true)" == "1" ]]
}

install_receipt_created_group() {
    local target_user="$1"
    local target_home="$2"
    install_receipt_matches_target "$target_user" "$target_home" \
        && [[ "$(install_receipt_value created_group 2>/dev/null || true)" == "1" ]]
}

install_receipt_owned_artifacts_present() {
    install_receipt_is_valid || return 0
    local receipt_user receipt_home created_user created_group
    receipt_user="$(install_receipt_raw_value target_user)"
    receipt_home="$(install_receipt_raw_value target_home)"
    created_user="$(install_receipt_raw_value created_user)"
    created_group="$(install_receipt_raw_value created_group)"
    if [[ "$created_user" == "1" ]]; then
        id "$receipt_user" >/dev/null 2>&1 && return 0
        [[ -e "$receipt_home" || -L "$receipt_home" ]] && return 0
    fi
    if [[ "$created_group" == "1" ]] \
        && getent group "$receipt_user" >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

write_install_receipt_payload() {
    local target_user="$1"
    local target_home="$2"
    local target_uid="$3"
    local target_gid="$4"
    local created_user="$5"
    local created_group="$6"
    local decommission_state="$7"
    local identity_token="$8"
    local receipt_dir
    receipt_dir="$(dirname "$INSTALL_RECEIPT_FILE")"
    if [[ -L "$receipt_dir" ]]; then
        ui_error "Refusing to write installer receipt through symlink ${receipt_dir}"
        return 1
    fi
    if [[ "$INSTALL_RECEIPT_FILE" == "/var/lib/comis-installer/receipt" ]]; then
        install -d -m 0700 -o 0 -g 0 "$receipt_dir"
    else
        install -d -m 0700 "$receipt_dir"
    fi

    local tmp staged
    tmp="$(mktempfile)"
    staged="${INSTALL_RECEIPT_FILE}.comis.$$"
    if [[ -e "$staged" || -L "$staged" ]]; then
        ui_error "Refusing to replace unexpected staged receipt ${staged}"
        return 1
    fi
    TMPFILES+=("$staged")
    cat > "$tmp" <<RECEIPT
# managed-by: comis-installer
target_user=${target_user}
target_home=${target_home}
target_uid=${target_uid}
target_gid=${target_gid}
created_user=${created_user}
created_group=${created_group}
decommission_state=${decommission_state}
identity_token=${identity_token}
RECEIPT
    local receipt_installed=0
    if [[ "$INSTALL_RECEIPT_FILE" == "/var/lib/comis-installer/receipt" ]]; then
        install -m 0600 -o 0 -g 0 "$tmp" "$staged" && receipt_installed=1
    else
        install -m 0600 "$tmp" "$staged" && receipt_installed=1
    fi
    if [[ "$receipt_installed" != "1" ]] \
        || ! mv -f "$staged" "$INSTALL_RECEIPT_FILE"; then
        rm -f "$staged" 2>/dev/null || true
        ui_error "Could not write installer receipt atomically at ${INSTALL_RECEIPT_FILE}"
        return 1
    fi
    install_receipt_is_valid
}

update_install_receipt_decommission_state() {
    local expected_state="$1"
    local next_state="$2"
    install_receipt_is_valid || return 1
    [[ "$(install_receipt_raw_value decommission_state)" == "$expected_state" ]] || return 1
    case "${expected_state}:${next_state}" in
        active:removing|removing:removed) ;;
        *) return 1 ;;
    esac
    write_install_receipt_payload \
        "$(install_receipt_raw_value target_user)" \
        "$(install_receipt_raw_value target_home)" \
        "$(install_receipt_raw_value target_uid)" \
        "$(install_receipt_raw_value target_gid)" \
        "$(install_receipt_raw_value created_user)" \
        "$(install_receipt_raw_value created_group)" \
        "$next_state" \
        "$(install_receipt_raw_value identity_token)"
}

write_install_receipt() {
    local target_user="$1"
    local target_home="$2"
    local created_user="$3"
    local created_group="$4"
    local requested_identity_token="${5:-}"
    [[ "$OS" == "linux" ]] && is_root || return 0
    [[ "$target_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || return 1
    install_receipt_home_is_safe "$target_home" || return 1
    [[ "$created_user" =~ ^[01]$ && "$created_group" =~ ^[01]$ ]] || return 1
    local target_uid target_gid
    target_uid="$(id -u "$target_user" 2>/dev/null || true)"
    target_gid="$(id -g "$target_user" 2>/dev/null || true)"
    [[ "$target_uid" =~ ^[0-9]+$ && "$target_gid" =~ ^[0-9]+$ ]] || return 1

    if [[ -e "$INSTALL_RECEIPT_FILE" || -L "$INSTALL_RECEIPT_FILE" ]]; then
        if ! install_receipt_is_valid; then
            ui_error "Refusing to overwrite invalid installer receipt at ${INSTALL_RECEIPT_FILE}"
            return 1
        fi
        local receipt_user receipt_home
        receipt_user="$(install_receipt_value target_user)"
        receipt_home="$(install_receipt_value target_home)"
        if [[ "$receipt_user" != "$target_user" || "$receipt_home" != "$target_home" ]]; then
            ui_error "Installer receipt belongs to ${receipt_user} at ${receipt_home}; refusing to replace it"
            return 1
        fi
        if [[ "$(install_receipt_value decommission_state)" != "active" ]]; then
            ui_error "Installer receipt is already decommissioning; finish removal before reinstalling"
            return 1
        fi
        # A matching active receipt already carries the original ownership
        # decision. Rewriting it could race a concurrent active→removing
        # transition and must never re-authorize a decommissioning account.
        return 0
    fi

    local identity_token="none"
    if install_receipt_created_user "$target_user" "$target_home"; then
        created_user=1
        [[ "$(install_receipt_value created_group 2>/dev/null || true)" == "1" ]] && created_group=1
        identity_token="$(install_receipt_value identity_token)"
    elif [[ "$created_user" == "1" ]]; then
        identity_token="$requested_identity_token"
        [[ "$identity_token" =~ ^[a-f0-9]{64}$ ]] || return 1
    fi
    if [[ "$created_user" == "1" ]] \
        && ! write_install_identity_marker "$target_home" "$identity_token"; then
        ui_error "Could not create the dedicated account identity marker"
        return 1
    fi

    write_install_receipt_payload "$target_user" "$target_home" "$target_uid" "$target_gid" \
        "$created_user" "$created_group" "active" "$identity_token"
}

create_comis_user() {
    if comis_user_exists; then
        local existing_home
        existing_home="$(getent passwd "$COMIS_USER" 2>/dev/null | cut -d: -f6)"
        if [[ "$existing_home" == /* && "$existing_home" != "/" ]]; then
            local existing_marker
            existing_marker="$(install_identity_marker_path "$existing_home")"
            if [[ ! -e "$INSTALL_RECEIPT_FILE" && ! -L "$INSTALL_RECEIPT_FILE" ]] \
                && { install_account_has_identity_comment "$COMIS_USER" \
                    || [[ -e "$existing_marker" || -L "$existing_marker" ]]; }; then
                ui_error "Installer-created account evidence exists without an ownership receipt"
                ui_info "Refusing to classify ${COMIS_USER} as a pre-existing account; restore the receipt or remove the orphaned account explicitly"
                return 1
            fi
            write_install_receipt "$COMIS_USER" "$existing_home" 0 0 "none"
        fi
        ui_success "User '$COMIS_USER' already exists"
        return 0
    fi

    ui_info "Creating dedicated system user '$COMIS_USER'"
    local group_existed=0
    getent group "$COMIS_USER" >/dev/null 2>&1 && group_existed=1
    local identity_token account_comment
    identity_token="$(generate_install_identity_token)" || return 1
    account_comment="$(install_account_identity_comment "$identity_token")" || return 1
    useradd --system --create-home --shell /bin/bash \
        --comment "$account_comment" "$COMIS_USER"

    # Allow the comis user to read journalctl logs for `comis daemon logs`
    if getent group systemd-journal >/dev/null 2>&1; then
        usermod -aG systemd-journal "$COMIS_USER" 2>/dev/null || true
    fi

    # Ensure the user has a .bashrc so PATH exports persist across logins
    local comis_home
    comis_home="$(eval echo "~$COMIS_USER")"
    local created_group=0
    if [[ "$group_existed" == "0" ]] && getent group "$COMIS_USER" >/dev/null 2>&1; then
        created_group=1
    fi
    if ! write_install_receipt \
        "$COMIS_USER" "$comis_home" 1 "$created_group" "$identity_token"; then
        ui_error "Could not record ownership of the dedicated Comis account"
        userdel -r "$COMIS_USER" 2>/dev/null || userdel "$COMIS_USER" 2>/dev/null || true
        if [[ "$created_group" == "1" ]]; then
            groupdel "$COMIS_USER" 2>/dev/null || true
        fi
        if id "$COMIS_USER" >/dev/null 2>&1; then
            ui_error "Could not roll back the unrecorded dedicated account"
        fi
        return 1
    fi
    if [[ ! -f "$comis_home/.bashrc" ]]; then
        touch "$comis_home/.bashrc"
        chown "$COMIS_USER:$COMIS_USER" "$comis_home/.bashrc"
    fi

    ui_success "User '$COMIS_USER' created (home: $comis_home)"
}

install_system_deps_as_root() {
    # Install Node.js and Git as root before switching to the dedicated user
    ui_stage "Preparing system (as root)"

    if ! check_node; then
        install_node
    fi
    if ! check_git; then
        install_git
    fi

    # uv/uvx for Python-based MCP servers (e.g. nanobanana) and rust/cargo for
    # the agent exec sandbox toolchain matrix. Both run even when Node was
    # already present (install_uv / install_rust are not part of install_node).
    # Linux only - macOS users install uv/rust separately via brew/rustup-init
    # if needed (the daemon is Linux-only anyway).
    if [[ "$OS" == "linux" ]]; then
        install_uv
        install_rust
        # No-op unless --with-browser was passed. Runs here so the comis user
        # (created next) inherits a host with Chromium already in /usr/bin.
        install_browser_deps_linux || true
    fi

    ui_success "System dependencies ready"
}

# Materialize the currently-running script at $dest - works for a file-based
# invocation ($0) and for a curl|bash pipe (bash's script fd, else re-download).
stage_install_script() {
    local dest="$1"
    if [[ -f "$0" ]]; then
        cp "$0" "$dest"
    else
        if [[ -f "/proc/self/fd/255" ]]; then
            cp /proc/self/fd/255 "$dest" 2>/dev/null || true
        fi
        if [[ ! -s "$dest" ]]; then
            download_file "https://comis.ai/install.sh" "$dest"
        fi
    fi
    chmod +x "$dest"
}

reexec_as_comis_user() {
    local comis_home
    comis_home="$(eval echo "~$COMIS_USER")"

    # Keep privileged staging outside the service user's writable home. A
    # root-owned randomized directory prevents pre-existing paths from
    # redirecting either copy through a symbolic link.
    local handoff_dir
    if ! handoff_dir="$(mktemp -d /tmp/comis-install.XXXXXXXXXX)"; then
        ui_error "Could not create a secure installer handoff directory"
        return 1
    fi
    chmod 0711 "$handoff_dir"

    # Forward relevant args and env to the re-exec
    local -a forwarded_args=()
    [[ "$NO_INIT" == "1" ]] && forwarded_args+=(--no-init)
    [[ "$NO_PROMPT" == "1" ]] && forwarded_args+=(--no-prompt)
    [[ "$DRY_RUN" == "1" ]] && forwarded_args+=(--dry-run)
    [[ "$VERBOSE" == "1" ]] && forwarded_args+=(--verbose)
    [[ -n "$INSTALL_METHOD" ]] && forwarded_args+=(--install-method "$INSTALL_METHOD")
    [[ "$COMIS_VERSION" != "latest" ]] && forwarded_args+=(--version "$COMIS_VERSION")
    [[ "$USE_BETA" == "1" ]] && forwarded_args+=(--beta)
    # Stage a local --tarball into the comis user's home so the re-exec (which
    # runs as the unprivileged comis user) can read it. Operators commonly place
    # the tarball under /root or another path the comis user cannot read; the
    # forwarded path would then fail with "--tarball path does not exist". Copy
    # it into the secure handoff directory and forward that path instead.
    local staged_tarball=""
    if [[ -n "$COMIS_TARBALL" ]]; then
        staged_tarball="${handoff_dir}/comisai.tgz"
        if cp "$COMIS_TARBALL" "$staged_tarball" 2>/dev/null; then
            chown "$COMIS_USER:$COMIS_USER" "$staged_tarball" 2>/dev/null || true
            chmod 0600 "$staged_tarball" 2>/dev/null || true
            forwarded_args+=(--tarball "$staged_tarball")
        else
            ui_warn "Could not stage tarball for the user handoff; forwarding original path"
            forwarded_args+=(--tarball "$COMIS_TARBALL")
        fi
    fi
    # Browser-tool flags need to propagate so the reexec'd child's run of
    # install_cloakbrowser() (in the main flow) and register_service can see
    # them. `su -` strips most env so we forward as explicit args.
    [[ "$WITH_BROWSER" == "1" ]] && forwarded_args+=(--with-browser)
    [[ "$WITH_XVFB" == "1" ]] && forwarded_args+=(--with-xvfb)
    [[ "$WITH_CLOAKBROWSER" == "1" ]] && forwarded_args+=(--with-cloakbrowser)

    # Copy the install script to a location the comis user can read
    local script_copy="${handoff_dir}/install.sh"
    stage_install_script "$script_copy"
    chown "$COMIS_USER:$COMIS_USER" "$script_copy"
    chmod 0700 "$script_copy"

    ui_info "Handing off to user '$COMIS_USER'"
    echo ""

    # Re-exec as the comis user with COMIS_REEXEC=1 to skip the handoff loop
    local escaped_arg escaped_script forwarded_command
    printf -v escaped_script '%q' "$script_copy"
    forwarded_command="COMIS_REEXEC=1 bash $escaped_script"
    for arg in "${forwarded_args[@]}"; do
        printf -v escaped_arg '%q' "$arg"
        forwarded_command+=" $escaped_arg"
    done
    local rc=0
    if su - "$COMIS_USER" -c "$forwarded_command"; then
        rc=0
    else
        rc=$?
    fi

    rm -rf "$handoff_dir" 2>/dev/null || true

    return "$rc"
}

maybe_sudo() {
    if is_root; then
        if [[ "${1:-}" == "-E" ]]; then
            shift
        fi
        "$@"
    else
        sudo "$@"
    fi
}

require_sudo() {
    if [[ "$OS" != "linux" ]]; then
        return 0
    fi
    if is_root; then
        return 0
    fi
    if command -v sudo &> /dev/null; then
        if ! sudo -n true >/dev/null 2>&1; then
            ui_info "Administrator privileges required; enter your password"
            sudo -v
        fi
        return 0
    fi
    ui_error "sudo is required for system installs on Linux"
    echo "  Install sudo or re-run as root."
    exit 1
}

install_git() {
    if [[ "$OS" == "macos" ]]; then
        run_quiet_step "Installing Git" brew install git
    elif [[ "$OS" == "linux" ]]; then
        require_sudo
        if command -v apt-get &> /dev/null; then
            if is_root; then
                run_quiet_step "Updating package index" apt-get update
                run_quiet_step "Installing Git" apt-get install -y -qq git
            else
                run_quiet_step "Updating package index" sudo apt-get update
                run_quiet_step "Installing Git" sudo apt-get install -y -qq git
            fi
        elif command -v dnf &> /dev/null; then
            if is_root; then
                run_quiet_step "Installing Git" dnf install -y git
            else
                run_quiet_step "Installing Git" sudo dnf install -y git
            fi
        elif command -v yum &> /dev/null; then
            if is_root; then
                run_quiet_step "Installing Git" yum install -y git
            else
                run_quiet_step "Installing Git" sudo yum install -y git
            fi
        else
            ui_error "Could not detect package manager for Git"
            exit 1
        fi
    fi
    ui_success "Git installed"
}

fix_npm_permissions() {
    if [[ "$OS" != "linux" ]]; then
        return 0
    fi

    local npm_prefix
    npm_prefix="$(npm config get prefix 2>/dev/null || true)"
    if [[ -z "$npm_prefix" ]]; then
        return 0
    fi

    if [[ -w "$npm_prefix" || -w "$npm_prefix/lib" ]]; then
        return 0
    fi

    ui_info "Configuring npm for user-local installs"
    mkdir -p "$HOME/.npm-global"
    npm config set prefix "$HOME/.npm-global"

    # shellcheck disable=SC2016
    local path_line='export PATH="$HOME/.npm-global/bin:$PATH"'

    # .profile is critical: login shells (su -, ssh, cron) read it but skip
    # .bashrc's non-interactive guard. Write there first, then .bashrc/.zshrc
    # for interactive sessions.
    for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
        if [[ -f "$rc" || "$rc" == "$HOME/.bashrc" ]]; then
            if ! grep -qF ".npm-global" "$rc" 2>/dev/null; then
                echo "$path_line" >> "$rc"
            fi
        fi
    done

    # Safety net: if .profile exists but the write somehow failed, force it
    if [[ -f "$HOME/.profile" ]] && ! grep -qF ".npm-global" "$HOME/.profile" 2>/dev/null; then
        echo "$path_line" >> "$HOME/.profile" 2>/dev/null || true
    fi

    export PATH="$HOME/.npm-global/bin:$PATH"
    ui_success "npm configured for user installs"
}

ensure_comis_bin_link() {
    local npm_root=""
    npm_root="$(npm root -g 2>/dev/null || true)"
    if [[ -z "$npm_root" || ! -d "$npm_root/comisai" ]]; then
        return 1
    fi
    local npm_bin=""
    npm_bin="$(npm_global_bin_dir || true)"
    if [[ -z "$npm_bin" ]]; then
        return 1
    fi
    mkdir -p "$npm_bin"
    if [[ ! -x "${npm_bin}/comis" ]]; then
        ln -sf "$npm_root/comisai/dist/cli.js" "${npm_bin}/comis"
        ui_info "Created comis bin link at ${npm_bin}/comis"
    fi
    return 0
}

check_existing_comis() {
    if [[ -n "$(type -P comis 2>/dev/null || true)" ]]; then
        ui_info "Existing Comis installation detected, upgrading"
        return 0
    fi
    return 1
}

set_pnpm_cmd() {
    PNPM_CMD=("$@")
}

pnpm_cmd_pretty() {
    if [[ ${#PNPM_CMD[@]} -eq 0 ]]; then
        echo ""
        return 1
    fi
    printf '%s' "${PNPM_CMD[*]}"
    return 0
}

pnpm_cmd_is_ready() {
    if [[ ${#PNPM_CMD[@]} -eq 0 ]]; then
        return 1
    fi
    "${PNPM_CMD[@]}" --version >/dev/null 2>&1
}

detect_pnpm_cmd() {
    if command -v pnpm &> /dev/null; then
        set_pnpm_cmd pnpm
        return 0
    fi
    if command -v corepack &> /dev/null; then
        if corepack pnpm --version >/dev/null 2>&1; then
            set_pnpm_cmd corepack pnpm
            return 0
        fi
    fi
    return 1
}

ensure_pnpm() {
    if detect_pnpm_cmd && pnpm_cmd_is_ready; then
        ui_success "pnpm ready ($(pnpm_cmd_pretty))"
        return 0
    fi

    if command -v corepack &> /dev/null; then
        ui_info "Configuring pnpm via Corepack"
        corepack enable >/dev/null 2>&1 || true
        if ! run_quiet_step "Activating pnpm" corepack prepare pnpm@10 --activate; then
            ui_warn "Corepack pnpm activation failed; falling back"
        fi
        refresh_shell_command_cache
        if detect_pnpm_cmd && pnpm_cmd_is_ready; then
            if [[ "${PNPM_CMD[*]}" == "corepack pnpm" ]]; then
                ui_warn "pnpm shim not on PATH; using corepack pnpm fallback"
            fi
            ui_success "pnpm ready ($(pnpm_cmd_pretty))"
            return 0
        fi
    fi

    ui_info "Installing pnpm via npm"
    fix_npm_permissions
    run_quiet_step "Installing pnpm" npm install -g pnpm@10
    refresh_shell_command_cache
    if detect_pnpm_cmd && pnpm_cmd_is_ready; then
        ui_success "pnpm ready ($(pnpm_cmd_pretty))"
        return 0
    fi

    ui_error "pnpm installation failed"
    return 1
}

ensure_pnpm_binary_for_scripts() {
    if command -v pnpm >/dev/null 2>&1; then
        return 0
    fi

    if command -v corepack >/dev/null 2>&1; then
        ui_info "Ensuring pnpm command is available"
        corepack enable >/dev/null 2>&1 || true
        corepack prepare pnpm@10 --activate >/dev/null 2>&1 || true
        refresh_shell_command_cache
        if command -v pnpm >/dev/null 2>&1; then
            ui_success "pnpm command enabled via Corepack"
            return 0
        fi
    fi

    if [[ "${PNPM_CMD[*]}" == "corepack pnpm" ]] && command -v corepack >/dev/null 2>&1; then
        ensure_user_local_bin_on_path
        local user_pnpm="${HOME}/.local/bin/pnpm"
        cat >"${user_pnpm}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec corepack pnpm "$@"
EOF
        chmod +x "${user_pnpm}"
        refresh_shell_command_cache

        if command -v pnpm >/dev/null 2>&1; then
            ui_warn "pnpm shim not on PATH; installed user-local wrapper at ${user_pnpm}"
            return 0
        fi
    fi

    ui_error "pnpm command not available on PATH"
    ui_info "Install pnpm globally (npm install -g pnpm@10) and retry"
    return 1
}

run_pnpm() {
    if ! pnpm_cmd_is_ready; then
        ensure_pnpm
    fi
    "${PNPM_CMD[@]}" "$@"
}

ensure_user_local_bin_on_path() {
    local target="$HOME/.local/bin"
    mkdir -p "$target"

    export PATH="$target:$PATH"

    # shellcheck disable=SC2016
    local path_line='export PATH="$HOME/.local/bin:$PATH"'
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
        if [[ -f "$rc" || "$rc" == "$HOME/.bashrc" ]]; then
            if ! grep -q ".local/bin" "$rc" 2>/dev/null; then
                echo "$path_line" >> "$rc"
            fi
        fi
    done
}

npm_global_bin_dir() {
    local prefix=""
    prefix="$(npm prefix -g 2>/dev/null || true)"
    if [[ -n "$prefix" ]]; then
        if [[ "$prefix" == /* ]]; then
            echo "${prefix%/}/bin"
            return 0
        fi
    fi

    prefix="$(npm config get prefix 2>/dev/null || true)"
    if [[ -n "$prefix" && "$prefix" != "undefined" && "$prefix" != "null" ]]; then
        if [[ "$prefix" == /* ]]; then
            echo "${prefix%/}/bin"
            return 0
        fi
    fi

    echo ""
    return 1
}

refresh_shell_command_cache() {
    hash -r 2>/dev/null || true
}

path_has_dir() {
    local path="$1"
    local dir="${2%/}"
    if [[ -z "$dir" ]]; then
        return 1
    fi
    case ":${path}:" in
        *":${dir}:"*) return 0 ;;
        *) return 1 ;;
    esac
}

warn_shell_path_missing_dir() {
    local dir="${1%/}"
    local label="$2"
    if [[ -z "$dir" ]]; then
        return 0
    fi
    if path_has_dir "$ORIGINAL_PATH" "$dir"; then
        return 0
    fi

    echo ""
    ui_warn "PATH missing ${label}: ${dir}"
    echo "  This can make comis show as \"command not found\" in new terminals."
    echo "  Fix (zsh: ~/.zshrc, bash: ~/.bashrc):"
    echo "    export PATH=\"${dir}:\$PATH\""
}

ensure_npm_global_bin_on_path() {
    local bin_dir=""
    bin_dir="$(npm_global_bin_dir || true)"
    if [[ -n "$bin_dir" ]]; then
        export PATH="${bin_dir}:$PATH"
    fi
}

maybe_nodenv_rehash() {
    if command -v nodenv &> /dev/null; then
        nodenv rehash >/dev/null 2>&1 || true
    fi
}

warn_comis_not_found() {
    ui_warn "Installed, but comis is not discoverable on PATH in this shell"
    echo "  Try: hash -r (bash) or rehash (zsh), then retry."
    local t=""
    t="$(type -t comis 2>/dev/null || true)"
    if [[ "$t" == "alias" || "$t" == "function" ]]; then
        ui_warn "Found a shell ${t} named comis; it may shadow the real binary"
    fi
    if command -v nodenv &> /dev/null; then
        echo -e "Using nodenv? Run: ${INFO}nodenv rehash${NC}"
    fi

    local npm_prefix=""
    npm_prefix="$(npm prefix -g 2>/dev/null || true)"
    local npm_bin=""
    npm_bin="$(npm_global_bin_dir 2>/dev/null || true)"
    if [[ -n "$npm_prefix" ]]; then
        echo -e "npm prefix -g: ${INFO}${npm_prefix}${NC}"
    fi
    if [[ -n "$npm_bin" ]]; then
        echo -e "npm bin -g: ${INFO}${npm_bin}${NC}"
        echo -e "If needed: ${INFO}export PATH=\"${npm_bin}:\\$PATH\"${NC}"
    fi
}

resolve_comis_bin() {
    refresh_shell_command_cache
    local resolved=""
    resolved="$(type -P comis 2>/dev/null || true)"
    if [[ -n "$resolved" && -x "$resolved" ]]; then
        echo "$resolved"
        return 0
    fi

    ensure_npm_global_bin_on_path
    refresh_shell_command_cache
    resolved="$(type -P comis 2>/dev/null || true)"
    if [[ -n "$resolved" && -x "$resolved" ]]; then
        echo "$resolved"
        return 0
    fi

    local npm_bin=""
    npm_bin="$(npm_global_bin_dir || true)"
    if [[ -n "$npm_bin" && -x "${npm_bin}/comis" ]]; then
        echo "${npm_bin}/comis"
        return 0
    fi

    maybe_nodenv_rehash
    refresh_shell_command_cache
    resolved="$(type -P comis 2>/dev/null || true)"
    if [[ -n "$resolved" && -x "$resolved" ]]; then
        echo "$resolved"
        return 0
    fi

    if [[ -n "$npm_bin" && -x "${npm_bin}/comis" ]]; then
        echo "${npm_bin}/comis"
        return 0
    fi

    echo ""
    return 1
}

install_comis_from_git() {
    local repo_dir="$1"
    local repo_url_https="https://github.com/comisai/comis.git"
    local repo_url_ssh="git@github.com:comisai/comis.git"

    if [[ -d "$repo_dir/.git" ]]; then
        ui_info "Installing Comis from git checkout: ${repo_dir}"
    else
        ui_info "Installing Comis from GitHub"
    fi

    if ! check_git; then
        install_git
    fi

    ensure_pnpm
    ensure_pnpm_binary_for_scripts

    if [[ ! -d "$repo_dir" ]]; then
        # Try SSH first (for developers with SSH keys), fall back to HTTPS.
        # BatchMode + short timeout ensure SSH fails fast when no key is configured.
        ui_info "Trying SSH clone..."
        if GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=5" \
           git clone "$repo_url_ssh" "$repo_dir" 2>/dev/null; then
            ui_success "Cloned via SSH"
        else
            rm -rf "$repo_dir" 2>/dev/null || true  # clean up partial SSH clone
            ui_info "SSH unavailable, cloning via HTTPS"
            run_quiet_step "Cloning Comis" git clone "$repo_url_https" "$repo_dir"
        fi
    fi

    if [[ "$GIT_UPDATE" == "1" ]]; then
        local porcelain=""
        porcelain="$(git -C "$repo_dir" status --porcelain 2>/dev/null || true)"
        if [[ -z "$porcelain" ]]; then
            if ! run_quiet_step "Updating repository" git -C "$repo_dir" pull --rebase; then
                git -C "$repo_dir" rebase --abort >/dev/null 2>&1 || true
                ui_error "Could not update the source checkout; installation stopped"
                return 1
            fi
        else
            # Auto-stash local changes, pull, then restore
            local stash_name=""
            stash_name="comis-install-autostash-$(date -u +%Y%m%d-%H%M%S)"
            local previous_stash=""
            previous_stash="$(git -C "$repo_dir" rev-parse --verify refs/stash 2>/dev/null || true)"
            ui_info "Local changes detected; stashing before update"
            if ! git -C "$repo_dir" stash push --include-untracked -m "$stash_name" >/dev/null 2>&1; then
                ui_error "Could not preserve local changes; refusing to update the checkout"
                return 1
            fi
            local stash_ref=""
            stash_ref="$(git -C "$repo_dir" rev-parse --verify refs/stash 2>/dev/null || true)"
            if [[ -z "$stash_ref" || "$stash_ref" == "$previous_stash" ]]; then
                ui_error "Git did not create the expected safety stash; refusing to update the checkout"
                return 1
            fi

            local update_rc=0
            if ! run_quiet_step "Updating repository" git -C "$repo_dir" pull --rebase; then
                update_rc=1
                git -C "$repo_dir" rebase --abort >/dev/null 2>&1 || true
            fi

            ui_info "Restoring stashed local changes"
            if git -C "$repo_dir" stash pop --index 'stash@{0}' >/dev/null 2>&1; then
                ui_success "Local changes restored"
            else
                ui_error "Could not restore local changes cleanly; installation stopped"
                ui_info "Your safety stash is preserved in: git -C ${repo_dir} stash list"
                return 1
            fi

            if [[ "$update_rc" -ne 0 ]]; then
                ui_error "Could not update the source checkout; local changes were restored"
                return 1
            fi
        fi
    fi

    SHARP_IGNORE_GLOBAL_LIBVIPS="$SHARP_IGNORE_GLOBAL_LIBVIPS" run_quiet_step "Installing dependencies" run_pnpm -C "$repo_dir" install
    run_quiet_step "Building Comis" run_pnpm -C "$repo_dir" build

    ensure_user_local_bin_on_path

    cat > "$HOME/.local/bin/comis" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "${repo_dir}/packages/cli/dist/cli.js" "\$@"
EOF
    chmod +x "$HOME/.local/bin/comis"
    ui_success "Comis wrapper installed to \$HOME/.local/bin/comis"
    ui_info "This checkout uses pnpm - run pnpm install (or corepack pnpm install) for deps"
}

resolve_beta_version() {
    local beta=""
    beta="$(npm view comisai dist-tags.beta 2>/dev/null || true)"
    if [[ -z "$beta" || "$beta" == "undefined" || "$beta" == "null" ]]; then
        return 1
    fi
    echo "$beta"
}

install_comis() {
    local package_name="comisai"
    local install_spec=""

    # Local tarball overrides everything else - skips version resolution
    if [[ -n "$COMIS_TARBALL" ]]; then
        if [[ ! -f "$COMIS_TARBALL" ]]; then
            ui_error "--tarball path does not exist: ${COMIS_TARBALL}"
            exit 2
        fi
        install_spec="$COMIS_TARBALL"
        ui_info "Installing Comis from local tarball: ${COMIS_TARBALL}"

        if ! install_comis_npm "${install_spec}"; then
            ui_warn "npm install from tarball failed; retrying after cleanup"
            cleanup_npm_comis_paths
            install_comis_npm "${install_spec}"
        fi

        ensure_comis_bin_link || true
        ui_success "Comis installed"
        return 0
    fi

    if [[ "$USE_BETA" == "1" ]]; then
        local beta_version=""
        beta_version="$(resolve_beta_version || true)"
        if [[ -n "$beta_version" ]]; then
            COMIS_VERSION="$beta_version"
            ui_info "Beta tag detected (${beta_version})"
        else
            COMIS_VERSION="latest"
            ui_info "No beta tag found; using latest"
        fi
    fi

    if [[ -z "${COMIS_VERSION}" ]]; then
        COMIS_VERSION="latest"
    fi

    local resolved_version=""
    resolved_version="$(npm view "${package_name}@${COMIS_VERSION}" version 2>/dev/null || true)"
    if [[ -n "$resolved_version" ]]; then
        ui_info "Installing Comis v${resolved_version}"
    else
        ui_info "Installing Comis (${COMIS_VERSION})"
    fi
    if [[ "${COMIS_VERSION}" == "latest" ]]; then
        install_spec="${package_name}@latest"
    else
        install_spec="${package_name}@${COMIS_VERSION}"
    fi

    if ! install_comis_npm "${install_spec}"; then
        ui_warn "npm install failed; retrying"
        cleanup_npm_comis_paths
        install_comis_npm "${install_spec}"
    fi

    if [[ "${COMIS_VERSION}" == "latest" && "${package_name}" == "comisai" ]]; then
        if ! resolve_comis_bin &> /dev/null; then
            ui_warn "npm install comisai@latest failed; retrying comisai@next"
            cleanup_npm_comis_paths
            install_comis_npm "comisai@next"
        fi
    fi

    ensure_comis_bin_link || true

    ui_success "Comis installed"
}

run_doctor() {
    ui_info "Running doctor to check system health"
    local comis_bin="${COMIS_BIN:-}"
    if [[ -z "$comis_bin" ]]; then
        comis_bin="$(resolve_comis_bin || true)"
    fi
    if [[ -z "$comis_bin" ]]; then
        ui_info "Skipping doctor (comis not on PATH yet)"
        warn_comis_not_found
        return 0
    fi
    run_quiet_step "Running doctor" "$comis_bin" doctor || true
    ui_success "Doctor complete"
}

is_daemon_running() {
    local comis_bin="$1"
    if [[ -z "$comis_bin" ]]; then
        return 1
    fi

    local status_output=""
    status_output="$("$comis_bin" daemon status 2>/dev/null || true)"
    if [[ -z "$status_output" ]]; then
        return 1
    fi

    echo "$status_output" | grep -qiE '(running|online|active)' 2>/dev/null
}

restart_daemon_if_running() {
    local comis_bin="${COMIS_BIN:-}"
    if [[ -z "$comis_bin" ]]; then
        comis_bin="$(resolve_comis_bin || true)"
    fi
    if [[ -z "$comis_bin" ]]; then
        return 0
    fi

    if ! is_daemon_running "$comis_bin"; then
        return 0
    fi

    ui_info "Restarting running daemon"
    if run_quiet_step "Restarting daemon" "$comis_bin" daemon stop && "$comis_bin" daemon start; then
        ui_success "Daemon restarted"
    else
        ui_warn "Daemon restart failed; try: comis daemon stop && comis daemon start"
    fi
}

resolve_comis_version() {
    local version=""
    local comis_bin="${COMIS_BIN:-}"
    if [[ -z "$comis_bin" ]] && command -v comis &> /dev/null; then
        comis_bin="$(command -v comis)"
    fi
    if [[ -n "$comis_bin" ]]; then
        version=$("$comis_bin" --version 2>/dev/null | head -n 1 | tr -d '\r')
    fi
    if [[ -z "$version" ]]; then
        local npm_root=""
        npm_root=$(npm root -g 2>/dev/null || true)
        if [[ -n "$npm_root" && -f "$npm_root/comisai/package.json" ]]; then
            version=$(node -e "console.log(require('${npm_root}/comisai/package.json').version)" 2>/dev/null || true)
        fi
    fi
    echo "$version"
}

# ---------------------------------------------------------------------------
# Service manager subsystem
# ---------------------------------------------------------------------------

# Detect whether this host has a running systemd (as opposed to just the binaries).
# Two-stage check: /run/systemd/system must exist AND is-system-running must
# report something other than "offline". Returns 0 if usable.
has_working_systemd() {
    [[ -d /run/systemd/system ]] || return 1
    # is-system-running exits 0 on "running" and 1 on "degraded" (still OK).
    # On "offline" or "unknown" the daemon isn't really managing the system.
    local state
    state="$(systemctl is-system-running --quiet 2>/dev/null; echo $?)"
    case "$state" in
        0|1) return 0 ;;
        *)   return 1 ;;
    esac
}

# User-scope systemd requires DBus + XDG_RUNTIME_DIR to be set up. On headless
# Linux boxes, these only appear after loginctl enable-linger.
has_working_user_systemd() {
    [[ -n "${XDG_RUNTIME_DIR:-}" ]] || return 1
    [[ -S "${XDG_RUNTIME_DIR}/bus" || -S "${XDG_RUNTIME_DIR}/systemd/private" ]] || return 1
    systemctl --user --no-pager list-units >/dev/null 2>&1
}

is_wsl() {
    [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi 'microsoft' /proc/version 2>/dev/null
}

# Detect version-manager-managed Node (nvm, nodenv, fnm, volta). Version-manager
# paths bake the version string into the systemd unit's ExecStart, so service
# mode requires system-installed Node.
node_is_version_manager_managed() {
    local node_bin
    node_bin="${1:-$(command -v node 2>/dev/null || true)}"
    [[ -z "$node_bin" ]] && return 1
    local resolved
    resolved="$(readlink -f "$node_bin" 2>/dev/null || echo "$node_bin")"
    case "$resolved" in
        */.nvm/*|*/.nodenv/*|*/.fnm/*|*/.volta/*|*/fnm_multishells/*)
            return 0 ;;
        *)
            return 1 ;;
    esac
}

# Decide which service manager to use.
# Sets RESOLVED_SERVICE_MANAGER to one of: systemd | systemd-user | pm2 | none
resolve_service_manager() {
    local requested="$SERVICE_MANAGER"

    case "$requested" in
        auto|systemd|systemd-user|pm2|none) ;;
        *)
            ui_error "Invalid --service value: ${requested}"
            echo "Valid values: auto, systemd, systemd-user, pm2, none"
            exit 2
            ;;
    esac

    # Explicit selections validate immediately
    if [[ "$requested" == "systemd" ]]; then
        if ! has_working_systemd; then
            ui_error "--service systemd requested but systemd is not running on this host"
            exit 2
        fi
        if ! is_root; then
            ui_error "--service systemd requires root (use --service systemd-user for non-root)"
            exit 2
        fi
        RESOLVED_SERVICE_MANAGER="systemd"
        return 0
    fi

    if [[ "$requested" == "systemd-user" ]]; then
        if ! has_working_systemd; then
            ui_error "--service systemd-user requested but systemd is not running on this host"
            exit 2
        fi
        RESOLVED_SERVICE_MANAGER="systemd-user"
        return 0
    fi

    if [[ "$requested" == "pm2" ]]; then
        RESOLVED_SERVICE_MANAGER="pm2"
        return 0
    fi

    if [[ "$requested" == "none" ]]; then
        RESOLVED_SERVICE_MANAGER="none"
        return 0
    fi

    # auto
    if [[ "$OS" == "macos" ]]; then
        RESOLVED_SERVICE_MANAGER="pm2"
        return 0
    fi

    if [[ "$OS" == "linux" ]]; then
        if has_working_systemd; then
            if is_root; then
                RESOLVED_SERVICE_MANAGER="systemd"
            else
                RESOLVED_SERVICE_MANAGER="systemd-user"
            fi
            return 0
        fi

        # No systemd - user almost certainly wants WSL guidance
        if is_wsl; then
            ui_warn "WSL detected without systemd."
            echo "  To enable systemd on WSL, add this to /etc/wsl.conf (Windows side):"
            echo "    [boot]"
            echo "    systemd=true"
            echo "  Then from PowerShell/cmd: wsl --shutdown"
            echo "  After relaunching WSL, re-run this installer."
            ui_info "Falling back to --service none for this install."
        else
            ui_warn "systemd not detected; falling back to --service none."
        fi
        RESOLVED_SERVICE_MANAGER="none"
        return 0
    fi

    RESOLVED_SERVICE_MANAGER="none"
}

# The installer provisions comis-xvfb.service only as a system unit. Other
# service modes cannot assume DISPLAY=:99 exists unless a container entrypoint
# explicitly owns it. Keep Chromium available and downshift those modes to the
# supported headless fallback before the install plan is shown.
downshift_xvfb_for_service_manager() {
    if [[ "$WITH_XVFB" != "1" ]]; then
        return 0
    fi
    if [[ "$RESOLVED_SERVICE_MANAGER" == "systemd" || "$XVFB_EXTERNAL_RUNTIME" == "1" ]]; then
        return 0
    fi

    WITH_XVFB=0
    ui_warn "${RESOLVED_SERVICE_MANAGER} does not manage comis-xvfb.service; using headless browser mode"
    ui_info "For installer-managed headed mode, rerun as root with: sudo bash comis-install.sh --service systemd"
}

# Stop a direct-spawn daemon and remove its stale PID file before handing
# ownership to a service manager.
process_is_comis_daemon() {
    local pid="$1"
    local executable=""
    local proc_dir="/proc/${pid}"
    if [[ -r "${proc_dir}/cmdline" && -L "${proc_dir}/exe" ]]; then
        executable="$(readlink -f "${proc_dir}/exe" 2>/dev/null || true)"
        case "$(basename "$executable")" in
            node|nodejs) ;;
            *) return 1 ;;
        esac
        local arg
        while IFS= read -r -d '' arg; do
            case "$arg" in
                */node_modules/@comis/daemon/dist/daemon.js|*/packages/daemon/dist/daemon.js)
                    return 0
                    ;;
            esac
        done < "${proc_dir}/cmdline"
        return 1
    fi

    executable="$(ps -o comm= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    case "$(basename "$executable")" in
        node|nodejs) ;;
        *) return 1 ;;
    esac
    local process_command
    process_command="$(ps -ww -o command= -p "$pid" 2>/dev/null || true)"
    case "$process_command" in
        *"/node_modules/@comis/daemon/dist/daemon.js"*|*"/packages/daemon/dist/daemon.js"*) return 0 ;;
        *) return 1 ;;
    esac
}

cleanup_legacy_daemon_state() {
    local pid_file target_user
    # Determine the correct home for the target user
    local target_home="${HOME:-}"
    if [[ -n "${COMIS_SVC_HOME:-}" ]]; then
        target_home="$COMIS_SVC_HOME"
        target_user="${COMIS_SVC_USER:-$(id -un)}"
    elif [[ -n "${UNINSTALL_TARGET_HOME:-}" ]]; then
        target_home="$UNINSTALL_TARGET_HOME"
        target_user="${UNINSTALL_TARGET_USER:-$(id -un)}"
    else
        target_user="$(id -un)"
    fi
    pid_file="${target_home}/.comis/daemon.pid"

    [[ -e "$pid_file" || -L "$pid_file" ]] || return 0
    if [[ -L "$pid_file" || ! -f "$pid_file" ]]; then
        ui_error "Direct-daemon PID path is not a regular file; refusing to trust ${pid_file}"
        return 1
    fi

    local pid
    pid="$(tr -d '[:space:]' < "$pid_file" 2>/dev/null || true)"
    if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]]; then
        rm -f "$pid_file"
        ui_success "Removed invalid direct-daemon PID file"
        return 0
    fi

    if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$pid_file"
        ui_success "Removed stale direct-daemon PID file"
        return 0
    fi

    local expected_uid actual_uid
    expected_uid="$(id -u "$target_user" 2>/dev/null || true)"
    actual_uid="$(ps -o uid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ -z "$expected_uid" || "$actual_uid" != "$expected_uid" ]]; then
        ui_error "PID ${pid} is not owned by ${target_user}; refusing to signal it"
        return 1
    fi
    if ! process_is_comis_daemon "$pid"; then
        ui_error "PID ${pid} is not a recognized Comis daemon; refusing to signal it"
        return 1
    fi

    ui_info "Stopping direct-spawn daemon (PID ${pid}) before migrating to ${RESOLVED_SERVICE_MANAGER:-the selected service mode}"
    actual_uid="$(ps -o uid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$actual_uid" != "$expected_uid" ]] || ! process_is_comis_daemon "$pid"; then
        ui_error "Direct-daemon PID ${pid} changed identity before it could be stopped"
        return 1
    fi
    if [[ "$(id -u)" == "$expected_uid" ]]; then
        kill -TERM "$pid" 2>/dev/null || {
            ui_error "Could not stop direct-spawn daemon PID ${pid}"
            return 1
        }
    elif ! su - "$target_user" -c "kill -TERM ${pid}" 2>/dev/null; then
        ui_error "Could not stop direct-spawn daemon PID ${pid} as ${target_user}"
        return 1
    fi

    local waited=0
    while kill -0 "$pid" 2>/dev/null && [[ "$waited" -lt 10 ]]; do
        sleep 1
        waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
        ui_warn "Daemon did not stop gracefully; sending SIGKILL"
        if [[ "$(id -u)" == "$expected_uid" ]]; then
            kill -KILL "$pid" 2>/dev/null || true
        else
            su - "$target_user" -c "kill -KILL ${pid}" 2>/dev/null || true
        fi
    fi
    if kill -0 "$pid" 2>/dev/null; then
        ui_error "Direct-spawn daemon PID ${pid} is still running"
        return 1
    fi

    rm -f "$pid_file"
    [[ ! -e "$pid_file" && ! -L "$pid_file" ]] || return 1
    ui_success "Legacy daemon state cleared"
}

# Populate COMIS_NODE_BIN, COMIS_DAEMON_JS, COMIS_SVC_USER, COMIS_SVC_HOME,
# COMIS_DATA_DIR, COMIS_CONFIG_FILE based on the install method and service manager.
resolve_service_template_vars() {
    # Node binary - must be a real file, not a shim
    local node_bin="${SELECTED_NODE_BIN:-}"
    if [[ -z "$node_bin" ]]; then
        node_bin="$(command -v node 2>/dev/null || true)"
    fi
    if [[ -z "$node_bin" ]]; then
        ui_error "Could not locate the node binary."
        return 1
    fi

    # Resolve symlinks - systemd units need an absolute, stable path
    local resolved
    resolved="$(readlink -f "$node_bin" 2>/dev/null || echo "$node_bin")"
    COMIS_NODE_BIN="$resolved"

    # Reject version-manager Node for systemd/pm2 service mode
    if [[ "$RESOLVED_SERVICE_MANAGER" == "systemd" || "$RESOLVED_SERVICE_MANAGER" == "systemd-user" || "$RESOLVED_SERVICE_MANAGER" == "pm2" ]]; then
        if node_is_version_manager_managed "$resolved"; then
            ui_error "Service-managed Comis requires system-installed Node."
            echo "  Detected version-manager Node at: ${resolved}"
            echo "  Install system Node (the installer can do this) and re-run, or use --service none."
            return 1
        fi
    fi

    # Target service user (--no-user pins the service to the invoking user even
    # when a comis user is left over from an earlier dedicated-user install)
    if [[ "$RESOLVED_SERVICE_MANAGER" == "systemd" ]] && is_root && [[ "$NO_USER" != "1" ]] && [[ -n "${COMIS_USER:-}" ]] && comis_user_exists; then
        COMIS_SVC_USER="$COMIS_USER"
        COMIS_SVC_GROUP="$COMIS_USER"
    else
        COMIS_SVC_USER="$(id -un)"
        COMIS_SVC_GROUP="$(id -gn)"
    fi

    # Home directory for that user
    if [[ "$COMIS_SVC_USER" == "$(id -un)" ]]; then
        COMIS_SVC_HOME="$HOME"
    else
        COMIS_SVC_HOME="$(getent passwd "$COMIS_SVC_USER" 2>/dev/null | cut -d: -f6)"
        if [[ -z "$COMIS_SVC_HOME" ]]; then
            COMIS_SVC_HOME="/home/${COMIS_SVC_USER}"
        fi
    fi

    COMIS_DATA_DIR="${COMIS_SVC_HOME}/.comis"
    COMIS_CONFIG_FILE="${COMIS_DATA_DIR}/config.yaml"
    COMIS_WORKING_DIR="$COMIS_SVC_HOME"

    # Daemon entry point
    if [[ "$INSTALL_METHOD" == "git" ]]; then
        local git_dir="${GIT_DIR}"
        if [[ -n "${final_git_dir:-}" ]]; then
            git_dir="$final_git_dir"
        fi
        COMIS_DAEMON_JS="${git_dir}/packages/daemon/dist/daemon.js"
    else
        # npm install - probe known layouts under the global npm root.
        # The published `comisai` package bundles @comis/* under node_modules/;
        # a monorepo-style install instead exposes packages/daemon/.
        local npm_root=""
        if [[ "$COMIS_SVC_USER" == "$(id -un)" ]]; then
            npm_root="$(npm root -g 2>/dev/null || true)"
        else
            npm_root="$(su - "$COMIS_SVC_USER" -c 'npm root -g' 2>/dev/null || true)"
        fi

        local -a candidate_roots=()
        [[ -n "$npm_root" ]] && candidate_roots+=("${npm_root}/comisai")
        candidate_roots+=(
            "/usr/lib/node_modules/comisai"
            "/usr/local/lib/node_modules/comisai"
        )

        local -a candidate_entries=(
            "node_modules/@comis/daemon/dist/daemon.js"
            "packages/daemon/dist/daemon.js"
        )

        COMIS_DAEMON_JS=""
        local root entry
        for root in "${candidate_roots[@]}"; do
            [[ -d "$root" ]] || continue
            for entry in "${candidate_entries[@]}"; do
                if [[ -f "${root}/${entry}" ]]; then
                    COMIS_DAEMON_JS="${root}/${entry}"
                    break 2
                fi
            done
        done

        if [[ -z "$COMIS_DAEMON_JS" ]]; then
            ui_error "Could not locate comisai daemon entry point."
            echo "  Searched under:"
            for root in "${candidate_roots[@]}"; do
                echo "    ${root}/{node_modules/@comis/daemon,packages/daemon}/dist/daemon.js"
            done
            return 1
        fi
    fi

    return 0
}

# Write the rendered unit with a managed-by header + sha256 of the body.
# The header lets us detect user edits on upgrade without clobbering them.
render_xvfb_unit() {
    [[ "$WITH_XVFB" == "1" ]] || return 0
    # Ground truth: don't register a companion unit whose ExecStart points at an
    # Xvfb binary that isn't installed (headed install failed) - that would just
    # crash-loop the unit. Fall back silently to headless (the browser tool still
    # works; only headed mode is unavailable).
    if ! xvfb_present; then
        WITH_XVFB=0
        ui_warn "Xvfb binary not found - skipping headed companion unit (browser runs headless)"
        return 0
    fi
    # Defensive guard: the normal systemd-user path already downshifts to
    # headless. Never mis-install a system unit if this helper is called directly.
    if ! is_root; then
        WITH_XVFB=0
        ui_warn "comis-xvfb.service requires a root system-service install; using headless browser mode"
        return 0
    fi

    local target="/etc/systemd/system/comis-xvfb.service"
    local tmpfiles_target="/etc/tmpfiles.d/comis-x11.conf"
    if [[ -e "$target" || -L "$target" ]] && ! unit_is_managed "$target"; then
        ui_warn "Existing unit at ${target} has been hand-edited; leaving untouched."
        return 0
    fi
    if [[ -e "$tmpfiles_target" || -L "$tmpfiles_target" ]] \
        && ! xvfb_tmpfiles_rule_is_managed "$tmpfiles_target"; then
        WITH_XVFB=0
        ui_error "Existing Xvfb tmpfiles rule at ${tmpfiles_target} is not an unmodified installer-managed file"
        return 1
    fi

    # Shared X-socket dir that both comis-xvfb.service (read-write) and
    # comis.service (read-only) bind onto their PrivateTmp /tmp/.X11-unix, so the
    # X99 socket Xvfb creates is reachable from the daemon. Create it now for the
    # immediate start AND via tmpfiles so it is recreated on reboot before the
    # units mount it (BindPaths fails if the source is missing). Root ownership
    # prevents Xvfb from widening the directory to 1777; the service group keeps
    # the socket writable and traversable only by Comis.
    if ! install -d -m 0770 -o root -g "${COMIS_SVC_GROUP}" /run/comis-x11; then
        WITH_XVFB=0
        ui_warn "Could not create the private Xvfb socket directory; using headless browser mode"
        return 1
    fi
    local tmpfiles_body tmpfiles_checksum="" tmpfiles_tmp tmpfiles_staged
    tmpfiles_body="d /run/comis-x11 0770 root ${COMIS_SVC_GROUP} -"
    if command -v sha256sum >/dev/null 2>&1; then
        tmpfiles_checksum="$(printf '%s' "$tmpfiles_body" | sha256sum | cut -d' ' -f1)"
    elif command -v shasum >/dev/null 2>&1; then
        tmpfiles_checksum="$(printf '%s' "$tmpfiles_body" | shasum -a 256 | cut -d' ' -f1)"
    fi
    if [[ -z "$tmpfiles_checksum" ]]; then
        WITH_XVFB=0
        ui_warn "No SHA-256 utility available; using headless browser mode"
        return 1
    fi
    tmpfiles_tmp="$(mktempfile)"
    {
        printf '# managed-by: comis-installer\n# checksum: %s\n' "$tmpfiles_checksum"
        printf '%s\n' "$tmpfiles_body"
    } > "$tmpfiles_tmp"
    tmpfiles_staged="${tmpfiles_target}.comis.$$"
    if ! install -m 0644 -o root -g root "$tmpfiles_tmp" "$tmpfiles_staged" \
        || ! mv -f "$tmpfiles_staged" "$tmpfiles_target"; then
        rm -f "$tmpfiles_staged" 2>/dev/null || true
        WITH_XVFB=0
        ui_warn "Could not register the Xvfb socket directory for reboot; using headless browser mode"
        return 1
    fi

    ui_info "Writing Xvfb companion unit to ${target}"
    local xvfb_body
    xvfb_body="$(cat <<XVFB
[Unit]
Description=Comis virtual display for the browser tool
After=network.target

[Service]
Type=simple
User=${COMIS_SVC_USER}
Group=${COMIS_SVC_GROUP}
# -ac disables X11 host-based access control. The server listens only on its
# Unix-domain socket, which lives inside the root-owned, mode-0770
# /run/comis-x11 directory shared with the Comis service group.
ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -ac -nolisten tcp
Restart=on-failure
RestartSec=2s
# Xvfb needs almost nothing.
NoNewPrivileges=yes
PrivateTmp=yes
# Bind the shared host X-socket dir onto /tmp/.X11-unix so the socket Xvfb
# creates here (X99) is visible to the daemon, which read-only-binds the same
# /run/comis-x11 (JoinsNamespaceOf does not share PrivateTmp content on systemd 255).
BindPaths=/run/comis-x11:/tmp/.X11-unix
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes

[Install]
WantedBy=multi-user.target
XVFB
)"

    local xvfb_checksum
    if command -v sha256sum >/dev/null 2>&1; then
        xvfb_checksum="$(printf '%s' "$xvfb_body" | sha256sum | cut -d' ' -f1)"
    elif command -v shasum >/dev/null 2>&1; then
        xvfb_checksum="$(printf '%s' "$xvfb_body" | shasum -a 256 | cut -d' ' -f1)"
    else
        xvfb_checksum="unknown"
    fi

    local tmp
    tmp="$(mktempfile)"
    cat > "$tmp" <<HDR
# managed-by: comis-installer
# template-version: 1
# checksum: ${xvfb_checksum}
# Do not edit by hand - the installer will refuse to overwrite a modified unit.
HDR
    printf '%s\n' "$xvfb_body" >> "$tmp"

    if ! maybe_sudo install -m 0644 "$tmp" "$target"; then
        WITH_XVFB=0
        ui_warn "Could not install comis-xvfb.service; using headless browser mode"
        return 1
    fi

    if ! maybe_sudo systemctl daemon-reload; then
        WITH_XVFB=0
        ui_warn "Could not reload systemd after installing Xvfb; using headless browser mode"
        return 1
    fi
    if [[ "$NO_AUTOSTART" != "1" ]]; then
        run_quiet_step "Enabling comis-xvfb.service" maybe_sudo systemctl enable comis-xvfb.service
    fi
    if [[ "$NO_SERVICE_START" != "1" ]]; then
        if ! run_quiet_step "Starting comis-xvfb.service" maybe_sudo systemctl start comis-xvfb.service; then
            WITH_XVFB=0
            ui_warn "comis-xvfb.service did not start; using headless browser mode"
            return 1
        fi
    fi
    ui_success "Xvfb companion unit installed"
}

render_systemd_unit() {
    local target_path="$1"
    local scope="$2"  # "system" or "user"

    local user_line="User=${COMIS_SVC_USER}"
    local group_line="Group=${COMIS_SVC_GROUP}"
    if [[ "$scope" == "user" ]]; then
        # User units run as the invoking user - no User=/Group= needed
        user_line="# User= (user scope: inherits invoking user)"
        group_line="# Group= (user scope)"
    fi

    # Browser-tool template variants. All empty by default - only populated
    # when --with-browser (and optionally --with-xvfb) is set. Computed pre-
    # heredoc so the checksum baked at the top of the unit file matches the
    # rendered body without post-render rewrites.
    local COMIS_BROWSER_FS_WRITE_FLAGS=""
    local COMIS_BROWSER_RW_PATHS=""
    local COMIS_BROWSER_ENV_LINES=""
    local COMIS_BROWSER_SYSCALL_LINE=""
    local COMIS_XVFB_AFTER=""
    local COMIS_XVFB_WANTS=""
    local COMIS_PRIVATE_TMP_LINE="PrivateTmp=yes"
    if [[ "$WITH_BROWSER" == "1" ]]; then
        # Chrome needs syscalls outside `@system-service @mount setns` or the
        # kernel SIGSYS-kills it (status=31/SYS) BEFORE it opens the CDP socket -
        # so the browser tool's every navigate fails `connectOverCDP ECONNREFUSED`.
        # Determined by seccomp audit (type=1326) on a clean install, iterated to
        # convergence (launches + serves CDP + renders a real page, zero further
        # denials): pkey_* (330 - V8 memory-protection keys), landlock_* (444 -
        # Chrome's own self-sandbox), and - once a renderer spins up - ptrace (101)
        # + seccomp (317). systemd unions multiple SystemCallFilter= lines.
        # Security posture: seccomp + landlock are RESTRICTION-ONLY (a process can
        # only ADD limits to itself, never escape), pkey_* is memory-protection -
        # all safe. ptrace is the one real relaxation, but with NoNewPrivileges +
        # empty CapabilityBoundingSet (no CAP_SYS_PTRACE) + default YAMA it is
        # limited to same-uid children (Chrome tracing its own crash handler).
        # Only added when a browser is provisioned (--without-browser keeps the
        # tighter set).
        COMIS_BROWSER_SYSCALL_LINE="SystemCallFilter=pkey_alloc pkey_free pkey_mprotect landlock_create_ruleset landlock_add_rule landlock_restrict_self ptrace seccomp"
        # chrome-detection.ts:154 resolves the profile dir to
        # $XDG_CONFIG_HOME/comis/browser/<profile>/user-data. Allow the daemon
        # to write there at both the Node permission layer (--allow-fs-write)
        # and the systemd sandbox layer (ReadWritePaths).
        if [[ "$WITH_CLOAKBROWSER" == "1" ]]; then
            # CloakBrowser writes to a different set of paths than Google Chrome:
            #   ~/.cloakbrowser/        - binary cache + auto-update workspace
            #                             (also extensions/ inside each version)
            #   ~/.config/chromium/     - crashpad (vendor string is "Chromium",
            #                             not "google-chrome")
            # CloakBrowser does NOT write ~/.local/share/applications/mimeapps -
            # the upstream Chromium default-browser registration is patched out.
            # Tighter sandbox than the Chrome path.
            COMIS_BROWSER_FS_WRITE_FLAGS=" --allow-fs-write=${COMIS_SVC_HOME}/.config/comis/browser --allow-fs-write=${COMIS_SVC_HOME}/.cloakbrowser --allow-fs-write=${COMIS_SVC_HOME}/.config/chromium"
            COMIS_BROWSER_RW_PATHS=" ${COMIS_SVC_HOME}/.config/comis/browser ${COMIS_SVC_HOME}/.cloakbrowser ${COMIS_SVC_HOME}/.config/chromium"
        else
            # Stock Google Chrome writes outside the user-data-dir:
            #   ~/.config/google-chrome/        - crashpad database, GCM store
            #   ~/.local/share/applications/    - mimeapps.list (default-browser
            #                                     registration; no flag disables)
            # Without these, Chrome dies before opening the CDP socket on its
            # first run under ProtectHome=read-only.
            COMIS_BROWSER_FS_WRITE_FLAGS=" --allow-fs-write=${COMIS_SVC_HOME}/.config/comis/browser --allow-fs-write=${COMIS_SVC_HOME}/.config/google-chrome --allow-fs-write=${COMIS_SVC_HOME}/.local/share/applications"
            COMIS_BROWSER_RW_PATHS=" ${COMIS_SVC_HOME}/.config/comis/browser ${COMIS_SVC_HOME}/.config/google-chrome ${COMIS_SVC_HOME}/.local/share/applications"
        fi
    fi
    if [[ "$WITH_XVFB" == "1" && "$scope" == "system" ]]; then
        # The system-scope comis-xvfb.service owns the virtual display at :99.
        # The X11 socket must
        # be reachable from the daemon despite BOTH units running PrivateTmp=yes.
        # JoinsNamespaceOf= was tried but does NOT share the PrivateTmp /tmp CONTENT
        # on systemd 255 (the daemon's ns gets an empty /tmp/.X11-unix). Instead,
        # both units bind a SHARED host dir (/run/comis-x11, created by tmpfiles)
        # onto /tmp/.X11-unix: Xvfb writes X99 there (read-write bind), the daemon
        # reads it (read-only bind). PrivateTmp stays on for everything else.
        COMIS_BROWSER_ENV_LINES="Environment=DISPLAY=:99"
        COMIS_XVFB_AFTER=" comis-xvfb.service"
        COMIS_XVFB_WANTS=" comis-xvfb.service"
        COMIS_PRIVATE_TMP_LINE="PrivateTmp=yes
BindReadOnlyPaths=/run/comis-x11:/tmp/.X11-unix"
    fi

    local body body_tmp
    body_tmp="$(mktempfile)"
    cat > "$body_tmp" <<UNIT
[Unit]
Description=Comis AI Agent Daemon
Documentation=https://docs.comis.ai/operations/systemd
After=network-online.target${COMIS_XVFB_AFTER}
Wants=network-online.target${COMIS_XVFB_WANTS}
# StartLimit: after 3 restarts in 60s, enter 'failed' state. Paired with the
# preflight doctor that exits 78 on a missing native addon, this produces one
# actionable failure instead of an unbounded crash loop.
# Clear with: systemctl reset-failed comis
StartLimitBurst=3
StartLimitIntervalSec=60

[Service]
# Type=exec: systemd considers the service started once execve() returns.
# In-process liveness is handled by ProcessMonitor (event loop delay tracking);
# crash recovery is handled by Restart=on-failure below.
Type=exec
${user_line}
${group_line}
WorkingDirectory=${COMIS_WORKING_DIR}

# --permission: Node permission model. fs-write scoped to paths the daemon
# actually writes to at runtime:
#   DATA_DIR        - config, logs, memory.db, workspace, sessions, and the
#                     keyless local-STT whisper model cache (models/whisper/) -
#                     so no extra fs-write flag is needed when local STT ships
#   HOME/.npm       - npm cache + logs (MCP servers spawned via npx)
#   HOME/.pi        - pi-agent-core SettingsManager (agent config dir)
#   /tmp            - media temp files (PrivateTmp=yes sandboxes this already)
# fs-read wildcarded: ProtectSystem=strict + ProtectHome=read-only enforce the
# real filesystem perimeter at the kernel level.
# --allow-addons + --allow-worker: native deps like sharp and better-sqlite3 -
# and the ONNX Runtime used by the local-STT whisper engine, so it needs no new flag.
# --jitless and MemoryDenyWriteExecute are intentionally NOT set: both break
# WebAssembly, which bundled undici (HTTP parsing) and the WASM ONNX fallback use.
ExecStart=${COMIS_NODE_BIN} --permission --allow-addons --allow-worker --allow-fs-read=* --allow-fs-write=${COMIS_DATA_DIR} --allow-fs-write=${COMIS_SVC_HOME}/.npm --allow-fs-write=${COMIS_SVC_HOME}/.pi --allow-fs-write=/tmp${COMIS_BROWSER_FS_WRITE_FLAGS} --allow-child-process ${COMIS_DAEMON_JS}

Restart=on-failure
RestartSec=5s
TimeoutStopSec=45
# KillMode=process: on stop, systemd signals ONLY the main daemon process - NOT the whole
# cgroup (the default 'control-group'). REQUIRED for durable terminal drives: a
# durable session runs its child inside a detached 'tmux new-session -d' server that
# daemonizes (reparented to init) but REMAINS a member of this unit's cgroup - the daemon
# cannot move it out (ProtectControlGroups=yes + non-root service user + no user bus). With
# the default control-group kill, every 'systemctl restart' SIGKILLs that tmux server, so a
# durable session can NEVER survive a restart. With KillMode=process the daemonized tmux
# server is left alone and survives; non-durable cleanup is preserved because graceful
# shutdown runs the registry cleanup AND the Terminal Worker self-exits on its stdin EOF
# when the daemon dies (its bwrap children are --die-with-parent). Trade-off: after a HARD
# crash other long-lived children (MCP servers, browser) may briefly linger until
# Restart= respawns the daemon (~5s); the terminal worker + exec sandboxes self-reap.
KillMode=process
# The daemon self-restarts by trapping SIGUSR2, shutting down cleanly, and
# exiting with code 42 (see packages/daemon/src/daemon.ts). Two settings work
# together here:
#   SuccessExitStatus=42       -- classify exit 42 as clean (no "Failed with
#                                  result 'exit-code'" spam in journal on
#                                  every hot config reload)
#   RestartForceExitStatus=42  -- *still* respawn on exit 42, regardless of
#                                  the Restart=on-failure setting above
# Without RestartForceExitStatus, SuccessExitStatus would also suppress the
# restart (on-failure only fires on non-success exits), leaving the daemon
# dead after every hot reload.
SuccessExitStatus=42
RestartForceExitStatus=42

MemoryMax=2G
# TasksMax covers the entire cgroup: daemon + MCP children + exec sandbox children.
# 512 leaves room for uv/uvx (rayon + tokio spawn ~N_CPU threads each on startup)
# and parallel MCP downloads without being sloppy. Baseline daemon uses ~70 tasks;
# bubblewrap adds ~5 per sandbox invocation; uvx adds 20-40 during package install.
TasksMax=512

# MemoryDenyWriteExecute intentionally omitted: it breaks V8 JIT and WebAssembly.
# Bundled undici uses WASM for HTTP parsing. SystemCallFilter still blocks most
# abuse vectors below.

StandardOutput=journal
StandardError=journal
SyslogIdentifier=comis

Environment=NODE_ENV=production
Environment=RUSTUP_HOME=/usr/local/rustup
Environment=CARGO_HOME=/usr/local/cargo
${COMIS_BROWSER_ENV_LINES}
EnvironmentFile=-${COMIS_ENV_FILE}

# --- Security hardening ---
ProtectSystem=strict
ProtectHome=read-only
${COMIS_PRIVATE_TMP_LINE}
# ReadWritePaths punches through ProtectHome=read-only. It grants the WHOLE
# service home read-write - the terminal driver's "filesystem: home" scope runs driven CLIs
# (claude, codex, …) that keep state in their own home dirs (~/.claude, ~/.codex, ~/.local),
# and the bwrap jail binds the DAEMON's view of ~/, so a read-only home read-onlys exactly
# those dirs and the CLI exits at launch (can't write its state). The bwrap jail (uid/network
# scope + the ~/.comis secrets mask) is the real isolation; ProtectHome=read-only still hides
# /root and OTHER users' homes. (uv/uvx ~/.cache, ~/.npm, etc. are subsumed by the home grant.)
ReadWritePaths=${COMIS_DATA_DIR} ${COMIS_SVC_HOME}${COMIS_BROWSER_RW_PATHS}

# Privilege escalation prevention
NoNewPrivileges=yes
CapabilityBoundingSet=
# @system-service covers the baseline; @mount + setns are needed by bubblewrap
# when it sets up the exec-tool sandbox (pivot_root, mount, umount2, setns).
# Without them, bwrap dies with SIGSYS (exit code 159) on seccomp violation.
SystemCallFilter=@system-service @mount
SystemCallFilter=setns
${COMIS_BROWSER_SYSCALL_LINE}
SystemCallArchitectures=native
PrivateDevices=yes
# ProtectKernelTunables / ProtectKernelLogs / ProtectHostname are intentionally
# OFF: on Linux 6.8+ (Ubuntu 24.04, Debian trixie) any of the three makes bwrap
# fail with "Can't mount proc on /newroot/proc: Operation not permitted" when
# the exec sandbox tries to spin up a nested PID namespace. Bisected on a live
# VPS: enabling any of them cascades with the other hardening we do keep and
# blocks /proc remount inside bwrap. The daemon runs trusted code - untrusted
# agent commands are isolated by bwrap - so the relaxation does not materially
# weaken the threat model.
ProtectKernelTunables=no
ProtectKernelModules=yes
ProtectKernelLogs=no
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=no
RestrictRealtime=yes
RestrictSUIDSGID=yes
# RestrictNamespaces: allow the namespace types bubblewrap needs for the exec
# sandbox (agent-issued commands are bwrap-wrapped in new user/mount/pid/net/ipc
# namespaces). Without this allowlist, bwrap fails with "No permissions to
# create new namespace" and the exec tool degrades to a no-op.
RestrictNamespaces=user mnt pid net ipc uts cgroup
LockPersonality=yes

[Install]
WantedBy=${scope}.target
UNIT
    body="$(cat "$body_tmp")"
    # user scope installs under default.target; system under multi-user.target
    if [[ "$scope" == "user" ]]; then
        body="${body//WantedBy=user.target/WantedBy=default.target}"
    else
        body="${body//WantedBy=system.target/WantedBy=multi-user.target}"
    fi

    local checksum
    if command -v sha256sum >/dev/null 2>&1; then
        checksum="$(printf '%s' "$body" | sha256sum | cut -d' ' -f1)"
    elif command -v shasum >/dev/null 2>&1; then
        checksum="$(printf '%s' "$body" | shasum -a 256 | cut -d' ' -f1)"
    else
        checksum="unknown"
    fi

    local header
    header="$(cat <<HDR
# managed-by: comis-installer
# template-version: 1
# checksum: ${checksum}
# Do not edit by hand - the installer will refuse to overwrite a modified unit.
# To regenerate after an install.sh upgrade: re-run the installer.
HDR
)"

    local tmp
    tmp="$(mktempfile)"
    printf '%s\n%s\n' "$header" "$body" > "$tmp"

    local parent_dir
    parent_dir="$(dirname "$target_path")"
    if [[ "$scope" == "system" ]]; then
        maybe_sudo mkdir -p "$parent_dir"
        maybe_sudo install -m 0644 "$tmp" "$target_path"
    else
        mkdir -p "$parent_dir"
        install -m 0644 "$tmp" "$target_path"
    fi
}

# Check whether a previously-installed unit is still installer-managed.
# Returns 0 if safe to overwrite, 1 if the user has edited it.
unit_is_managed() {
    local unit_path="$1"
    [[ -f "$unit_path" && ! -L "$unit_path" ]] || return 1
    [[ "$(sed -n '1p' "$unit_path")" == "# managed-by: comis-installer" ]] || return 1
    [[ "$(sed -n '2p' "$unit_path")" == "# template-version: 1" ]] || return 1
    [[ "$(sed -n '4p' "$unit_path")" == "# Do not edit by hand - the installer will refuse to overwrite a modified unit." ]] || return 1
    local recorded
    recorded="$(sed -n '3s/^# checksum: //p' "$unit_path")"
    [[ "$recorded" =~ ^[a-f0-9]{64}$ ]] || return 1
    local body_start=5
    if [[ "$(sed -n '5p' "$unit_path")" == "# To regenerate after an install.sh upgrade: re-run the installer." ]]; then
        body_start=6
    fi
    [[ "$(sed -n "${body_start}p" "$unit_path")" == "[Unit]" ]] || return 1
    local body
    body="$(tail -n "+${body_start}" "$unit_path")"
    local computed=""
    if command -v sha256sum >/dev/null 2>&1; then
        computed="$(printf '%s' "$body" | sha256sum | cut -d' ' -f1)"
    elif command -v shasum >/dev/null 2>&1; then
        computed="$(printf '%s' "$body" | shasum -a 256 | cut -d' ' -f1)"
    fi
    [[ "$computed" == "$recorded" ]]
}

sudoers_rule_is_managed() {
    local sudoers_file="$1"
    [[ -f "$sudoers_file" && ! -L "$sudoers_file" ]] || return 1
    [[ "$(sed -n '1p' "$sudoers_file")" == "# managed-by: comis-installer" ]] || return 1
    local recorded body computed=""
    recorded="$(sed -n '2s/^# checksum: //p' "$sudoers_file")"
    [[ "$recorded" =~ ^[a-f0-9]{64}$ ]] || return 1
    body="$(tail -n +3 "$sudoers_file")"
    if command -v sha256sum >/dev/null 2>&1; then
        computed="$(printf '%s' "$body" | sha256sum | cut -d' ' -f1)"
    elif command -v shasum >/dev/null 2>&1; then
        computed="$(printf '%s' "$body" | shasum -a 256 | cut -d' ' -f1)"
    fi
    [[ -n "$computed" && "$computed" == "$recorded" ]] || return 1
    [[ "$(stat -c '%u:%g:%a' "$sudoers_file" 2>/dev/null || true)" == "0:0:440" ]]
}

xvfb_tmpfiles_rule_is_managed() {
    local tmpfiles_file="$1"
    [[ -f "$tmpfiles_file" && ! -L "$tmpfiles_file" ]] || return 1
    [[ "$(sed -n '1p' "$tmpfiles_file")" == "# managed-by: comis-installer" ]] || return 1
    local recorded body computed=""
    recorded="$(sed -n '2s/^# checksum: //p' "$tmpfiles_file")"
    [[ "$recorded" =~ ^[a-f0-9]{64}$ ]] || return 1
    body="$(tail -n +3 "$tmpfiles_file")"
    if command -v sha256sum >/dev/null 2>&1; then
        computed="$(printf '%s' "$body" | sha256sum | cut -d' ' -f1)"
    elif command -v shasum >/dev/null 2>&1; then
        computed="$(printf '%s' "$body" | shasum -a 256 | cut -d' ' -f1)"
    fi
    [[ -n "$computed" && "$computed" == "$recorded" ]]
}

# Write /etc/comis/env with a placeholder. Does not overwrite an existing file
# (user may have filled in API keys).
render_env_file() {
    local target="$COMIS_ENV_FILE"

    if [[ -f "$target" ]]; then
        ui_info "Env file already exists at ${target}; leaving untouched"
        return 0
    fi

    local tmp
    tmp="$(mktempfile)"
    cat > "$tmp" <<ENV
# Comis daemon environment - generated by install.sh.
# Edit with: sudoedit ${target}
# Restart after changes: sudo systemctl restart comis

COMIS_CONFIG_PATHS=${COMIS_CONFIG_FILE}
NODE_ENV=production

# API keys (fill in as needed):
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# GOOGLE_API_KEY=
ENV

    maybe_sudo mkdir -p "$(dirname "$target")"
    maybe_sudo install -m 0640 -o root -g "$COMIS_SVC_GROUP" "$tmp" "$target" 2>/dev/null || \
        maybe_sudo install -m 0640 "$tmp" "$target"
    ui_success "Env file written to ${target}"
}

# Seed a `browser:` block into ~/.comis/config.yaml when --with-browser is set
# and no browser block exists yet. Safe to call repeatedly: existing user
# config is never overwritten.
#
# noSandbox=true is required when the daemon runs under a systemd-confined
# user with NoNewPrivileges=yes: Chromium's setuid sandbox cannot elevate
# anyway, so passing --no-sandbox is the supported path. With --with-xvfb we
# also default headless=false so the agent uses the virtual display.
maybe_seed_browser_config() {
    [[ "$WITH_BROWSER" == "1" ]] || return 0
    local cfg="$COMIS_CONFIG_FILE"
    [[ -n "$cfg" ]] || return 0

    if [[ -f "$cfg" ]] && grep -q '^browser:' "$cfg" 2>/dev/null; then
        ui_info "browser: block already present in ${cfg}; leaving untouched"
        return 0
    fi

    local headless_value="true"
    local source_flag="--with-browser"
    [[ "$WITH_CLOAKBROWSER" == "1" ]] && source_flag="--with-cloakbrowser"
    # Seed headless=false (headed) ONLY when Xvfb is actually present - ground truth,
    # not the WITH_XVFB intent flag. If the headed install failed, seeding headless=false
    # would launch Chrome against a display that isn't there; fall back to headless so
    # the browser tool works on the Chromium installed above.
    if [[ "$WITH_XVFB" == "1" ]] && xvfb_present; then
        headless_value="false"
        source_flag="${source_flag} --with-xvfb"
    elif [[ "$WITH_XVFB" == "1" ]]; then
        ui_warn "Xvfb not present - seeding headless browser config (headed mode unavailable)"
    fi

    local block
    block="$(cat <<YAML

# Browser tool - installed via ${source_flag}
# noSandbox: required under systemd NoNewPrivileges=yes (the Chrome setuid
# sandbox cannot elevate anyway; --no-sandbox is the supported path).
# headless=false when Xvfb is present so the daemon uses the virtual display.
browser:
  enabled: true
  noSandbox: true
  headless: ${headless_value}
YAML
)"

    local tmp
    tmp="$(mktempfile)"
    if [[ -f "$cfg" ]]; then
        cat "$cfg" > "$tmp"
    else
        : > "$tmp"
    fi
    printf '%s\n' "$block" >> "$tmp"

    # Two paths:
    #   * Non-root install (operator or reexec'd comis user, or --service
    #     none / Docker): write directly. Do NOT route through maybe_sudo -
    #     that would unnecessarily escalate via sudo and create a root-owned
    #     file in the user's own HOME (broken under Docker, and surprising
    #     elsewhere). Plain `install` inherits the current user's ownership.
    #   * Root install with a dedicated COMIS_USER (systemd dedicated-user
    #     flow): write as root with -o $COMIS_SVC_USER so the daemon can
    #     read it.
    if ! is_root; then
        install -m 0600 "$tmp" "$cfg"
    elif [[ -n "${COMIS_SVC_USER:-}" ]] && comis_user_exists; then
        install -m 0600 -o "$COMIS_SVC_USER" -g "${COMIS_SVC_GROUP:-$COMIS_SVC_USER}" "$tmp" "$cfg" 2>/dev/null || \
            install -m 0600 "$tmp" "$cfg"
    else
        install -m 0600 "$tmp" "$cfg"
    fi
    ui_success "Seeded browser config block in ${cfg}"
}

# Poll the gateway health endpoint after service start.
#
# A cold first boot downloads the local embedding model (~146MB GGUF) into
# ~/.comis/models/ and loads it before the gateway binds - ~30s on a small
# 2-vCPU instance - so the window must comfortably outlast that. Override
# with COMIS_GATEWAY_WAIT_SECS. Sets GATEWAY_WAIT_SECS_USED so callers can
# report the window they actually waited.
wait_for_daemon_ready() {
    local host="${COMIS_GATEWAY_HOST:-127.0.0.1}"
    local port=4766
    if [[ "${COMIS_GATEWAY_PORT:-}" =~ ^[0-9]+$ ]] \
        && (( 10#${COMIS_GATEWAY_PORT} >= 1 && 10#${COMIS_GATEWAY_PORT} <= 65535 )); then
        port="${COMIS_GATEWAY_PORT}"
    fi

    # Read only direct children of the top-level gateway section. A generic
    # `host:`/`port:` search can accidentally select observability or provider
    # settings and turn a healthy service start into a false timeout.
    if [[ -f "$COMIS_CONFIG_FILE" ]]; then
        local cfg_host cfg_port
        while IFS='=' read -r key value; do
            case "$key" in
                host) cfg_host="$value" ;;
                port) cfg_port="$value" ;;
            esac
        done < <(awk '
            function indent_of(line, copy) { copy=line; sub(/[^ \t].*$/, "", copy); gsub(/\t/, "        ", copy); return length(copy) }
            function trim(value) { sub(/^[[:space:]]+/, "", value); sub(/[[:space:]]+$/, "", value); return value }
            function scalar(value, first, last) {
                sub(/^[^:]*:[[:space:]]*/, "", value)
                sub(/[[:space:]]+#.*$/, "", value)
                value=trim(value)
                first=substr(value, 1, 1); last=substr(value, length(value), 1)
                if (length(value) >= 2 && ((first == "\"" && last == "\"") || (first == "\047" && last == "\047"))) value=substr(value, 2, length(value)-2)
                return value
            }
            /^[[:space:]]*(#|$)/ { next }
            {
                raw=$0; indent=indent_of(raw); line=trim(raw)
                if (!inside) {
                    if (indent == 0 && line ~ /^gateway:[[:space:]]*(#.*)?$/) { inside=1; gateway_indent=indent; child_indent=-1 }
                    next
                }
                if (indent <= gateway_indent) { inside=0; next }
                if (child_indent < 0) child_indent=indent
                if (indent != child_indent) next
                if (line ~ /^host[[:space:]]*:/) host=scalar(line)
                if (line ~ /^port[[:space:]]*:/) port=scalar(line)
            }
            END {
                if (host != "") print "host=" host
                if (port != "") print "port=" port
            }
        ' "$COMIS_CONFIG_FILE" 2>/dev/null)
        [[ -n "${cfg_host:-}" ]] && host="$cfg_host"
        if [[ "${cfg_port:-}" =~ ^[0-9]+$ ]] \
            && (( 10#$cfg_port >= 1 && 10#$cfg_port <= 65535 )); then
            port="$cfg_port"
        fi
    fi

    case "$host" in
        0.0.0.0|"*") host="127.0.0.1" ;;
        "[::]"|"::") host="[::1]" ;;
    esac
    if [[ "$host" == *:* && "$host" != \[*\] ]]; then
        host="[${host}]"
    fi

    local wait_secs="${COMIS_GATEWAY_WAIT_SECS:-90}"
    GATEWAY_WAIT_SECS_USED="$wait_secs"
    local deadline=$((SECONDS + wait_secs))
    # Partway through (capped at 15s in), reassure the operator: a slow first
    # boot is the embedding-model download, not a hang.
    local progress_delay=$((wait_secs / 2))
    [[ $progress_delay -gt 15 ]] && progress_delay=15
    local progress_at=$((SECONDS + progress_delay))
    local progress_shown=0
    while [[ $SECONDS -lt $deadline ]]; do
        if command -v curl >/dev/null 2>&1; then
            if curl -fsS --max-time 2 "http://${host}:${port}/health" >/dev/null 2>&1; then
                return 0
            fi
        elif command -v wget >/dev/null 2>&1; then
            if wget -q --timeout=2 -O /dev/null "http://${host}:${port}/health" 2>/dev/null; then
                return 0
            fi
        fi
        if [[ $progress_shown -eq 0 && $SECONDS -ge $progress_at ]]; then
            ui_info "Still waiting - a first boot downloads the local embedding model (~146MB) before the gateway listens"
            progress_shown=1
        fi
        sleep 1
    done
    return 1
}

# --- systemd registration (system scope) ---
register_service_systemd() {
    local unit_path="/etc/systemd/system/comis.service"

    cleanup_legacy_daemon_state

    # Xvfb companion unit must exist before comis.service is enabled so its
    # Wants=/After=comis-xvfb.service dependency resolves on first boot.
    render_xvfb_unit || ui_warn "Xvfb companion unit setup encountered errors"

    if [[ -e "$unit_path" || -L "$unit_path" ]] && ! unit_is_managed "$unit_path"; then
        ui_warn "Existing unit at ${unit_path} has been hand-edited; leaving untouched."
        ui_info "To regenerate, remove it first: sudo rm ${unit_path} && rerun the installer."
    else
        ui_info "Writing systemd unit to ${unit_path}"
        render_systemd_unit "$unit_path" "system"
    fi

    # Ensure the data directory exists before systemd tries to bind-mount it
    # via ReadWritePaths=. Without this, systemctl start fails with 226/NAMESPACE.
    maybe_sudo mkdir -p "$COMIS_DATA_DIR"
    maybe_sudo chown -R "${COMIS_SVC_USER}:${COMIS_SVC_GROUP}" "$COMIS_DATA_DIR"
    maybe_sudo chmod 0700 "$COMIS_DATA_DIR"

    # Pre-create ~/.npm, ~/.pi, and ~/.cache for the same reason - all appear
    # in the unit's ReadWritePaths= and must exist at service-start time. The
    # daemon (or uvx as a child) populates them on demand (npm cache, pi-agent
    # SettingsManager, uv tool cache).
    maybe_sudo mkdir -p "${COMIS_SVC_HOME}/.npm" "${COMIS_SVC_HOME}/.pi" "${COMIS_SVC_HOME}/.cache"
    maybe_sudo chown "${COMIS_SVC_USER}:${COMIS_SVC_GROUP}" "${COMIS_SVC_HOME}/.npm" "${COMIS_SVC_HOME}/.pi" "${COMIS_SVC_HOME}/.cache"

    # Browser profile dir (only when --with-browser). chrome-detection.ts
    # resolves the user data dir to $XDG_CONFIG_HOME/comis/browser/<profile>;
    # render_systemd_unit adds the path to ReadWritePaths so the systemd
    # sandbox lets the browser write here. We also pre-create the paths
    # the binary touches outside the user-data-dir - set differs for
    # stock Chrome vs CloakBrowser (see render_systemd_unit for rationale).
    if [[ "$WITH_BROWSER" == "1" ]]; then
        if [[ "$WITH_CLOAKBROWSER" == "1" ]]; then
            maybe_sudo mkdir -p \
                "${COMIS_SVC_HOME}/.config/comis/browser" \
                "${COMIS_SVC_HOME}/.cloakbrowser" \
                "${COMIS_SVC_HOME}/.config/chromium"
            maybe_sudo chown -R "${COMIS_SVC_USER}:${COMIS_SVC_GROUP}" \
                "${COMIS_SVC_HOME}/.config" "${COMIS_SVC_HOME}/.cloakbrowser"
        else
            maybe_sudo mkdir -p \
                "${COMIS_SVC_HOME}/.config/comis/browser" \
                "${COMIS_SVC_HOME}/.config/google-chrome" \
                "${COMIS_SVC_HOME}/.local/share/applications"
            maybe_sudo chown -R "${COMIS_SVC_USER}:${COMIS_SVC_GROUP}" \
                "${COMIS_SVC_HOME}/.config" "${COMIS_SVC_HOME}/.local"
        fi
    fi

    render_env_file
    maybe_seed_browser_config

    # Allow the comis user to manage its own systemd service without a password.
    # Grant BOTH the bare unit name and the explicit `.service` form: the
    # installer and operators invoke `systemctl restart comis.service`, while
    # `restart comis` is the shorthand. sudo matches the literal argv against the
    # Cmnd_Spec, so a rule listing only `restart comis` silently fails to match
    # `restart comis.service` and falls through to a password prompt (which, in
    # the non-interactive service-user context, just errors out). List both.
    #
    # Rewritten every run (validated with `visudo -cf` first) so an older,
    # narrower rule from a prior install self-heals on upgrade. If validation
    # fails we leave any existing rule untouched rather than risk a broken
    # sudoers drop-in; if visudo is somehow absent we still write (old behavior).
    local sudoers_file="/etc/sudoers.d/comis"
    local systemctl_bin
    systemctl_bin="$(command -v systemctl)"
    local sudoers_body sudoers_checksum="" sudoers_tmp
    sudoers_body="$(cat <<SUDOERS
# Allow the comis service user to manage the comis daemon
${COMIS_SVC_USER} ALL=(root) NOPASSWD: ${systemctl_bin} start comis, ${systemctl_bin} start comis.service, ${systemctl_bin} stop comis, ${systemctl_bin} stop comis.service, ${systemctl_bin} restart comis, ${systemctl_bin} restart comis.service, ${systemctl_bin} reload comis, ${systemctl_bin} reload comis.service
SUDOERS
)"
    if command -v sha256sum >/dev/null 2>&1; then
        sudoers_checksum="$(printf '%s' "$sudoers_body" | sha256sum | cut -d' ' -f1)"
    elif command -v shasum >/dev/null 2>&1; then
        sudoers_checksum="$(printf '%s' "$sudoers_body" | shasum -a 256 | cut -d' ' -f1)"
    fi
    if [[ -z "$sudoers_checksum" ]]; then
        ui_error "No SHA-256 utility available; refusing to write the sudoers rule"
        return 1
    fi
    sudoers_tmp="$(mktempfile)"
    cat > "$sudoers_tmp" <<SUDOERS
# managed-by: comis-installer
# checksum: ${sudoers_checksum}
${sudoers_body}
SUDOERS
    chmod 0440 "$sudoers_tmp"
    if [[ -e "$sudoers_file" || -L "$sudoers_file" ]] && ! sudoers_rule_is_managed "$sudoers_file"; then
        ui_error "Existing sudoers rule at ${sudoers_file} is not installer-managed; refusing to overwrite it"
        return 1
    elif command -v visudo >/dev/null 2>&1 && ! visudo -cf "$sudoers_tmp" >/dev/null 2>&1; then
        ui_warn "Generated sudoers rule failed validation; leaving existing rule untouched"
        return 1
    elif [[ ! -f "$sudoers_file" || -L "$sudoers_file" ]] || ! cmp -s "$sudoers_tmp" "$sudoers_file"; then
        maybe_sudo install -m 0440 -o root -g root "$sudoers_tmp" "$sudoers_file"
        ui_success "Sudoers rule installed for '${COMIS_SVC_USER}'"
    fi

    maybe_sudo systemctl daemon-reload

    if [[ "$NO_AUTOSTART" == "1" ]]; then
        ui_info "Skipping systemctl enable (--no-autostart)"
    else
        run_quiet_step "Enabling comis.service" maybe_sudo systemctl enable comis.service
    fi

    if [[ "$NO_SERVICE_START" == "1" ]]; then
        ui_info "Skipping systemctl start (--no-service-start)"
        return 0
    fi

    if run_quiet_step "Starting comis.service" maybe_sudo systemctl start comis.service; then
        ui_success "comis.service started"
    else
        ui_error "Failed to start comis.service"
        maybe_sudo systemctl status comis.service --no-pager --lines=20 || true
        echo ""
        ui_info "Recent logs:"
        maybe_sudo journalctl -u comis.service -n 30 --no-pager || true
        return 1
    fi

    if wait_for_daemon_ready; then
        ui_success "Daemon is responding on the gateway port"
    else
        ui_error "Service is active but the gateway didn't respond within ${GATEWAY_WAIT_SECS_USED:-90}s"
        ui_info "Tail logs with: journalctl -u comis.service -f"
        return 1
    fi
}

# --- systemd registration (user scope) ---
register_service_systemd_user() {
    local unit_path="${HOME}/.config/systemd/user/comis.service"

    cleanup_legacy_daemon_state
    downshift_xvfb_for_service_manager

    # User scope: env file lives under ~/.comis (not /etc/comis), and the
    # data dir must exist before rendering the unit (so render sees a valid
    # path and so systemd can bind-mount it via ReadWritePaths).
    mkdir -p "$COMIS_DATA_DIR"
    if [[ "$WITH_BROWSER" == "1" ]]; then
        if [[ "$WITH_CLOAKBROWSER" == "1" ]]; then
            mkdir -p \
                "${HOME}/.config/comis/browser" \
                "${HOME}/.cloakbrowser" \
                "${HOME}/.config/chromium"
        else
            mkdir -p \
                "${HOME}/.config/comis/browser" \
                "${HOME}/.config/google-chrome" \
                "${HOME}/.local/share/applications"
        fi
    fi
    maybe_seed_browser_config
    local user_env="${COMIS_DATA_DIR}/env"
    if [[ ! -f "$user_env" ]]; then
        cat > "$user_env" <<ENV
COMIS_CONFIG_PATHS=${COMIS_CONFIG_FILE}
NODE_ENV=production
ENV
        chmod 0600 "$user_env"
    fi

    # Override COMIS_ENV_FILE for this call so the rendered unit points at
    # the user env file. Checksum is computed against the final body, so no
    # post-render rewrite is needed.
    local saved_env_file="$COMIS_ENV_FILE"
    COMIS_ENV_FILE="$user_env"

    if [[ -e "$unit_path" || -L "$unit_path" ]] && ! unit_is_managed "$unit_path"; then
        ui_warn "Existing unit at ${unit_path} has been hand-edited; leaving untouched."
        ui_info "To regenerate, remove it first: rm ${unit_path} && rerun the installer."
    else
        ui_info "Writing user systemd unit to ${unit_path}"
        render_systemd_unit "$unit_path" "user"
    fi

    COMIS_ENV_FILE="$saved_env_file"

    # daemon-reload may fail silently on headless/no-linger systems; the unit
    # file is still in place and systemctl will pick it up once the user bus
    # becomes available (login, enable-linger, etc.).
    systemctl --user daemon-reload 2>/dev/null || true

    if [[ "$NO_AUTOSTART" == "1" ]]; then
        ui_info "Skipping systemctl --user enable (--no-autostart)"
    else
        run_quiet_step "Enabling user comis.service" systemctl --user enable comis.service
    fi

    if [[ "$NO_SERVICE_START" == "1" ]]; then
        ui_info "Skipping systemctl --user start (--no-service-start)"
        return 0
    fi

    if run_quiet_step "Starting user comis.service" systemctl --user start comis.service; then
        ui_success "User comis.service started"
    else
        ui_error "Failed to start user comis.service"
        systemctl --user status comis.service --no-pager --lines=20 || true
        return 1
    fi

    if wait_for_daemon_ready; then
        ui_success "Daemon is responding on the gateway port"
    else
        ui_error "Service is active but the gateway didn't respond within ${GATEWAY_WAIT_SECS_USED:-90}s"
        ui_info "Tail logs with: journalctl --user -u comis.service -f"
        return 1
    fi

    ui_info "Note: user services stop when you log out."
    ui_info "To survive logout, run: sudo loginctl enable-linger $(id -un)"
}

# --- pm2 registration (macOS) ---
ensure_pm2_installed() {
    if command -v pm2 >/dev/null 2>&1; then
        return 0
    fi
    ui_info "Installing pm2 globally"
    if npm install -g pm2 >/dev/null 2>&1; then
        ui_success "pm2 installed"
        return 0
    fi
    # Try sudo as a fallback for EACCES
    if command -v sudo >/dev/null 2>&1; then
        ui_warn "npm install -g pm2 failed; retrying with sudo"
        if sudo npm install -g pm2 >/dev/null 2>&1; then
            ui_success "pm2 installed"
            return 0
        fi
    fi
    ui_error "Could not install pm2"
    return 1
}

# Probe whether we can run sudo without prompting, or with a likely-successful interactive prompt.
can_elevate() {
    if is_root; then
        return 0
    fi
    command -v sudo >/dev/null 2>&1 || return 1
    # Cached credentials - works without prompt
    if sudo -n true 2>/dev/null; then
        return 0
    fi
    # Interactive TTY available - sudo will prompt
    if [[ -t 0 || -t 1 ]] || (echo -n "" > /dev/tty) 2>/dev/null; then
        return 0
    fi
    return 1
}

register_service_pm2() {
    if ! ensure_pm2_installed; then
        return 1
    fi

    cleanup_legacy_daemon_state

    local comis_bin="${COMIS_BIN:-}"
    if [[ -z "$comis_bin" ]]; then
        comis_bin="$(resolve_comis_bin || true)"
    fi
    if [[ -z "$comis_bin" ]]; then
        ui_error "comis binary not found on PATH; cannot configure pm2"
        return 1
    fi

    # Configure and start PM2 without elevation.
    run_quiet_step "Generating pm2 ecosystem config" "$comis_bin" pm2 setup
    if [[ "$NO_SERVICE_START" == "1" ]]; then
        ui_info "Skipping pm2 start (--no-service-start)"
    else
        if run_quiet_step "Starting daemon via pm2" "$comis_bin" pm2 start; then
            ui_success "Daemon started via pm2"
        else
            ui_error "pm2 start failed"
            "$comis_bin" pm2 status 2>&1 | tail -n 20 || true
            return 1
        fi

        if wait_for_daemon_ready; then
            ui_success "Daemon is responding on the gateway port"
        else
            ui_error "Daemon started but the gateway didn't respond within ${GATEWAY_WAIT_SECS_USED:-90}s"
            ui_info "Tail logs with: pm2 logs comis"
            return 1
        fi
    fi

    if run_quiet_step "Saving pm2 process list" pm2 save; then
        :
    else
        ui_warn "pm2 save failed; the daemon will not restart automatically on reboot"
    fi

    # Configure boot persistence with elevation when available.
    if [[ "$NO_AUTOSTART" == "1" ]]; then
        ui_info "Skipping boot persistence (--no-autostart)"
        ui_info "To enable later: comis pm2 setup --enable-boot"
        return 0
    fi

    if ! can_elevate; then
        ui_warn "Cannot elevate to sudo; skipping boot persistence."
        ui_info "To enable boot persistence later, as an Administrator run:"
        ui_info "  comis pm2 setup --enable-boot"
        return 0
    fi

    ui_info "Registering pm2 with launchd for boot persistence (may prompt for sudo password)"
    # Capture pm2 startup output, extract the sudo line, and run it
    local startup_out startup_err
    startup_out="$(mktempfile)"
    startup_err="$(mktempfile)"
    pm2 startup >"$startup_out" 2>"$startup_err" || true

    local combined
    combined="$(cat "$startup_out" "$startup_err")"

    if echo "$combined" | grep -q "already"; then
        ui_success "Boot persistence already configured"
        return 0
    fi

    local sudo_cmd
    sudo_cmd="$(echo "$combined" | grep -oE 'sudo env PATH=[^\n]+pm2 startup[^\n]+' | head -n1 || true)"
    if [[ -z "$sudo_cmd" ]]; then
        echo "$combined"
        ui_warn "Could not parse pm2 startup command."
        ui_info "Run the command pm2 printed above manually to finish boot registration."
        return 0
    fi

    if sh -c "$sudo_cmd" >/dev/null 2>&1; then
        ui_success "Boot persistence enabled"
    else
        ui_warn "Boot registration command failed; you can retry later with: comis pm2 setup --enable-boot"
    fi
}

# Install the root trust anchor consumed before the daemon loads live adapters.
# A pre-provisioned test role belongs to the replay controller and is preserved.
provision_environment_role_marker() {
    local role_dir="/etc/comis"
    local role_marker="${role_dir}/environment-role"
    local role=""
    local marker_stat=""
    local parent_stat=""
    local parent_mode=""

    if [[ -e "$role_marker" || -L "$role_marker" ]]; then
        if [[ -L "$role_marker" || ! -f "$role_marker" ]]; then
            ui_error "Machine role marker is not a trusted regular file"
            return 1
        fi
        marker_stat="$(stat -c '%u:%g:%a' "$role_marker" 2>/dev/null \
            || stat -f '%u:%g:%Lp' "$role_marker" 2>/dev/null || true)"
        role="$(cat "$role_marker" 2>/dev/null || true)"
        case "$role" in
            "production"|"test") ;;
            *)
                ui_error "Machine role marker has invalid content"
                return 1
                ;;
        esac
        if [[ "$marker_stat" != "0:0:644" ]]; then
            ui_error "Machine role marker must be owned by root with mode 0644"
            return 1
        fi
        return 0
    fi

    if [[ -L "$role_dir" ]]; then
        ui_error "Machine role directory must not be a symbolic link"
        return 1
    fi
    if ! maybe_sudo install -d -m 0755 -o root -g root "$role_dir"; then
        ui_error "Could not create the machine role directory"
        return 1
    fi
    parent_stat="$(stat -c '%u:%g:%a' "$role_dir" 2>/dev/null \
        || stat -f '%u:%g:%Lp' "$role_dir" 2>/dev/null || true)"
    parent_mode="${parent_stat##*:}"
    if [[ "$parent_stat" != 0:0:* || ! "$parent_mode" =~ ^[0-7]{3,4}$ ]] \
        || (( (8#$parent_mode & 8#022) != 0 )); then
        ui_error "Machine role directory is not root-controlled"
        return 1
    fi

    local tmp staged
    tmp="$(mktempfile)"
    printf 'production\n' > "$tmp"
    staged="${role_dir}/.environment-role.comis-${RANDOM}-$$"
    if ! maybe_sudo install -m 0644 -o root -g root "$tmp" "$staged" \
        || ! maybe_sudo mv -n "$staged" "$role_marker"; then
        maybe_sudo rm -f "$staged" 2>/dev/null || true
        ui_error "Could not install the machine role marker"
        return 1
    fi
    maybe_sudo rm -f "$staged" 2>/dev/null || true

    marker_stat="$(stat -c '%u:%g:%a' "$role_marker" 2>/dev/null \
        || stat -f '%u:%g:%Lp' "$role_marker" 2>/dev/null || true)"
    role="$(cat "$role_marker" 2>/dev/null || true)"
    if [[ -L "$role_marker" || ! -f "$role_marker" || "$marker_stat" != "0:0:644" \
        || "$role" != "production" ]]; then
        ui_error "Machine role marker failed post-install verification"
        return 1
    fi
    return 0
}

# Dispatch entry point - called from main() once the binary is in place.
register_service() {
    if ! provision_environment_role_marker; then
        return 1
    fi
    if [[ "$RESOLVED_SERVICE_MANAGER" == "none" ]]; then
        ui_info "Skipping service registration (--service none)"
        ui_info "Start manually with: comis daemon start"
        return 0
    fi

    ui_stage "Registering daemon as a service"

    if ! resolve_service_template_vars; then
        return 1
    fi

    ui_kv "Service manager" "$RESOLVED_SERVICE_MANAGER"
    ui_kv "Run as user" "$COMIS_SVC_USER"
    ui_kv "Daemon entry" "$COMIS_DAEMON_JS"
    ui_kv "Data dir" "$COMIS_DATA_DIR"

    # Ensure bubblewrap can create user namespaces on distros that ship
    # `kernel.apparmor_restrict_unprivileged_userns=1` by default (Ubuntu 23.10+).
    # Idempotent no-op on non-AppArmor distros and on systems where the profile
    # is already loaded.
    if [[ "$OS" == "linux" ]]; then
        apply_apparmor_bwrap_profile
    fi

    case "$RESOLVED_SERVICE_MANAGER" in
        systemd)
            register_service_systemd
            ;;
        systemd-user)
            register_service_systemd_user
            ;;
        pm2)
            register_service_pm2
            ;;
        *)
            ui_error "Unknown service manager: $RESOLVED_SERVICE_MANAGER"
            return 1
            ;;
    esac
}

# Detect which manager already owns an existing install (for upgrade/restart).
# Echoes: systemd | systemd-user | pm2 | direct | none
detect_active_service_manager() {
    # systemd system
    if has_working_systemd && systemctl list-unit-files comis.service --no-pager 2>/dev/null | grep -q "^comis.service"; then
        echo "systemd"
        return 0
    fi
    # systemd user
    if has_working_user_systemd && systemctl --user list-unit-files comis.service --no-pager 2>/dev/null | grep -q "^comis.service"; then
        echo "systemd-user"
        return 0
    fi
    # pm2
    if command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | grep -q '"name":"comis"'; then
        echo "pm2"
        return 0
    fi
    # direct (PID file present)
    local pid_file="${HOME}/.comis/daemon.pid"
    if [[ -f "$pid_file" ]]; then
        echo "direct"
        return 0
    fi
    echo "none"
}

# Restart (or start) the daemon under whichever manager already owns it.
restart_service_if_running() {
    # No-op in the re-exec'd comis-user child. That child runs unprivileged in
    # the "Finalizing setup" stage, BEFORE the root parent's register_service
    # writes the systemd unit and the sudoers rule - so `sudo systemctl restart`
    # here has no matching NOPASSWD grant and, with no tty, errors out with a
    # spurious "sudo: a password is required". The root parent owns service
    # registration AND the restart (it calls this again as root after the child
    # returns), so the child must not touch the service at all.
    if [[ "${COMIS_REEXEC:-0}" == "1" ]]; then
        return 0
    fi
    local active
    active="$(detect_active_service_manager)"
    case "$active" in
        systemd)
            ui_info "Restarting comis.service via systemd"
            maybe_sudo systemctl restart comis.service || ui_warn "systemctl restart failed"
            ;;
        systemd-user)
            ui_info "Restarting comis.service via user systemd"
            systemctl --user restart comis.service || ui_warn "systemctl --user restart failed"
            ;;
        pm2)
            ui_info "Restarting comis via pm2"
            pm2 restart comis 2>/dev/null || ui_warn "pm2 restart failed"
            ;;
        direct)
            local comis_bin="${COMIS_BIN:-}"
            [[ -z "$comis_bin" ]] && comis_bin="$(resolve_comis_bin || true)"
            if [[ -n "$comis_bin" ]]; then
                ui_info "Restarting direct-spawn daemon"
                "$comis_bin" daemon stop >/dev/null 2>&1 || true
                "$comis_bin" daemon start >/dev/null 2>&1 || ui_warn "daemon start failed"
            fi
            ;;
        none)
            :
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Uninstall subsystem
# ---------------------------------------------------------------------------

dedicated_user_install_detected() {
    local target_home="$1"
    local unit_path="/etc/systemd/system/comis.service"

    if [[ -f "$unit_path" ]] && unit_is_managed "$unit_path" \
        && grep -Fxq "User=${COMIS_USER}" "$unit_path" 2>/dev/null; then
        return 0
    fi

    [[ -e "${target_home}/.npm-global/lib/node_modules/comisai" ]] \
        || [[ -e "${target_home}/.npm-global/bin/comis" ]] \
        || [[ -e "${target_home}/.local/bin/comis" ]]
}

full_uninstall_artifacts_present() {
    local default_home="/home/${COMIS_USER}"
    local apparmor_profile="/etc/apparmor.d/bwrap"
    local path
    for path in \
        /etc/systemd/system/comis.service \
        /etc/systemd/system/comis-xvfb.service \
        /etc/tmpfiles.d/comis-x11.conf \
        /run/comis-x11 \
        /etc/sudoers.d/comis \
        /etc/comis \
        /var/log/comis \
        "${default_home}/.comis" \
        "${default_home}/.npm-global/lib/node_modules/comisai" \
        "${default_home}/.npm-global/bin/comis" \
        "${default_home}/.local/bin/comis"; do
        [[ -e "$path" || -L "$path" ]] && return 0
    done
    if [[ -L "$apparmor_profile" ]]; then
        return 0
    fi
    if [[ -f "$apparmor_profile" ]] \
        && grep -Fxq "# managed-by: comis-installer" "$apparmor_profile" 2>/dev/null; then
        return 0
    fi
    if command -v systemctl >/dev/null 2>&1; then
        systemctl is-active --quiet comis.service 2>/dev/null && return 0
        systemctl is-enabled --quiet comis.service 2>/dev/null && return 0
        systemctl is-active --quiet comis-xvfb.service 2>/dev/null && return 0
        systemctl is-enabled --quiet comis-xvfb.service 2>/dev/null && return 0
    fi
    if command -v iptables >/dev/null 2>&1 \
        && iptables -L COMIS_EGRESS -n >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

reconcile_install_receipt_decommission_state() {
    local state
    state="$(install_receipt_value decommission_state)" || return 1
    case "$state" in
        active)
            return 0
            ;;
        removing)
            if install_receipt_owned_artifacts_present; then
                ui_error "An interrupted account removal left ambiguous user, home, or group state"
                ui_info "The installer will not delete identities recreated after removal began"
                return 1
            fi
            if [[ "$DRY_RUN" == "1" ]]; then
                ui_info "[dry-run] would: finalize the interrupted account-removal receipt"
                return 0
            fi
            if ! update_install_receipt_decommission_state "removing" "removed"; then
                ui_error "Could not finalize the interrupted account-removal receipt"
                return 1
            fi
            ;;
        removed)
            if install_receipt_owned_artifacts_present; then
                ui_error "A user, home, or group reappeared after installer-owned account removal"
                ui_info "The replacement identity was left untouched"
                return 1
            fi
            ;;
        *)
            return 1
            ;;
    esac
}

remove_empty_install_receipt_dir() {
    local receipt_dir="$1"
    local require_root_identity="$2"
    [[ -e "$receipt_dir" || -L "$receipt_dir" ]] || return 0
    if [[ -L "$receipt_dir" || ! -d "$receipt_dir" ]]; then
        ui_error "Installer receipt directory ${receipt_dir} is not a real directory"
        return 1
    fi
    if [[ "$require_root_identity" == "1" ]] \
        && [[ "$(stat -c '%u:%g:%a' "$receipt_dir" 2>/dev/null || true)" != "0:0:700" ]]; then
        ui_error "Installer receipt directory ${receipt_dir} has unexpected ownership or mode"
        return 1
    fi
    local first_entry
    if ! first_entry="$(find "$receipt_dir" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)"; then
        ui_error "Could not inspect installer receipt directory ${receipt_dir}"
        return 1
    fi
    if [[ -n "$first_entry" ]]; then
        ui_error "Installer receipt directory ${receipt_dir} is not empty; preserving it"
        return 1
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[dry-run] would: rmdir ${receipt_dir}"
        return 0
    fi
    if ! rmdir "$receipt_dir"; then
        ui_error "Could not remove empty installer receipt directory ${receipt_dir}"
        return 1
    fi
    if [[ -e "$receipt_dir" || -L "$receipt_dir" ]]; then
        ui_error "Could not remove empty installer receipt directory ${receipt_dir}"
        return 1
    fi
    ui_success "Removed installer receipt directory"
}

preflight_full_uninstall() {
    FULL_UNINSTALL_NOOP=0
    [[ "$REMOVE_USER_FLAG" == "1" ]] || return 0
    if [[ "$OS" != "linux" ]]; then
        ui_error "--remove-user is Linux-only"
        return 1
    fi
    if ! is_root; then
        ui_error "--remove-user requires root"
        return 1
    fi

    if [[ -e "$INSTALL_RECEIPT_FILE" || -L "$INSTALL_RECEIPT_FILE" ]]; then
        if ! install_receipt_is_valid; then
            ui_error "Invalid installer ownership receipt at ${INSTALL_RECEIPT_FILE}; refusing full removal"
            return 1
        fi
        local receipt_user receipt_home
        receipt_user="$(install_receipt_value target_user)"
        receipt_home="$(install_receipt_value target_home)"
        if [[ "$receipt_user" != "$COMIS_USER" ]]; then
            ui_error "Installer receipt belongs to ${receipt_user} at ${receipt_home}, not ${COMIS_USER}; refusing full removal"
            return 1
        fi
        reconcile_install_receipt_decommission_state || return 1
        return 0
    fi

    if id "$COMIS_USER" >/dev/null 2>&1 || full_uninstall_artifacts_present; then
        ui_error "Comis dedicated-user artifacts exist without an ownership receipt; refusing full removal"
        ui_info "Run without --remove-user to preserve the account, or restore the root-owned installer receipt"
        return 1
    fi

    if [[ "$INSTALL_RECEIPT_FILE" == "/var/lib/comis-installer/receipt" ]] \
        && { [[ -e "/var/lib/comis-installer" ]] || [[ -L "/var/lib/comis-installer" ]]; }; then
        remove_empty_install_receipt_dir "/var/lib/comis-installer" 1 || return 1
    fi

    FULL_UNINSTALL_NOOP=1
    ui_info "No installer-owned dedicated-user installation found; nothing to remove"
    return 0
}

resolve_uninstall_target() {
    UNINSTALL_TARGET_USER="$(id -un)"
    UNINSTALL_TARGET_HOME="$HOME"
    UNINSTALL_TARGET_IS_DEDICATED=0

    if [[ "$OS" != "linux" ]] || ! is_root; then
        return 0
    fi

    if [[ -e "$INSTALL_RECEIPT_FILE" || -L "$INSTALL_RECEIPT_FILE" ]]; then
        if ! install_receipt_is_valid; then
            ui_error "Invalid installer ownership receipt at ${INSTALL_RECEIPT_FILE}; refusing to choose a destructive target"
            return 1
        fi
        local receipt_user receipt_home receipt_state
        receipt_user="$(install_receipt_value target_user)"
        receipt_home="$(install_receipt_value target_home)"
        receipt_state="$(install_receipt_value decommission_state)"
        if [[ "$receipt_user" != "$COMIS_USER" ]]; then
            ui_error "Installer receipt belongs to ${receipt_user} at ${receipt_home}, not ${COMIS_USER}"
            return 1
        fi
        if [[ "$receipt_state" != "active" && "$REMOVE_USER_FLAG" != "1" ]]; then
            ui_error "Installer receipt is in decommission state ${receipt_state}; refusing to target ${receipt_home}"
            return 1
        fi
        UNINSTALL_TARGET_USER="$receipt_user"
        UNINSTALL_TARGET_HOME="$receipt_home"
        UNINSTALL_TARGET_IS_DEDICATED=1
        return 0
    fi

    if [[ "$NO_USER" == "1" ]]; then
        return 0
    fi

    if ! id "$COMIS_USER" >/dev/null 2>&1; then
        return 0
    fi
    local candidate_home=""
    candidate_home="$(getent passwd "$COMIS_USER" 2>/dev/null | cut -d: -f6)"
    if [[ "$candidate_home" != /* || "$candidate_home" == "/" ]]; then
        return 0
    fi
    if ! dedicated_user_install_detected "$candidate_home"; then
        return 0
    fi

    UNINSTALL_TARGET_USER="$COMIS_USER"
    UNINSTALL_TARGET_HOME="$candidate_home"
    UNINSTALL_TARGET_IS_DEDICATED=1
}

show_preserved_data_location() {
    local data_dir="${UNINSTALL_TARGET_HOME:-$HOME}/.comis"
    ui_info "Data preserved under ${data_dir}. To delete manually:"
    echo "  rm -rf ${data_dir}"
}

confirm_uninstall() {
    if [[ "$ASSUME_YES" == "1" ]]; then
        return 0
    fi
    if ! is_promptable; then
        ui_error "Uninstall requires confirmation; pass --yes to skip (or run in a TTY)."
        exit 2
    fi

    echo ""
    ui_warn "About to uninstall Comis from this machine."
    echo "  - Service registration (systemd/pm2) will be removed"
    echo "  - CLI binary will be uninstalled"
    local data_dir="${UNINSTALL_TARGET_HOME:-$HOME}/.comis"
    if [[ "$PURGE" == "1" ]]; then
        echo "  - Data directory (${data_dir}) will be DELETED"
        echo "  - /etc/comis and /var/log/comis will be DELETED"
    else
        echo "  - Data directory (${data_dir}) will be PRESERVED"
    fi
    if [[ "$REMOVE_USER_FLAG" == "1" ]]; then
        echo "  - The ${COMIS_USER} system user will be DELETED"
        echo "  - Installer-managed Xvfb, sudoers, AppArmor, and ownership files will be DELETED"
        echo "  - Shared host runtimes and OS packages will be PRESERVED"
    fi
    echo ""
    local ans
    ans="$(prompt_choice "Continue? [y/N] ")"
    case "$ans" in
        y|Y|yes|YES) return 0 ;;
        *)
            ui_info "Uninstall cancelled."
            exit 0
            ;;
    esac
}

systemd_unit_is_stopped_and_disabled() {
    local scope="$1"
    local service_name="$2"
    local unit_path="$3"
    local active_state unit_file_state
    if [[ "$scope" == "system" ]]; then
        active_state="$(maybe_sudo systemctl show --property=ActiveState --value "$service_name" 2>/dev/null)" \
            || return 1
        unit_file_state="$(maybe_sudo systemctl show --property=UnitFileState --value "$service_name" 2>/dev/null)" \
            || return 1
    else
        active_state="$(systemctl --user show --property=ActiveState --value "$service_name" 2>/dev/null)" \
            || return 1
        unit_file_state="$(systemctl --user show --property=UnitFileState --value "$service_name" 2>/dev/null)" \
            || return 1
    fi

    case "$active_state" in
        inactive|failed) ;;
        *) return 1 ;;
    esac
    case "$unit_file_state" in
        disabled|masked|static|indirect|generated|transient) return 0 ;;
        "") [[ ! -e "$unit_path" && ! -L "$unit_path" ]] ;;
        *) return 1 ;;
    esac
}

uninstall_systemd_unit() {
    local scope="$1"  # "system" or "user"
    local unit_path
    local systemctl_scope=()
    if [[ "$scope" == "system" ]]; then
        unit_path="/etc/systemd/system/comis.service"
    else
        unit_path="${HOME}/.config/systemd/user/comis.service"
        systemctl_scope=("--user")
    fi

    if [[ -L "$unit_path" ]]; then
        ui_error "${unit_path} is a symlink; refusing to treat it as an installer-managed unit"
        return 1
    fi
    # Check if user-edited - if so, don't delete
    if [[ -f "$unit_path" ]] && ! unit_is_managed "$unit_path"; then
        ui_error "${unit_path} is not an unmodified installer-managed unit; refusing to remove it"
        return 1
    fi

    local service_known=0
    if command -v systemctl >/dev/null 2>&1; then
        if [[ "$scope" == "system" ]] \
            && { systemctl is-active --quiet comis.service 2>/dev/null \
                || systemctl is-enabled --quiet comis.service 2>/dev/null; }; then
            service_known=1
        elif [[ "$scope" == "user" ]] \
            && { systemctl --user is-active --quiet comis.service 2>/dev/null \
                || systemctl --user is-enabled --quiet comis.service 2>/dev/null; }; then
            service_known=1
        fi
    fi
    if [[ ! -e "$unit_path" && ! -L "$unit_path" && "$service_known" == "0" ]]; then
        return 0
    fi

    if [[ "$scope" == "system" ]]; then
        if [[ "$DRY_RUN" == "1" ]]; then
            ui_info "[dry-run] would: systemctl disable --now comis.service"
            [[ -f "$unit_path" ]] \
                && ui_info "[dry-run] would: rm ${unit_path} && systemctl daemon-reload"
            return 0
        fi
        if ! command -v systemctl >/dev/null 2>&1; then
            ui_error "systemctl is unavailable; refusing to remove a potentially loaded Comis service"
            return 1
        fi
        maybe_sudo systemctl disable --now comis.service 2>/dev/null || true
        if ! systemd_unit_is_stopped_and_disabled "system" "comis.service" "$unit_path"; then
            ui_error "Could not verify that comis.service is stopped and disabled; preserving its unit"
            return 1
        fi
        [[ -f "$unit_path" ]] && maybe_sudo rm -f "$unit_path"
        maybe_sudo systemctl daemon-reload
        maybe_sudo systemctl reset-failed comis.service 2>/dev/null || true
    else
        if [[ "$DRY_RUN" == "1" ]]; then
            ui_info "[dry-run] would: systemctl --user disable --now comis.service"
            [[ -f "$unit_path" ]] \
                && ui_info "[dry-run] would: rm ${unit_path} && systemctl --user daemon-reload"
            return 0
        fi
        if ! command -v systemctl >/dev/null 2>&1; then
            ui_error "systemctl is unavailable; refusing to remove a potentially loaded Comis user service"
            return 1
        fi
        systemctl "${systemctl_scope[@]}" disable --now comis.service 2>/dev/null || true
        if ! systemd_unit_is_stopped_and_disabled "user" "comis.service" "$unit_path"; then
            ui_error "Could not verify that the user comis.service is stopped and disabled; preserving its unit"
            return 1
        fi
        [[ -f "$unit_path" ]] && rm -f "$unit_path"
        # daemon-reload can fail if the user bus isn't reachable (headless,
        # non-lingering user sessions). Removal of the file is what matters.
        systemctl "${systemctl_scope[@]}" daemon-reload 2>/dev/null || true
    fi
    if [[ -e "$unit_path" || -L "$unit_path" ]]; then
        ui_error "Could not remove installer-managed systemd unit ${unit_path}"
        return 1
    fi
    ui_success "Removed systemd unit (${scope} scope)"
}

uninstall_sudoers_rule() {
    local sudoers_file="/etc/sudoers.d/comis"
    [[ -e "$sudoers_file" || -L "$sudoers_file" ]] || return 0
    if [[ -L "$sudoers_file" ]]; then
        ui_error "${sudoers_file} is a symlink; refusing to treat it as installer-managed"
        return 1
    fi
    if ! sudoers_rule_is_managed "$sudoers_file"; then
        ui_error "${sudoers_file} is not an unmodified installer-managed rule; refusing to remove it"
        return 1
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[dry-run] would: rm ${sudoers_file}"
        return 0
    fi
    maybe_sudo rm -f "$sudoers_file"
    if [[ -e "$sudoers_file" || -L "$sudoers_file" ]]; then
        ui_error "Could not remove installer-managed sudoers rule at ${sudoers_file}"
        return 1
    fi
    ui_success "Removed installer-managed sudoers rule"
}

uninstall_xvfb_unit() {
    # Companion unit installed by --with-xvfb. System-scope only (the
    # render_xvfb_unit function refuses to write a user-scope unit).
    local unit_path="/etc/systemd/system/comis-xvfb.service"
    local tmpfiles_path="/etc/tmpfiles.d/comis-x11.conf"
    local runtime_path="/run/comis-x11"
    local service_known=0
    if command -v systemctl >/dev/null 2>&1 \
        && { systemctl is-active --quiet comis-xvfb.service 2>/dev/null \
            || systemctl is-enabled --quiet comis-xvfb.service 2>/dev/null; }; then
        service_known=1
    fi

    if [[ -L "$unit_path" ]]; then
        ui_error "${unit_path} is a symlink; refusing Xvfb cleanup"
        return 1
    fi
    if [[ -L "$tmpfiles_path" ]]; then
        ui_error "${tmpfiles_path} is a symlink; refusing Xvfb cleanup"
        return 1
    fi
    if [[ -f "$unit_path" ]] && ! unit_is_managed "$unit_path"; then
        ui_error "${unit_path} is not an unmodified installer-managed unit; refusing Xvfb cleanup"
        return 1
    fi
    if [[ -f "$tmpfiles_path" ]] && ! xvfb_tmpfiles_rule_is_managed "$tmpfiles_path"; then
        ui_error "${tmpfiles_path} is not installer-managed; refusing Xvfb cleanup"
        return 1
    fi
    if [[ ! -e "$unit_path" && ! -L "$unit_path" \
        && ! -e "$tmpfiles_path" && ! -L "$tmpfiles_path" && ! -e "$runtime_path" \
        && "$service_known" == "0" ]]; then
        return 0
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
        if [[ -f "$unit_path" || "$service_known" == "1" ]]; then
            ui_info "[dry-run] would: systemctl disable --now comis-xvfb.service"
        fi
        if [[ -f "$unit_path" ]]; then
            ui_info "[dry-run] would: rm ${unit_path} && systemctl daemon-reload"
        fi
        ui_info "[dry-run] would: rm -f /etc/tmpfiles.d/comis-x11.conf"
        ui_info "[dry-run] would: rm -rf /run/comis-x11"
        return 0
    fi

    if [[ -f "$unit_path" || "$service_known" == "1" ]]; then
        if ! command -v systemctl >/dev/null 2>&1; then
            ui_error "systemctl is unavailable; refusing to remove a potentially loaded Xvfb service"
            return 1
        fi
        maybe_sudo systemctl disable --now comis-xvfb.service 2>/dev/null || true
        if ! systemd_unit_is_stopped_and_disabled \
            "system" "comis-xvfb.service" "$unit_path"; then
            ui_error "Could not verify that comis-xvfb.service is stopped and disabled; preserving its files"
            return 1
        fi
    fi
    if [[ -f "$unit_path" ]]; then
        maybe_sudo rm -f "$unit_path"
        maybe_sudo systemctl daemon-reload
        maybe_sudo systemctl reset-failed comis-xvfb.service 2>/dev/null || true
    fi
    maybe_sudo rm -f "$tmpfiles_path"
    maybe_sudo rm -rf "$runtime_path"
    if [[ -e "$unit_path" || -L "$unit_path" || -e "$tmpfiles_path" \
        || -L "$tmpfiles_path" || -e "$runtime_path" || -L "$runtime_path" ]]; then
        ui_error "Could not remove all installer-managed Xvfb artifacts"
        return 1
    fi
    ui_success "Removed installer-managed Xvfb artifacts"
}

pm2_saved_comis_process_exists() {
    local pm2_home="${PM2_HOME:-${HOME}/.pm2}"
    local dump_file="${pm2_home}/dump.pm2"
    [[ -f "$dump_file" && ! -L "$dump_file" ]] || return 1
    grep -Eq '"name"[[:space:]]*:[[:space:]]*"comis"' "$dump_file" 2>/dev/null
}

pm2_daemon_is_running() {
    local pm2_home="${PM2_HOME:-${HOME}/.pm2}"
    local pid_file="${pm2_home}/pm2.pid"
    [[ -f "$pid_file" && ! -L "$pid_file" ]] || return 1
    local pid command_line
    pid="$(tr -d '[:space:]' < "$pid_file" 2>/dev/null || true)"
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    command_line="$(ps -ww -o command= -p "$pid" 2>/dev/null || true)"
    [[ "$command_line" == *"PM2"* || "$command_line" == *"pm2"* ]]
}

uninstall_pm2() {
    local saved_process=0 running_daemon=0
    pm2_saved_comis_process_exists && saved_process=1
    pm2_daemon_is_running && running_daemon=1

    if [[ "$DRY_RUN" == "1" ]]; then
        if [[ "$saved_process" == "1" ]]; then
            ui_info "[dry-run] would: pm2 delete comis && pm2 save"
            if [[ "$OS" == "macos" ]]; then
                ui_info "[dry-run] would: sudo env PATH=\$PATH pm2 unstartup launchd"
            fi
        elif [[ "$running_daemon" == "1" ]]; then
            ui_info "[dry-run] would: inspect the active PM2 process list and remove comis if registered"
        fi
        return 0
    fi

    if [[ "$saved_process" == "0" && "$running_daemon" == "0" ]]; then
        return 0
    fi
    if ! command -v pm2 >/dev/null 2>&1; then
        ui_error "PM2 state exists but the pm2 command is unavailable; refusing to claim complete removal"
        return 1
    fi
    local process_list
    if ! process_list="$(pm2 jlist 2>/dev/null)"; then
        ui_error "Could not inspect the PM2 process list"
        return 1
    fi
    if ! grep -q '"name":"comis"' <<<"$process_list"; then
        if [[ "$saved_process" == "1" ]]; then
            ui_error "A saved Comis PM2 entry exists but is not loaded; remove it from ${PM2_HOME:-${HOME}/.pm2}/dump.pm2 before retrying"
            return 1
        fi
        return 0
    fi
    if ! pm2 delete comis 2>/dev/null; then
        ui_error "Could not delete the Comis PM2 process"
        return 1
    fi
    if pm2 jlist 2>/dev/null | grep -q '"name":"comis"'; then
        ui_error "PM2 still reports the Comis process after deletion"
        return 1
    fi
    if ! pm2 save 2>/dev/null; then
        ui_error "Could not persist the updated PM2 process list"
        return 1
    fi
    if [[ "$OS" == "macos" ]] && can_elevate; then
        # pm2 unstartup prints the sudo command and exits non-zero
        local out
        out="$(pm2 unstartup launchd 2>&1 || true)"
        local sudo_cmd
        sudo_cmd="$(echo "$out" | grep -oE 'sudo env PATH=[^\n]+pm2 unstartup[^\n]+' | head -n1 || true)"
        if [[ -n "$sudo_cmd" ]]; then
            if ! sh -c "$sudo_cmd" >/dev/null 2>&1; then
                ui_error "Could not remove the PM2 launchd startup entry"
                return 1
            fi
        fi
    fi
    ui_success "Removed from pm2"
}

uninstall_direct_daemon() {
    local pid_file="${UNINSTALL_TARGET_HOME:-$HOME}/.comis/daemon.pid"
    [[ -f "$pid_file" ]] || return 0
    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[dry-run] would: stop direct-spawn daemon and remove ${pid_file}"
        return 0
    fi
    cleanup_legacy_daemon_state
}

uninstall_binary() {
    local target_home="${UNINSTALL_TARGET_HOME:-$HOME}"
    if [[ "$DRY_RUN" == "1" ]]; then
        if [[ "$UNINSTALL_TARGET_IS_DEDICATED" == "1" ]]; then
            ui_info "[dry-run] would: uninstall comisai from ${target_home}/.npm-global as ${UNINSTALL_TARGET_USER}"
        else
            ui_info "[dry-run] would: npm uninstall -g comisai OR rm ${target_home}/.local/bin/comis"
        fi
        return 0
    fi

    # Remove the ~/.local/bin/comis wrapper (git install)
    if [[ -L "${target_home}/.local/bin/comis" ]] || [[ -f "${target_home}/.local/bin/comis" ]]; then
        rm -f "${target_home}/.local/bin/comis"
        ui_info "Removed ${target_home}/.local/bin/comis"
    fi

    if [[ "$UNINSTALL_TARGET_IS_DEDICATED" == "1" ]]; then
        local npm_list_cmd='npm --prefix "$HOME/.npm-global" list -g comisai'
        local npm_uninstall_cmd='npm --prefix "$HOME/.npm-global" uninstall -g comisai'
        if su - "$UNINSTALL_TARGET_USER" -c "$npm_list_cmd" >/dev/null 2>&1; then
            if ! su - "$UNINSTALL_TARGET_USER" -c "$npm_uninstall_cmd" >/dev/null 2>&1; then
                ui_warn "Could not remove comisai from ${target_home}/.npm-global"
                ui_info "Run manually: su - ${UNINSTALL_TARGET_USER} -c '${npm_uninstall_cmd}'"
                return 1
            fi
            ui_info "Removed comisai from ${target_home}/.npm-global"
        fi
        ui_success "CLI removal complete"
        return 0
    fi

    # Remove the npm global package
    if npm list -g comisai >/dev/null 2>&1; then
        if [[ "$OS" == "linux" ]] && ! is_root && ! [[ -w "$(npm root -g 2>/dev/null || echo /)" ]]; then
            if ! sudo npm uninstall -g comisai 2>/dev/null; then
                ui_warn "Could not remove the global comisai package"
                return 1
            fi
        else
            if ! npm uninstall -g comisai 2>/dev/null; then
                ui_warn "Could not remove the global comisai package"
                return 1
            fi
        fi
        ui_info "npm uninstall -g comisai"
    fi
    ui_success "CLI removal complete"
}

uninstall_purge_data() {
    [[ "$PURGE" == "1" ]] || return 0

    local target_home="${UNINSTALL_TARGET_HOME:-$HOME}"
    local data_dir="${target_home}/.comis"

    # Cloakbrowser artifacts (created by --with-cloakbrowser installs):
    #   .cloakbrowser/           - alternative Chromium runtime cache (~200MB per
    #                              version, auto-update may keep ≥1 version)
    #   .cloakbrowser-wrapper/   - installer-managed npm wrapper dir
    # Both belong to the daemon's user; safe to purge with the rest of the
    # daemon's data when --purge is set.
    local cloak_paths=(
        "${target_home}/.cloakbrowser"
        "${target_home}/.cloakbrowser-wrapper"
    )

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[dry-run] would: rm -rf ${data_dir}"
        ui_info "[dry-run] would: rm -rf /etc/comis /var/log/comis"
        for p in "${cloak_paths[@]}"; do
            [[ -d "$p" ]] && ui_info "[dry-run] would: rm -rf ${p}"
        done
        return 0
    fi

    if [[ -e "$data_dir" || -L "$data_dir" ]]; then
        local data_owner_uid=""
        data_owner_uid="$(stat -c %u "$data_dir" 2>/dev/null || stat -f %u "$data_dir" 2>/dev/null || echo "")"
        if [[ "$data_owner_uid" == "$(id -u)" ]]; then
            rm -rf "$data_dir"
        else
            maybe_sudo rm -rf "$data_dir"
        fi
        if [[ -e "$data_dir" || -L "$data_dir" ]]; then
            ui_error "Could not remove ${data_dir}"
            return 1
        fi
        ui_success "Removed ${data_dir}"
    fi

    if [[ -e /etc/comis || -L /etc/comis ]]; then
        maybe_sudo rm -rf /etc/comis
        if [[ -e /etc/comis || -L /etc/comis ]]; then
            ui_error "Could not remove /etc/comis"
            return 1
        fi
        ui_success "Removed /etc/comis"
    fi

    if [[ -e /var/log/comis || -L /var/log/comis ]]; then
        maybe_sudo rm -rf /var/log/comis
        if [[ -e /var/log/comis || -L /var/log/comis ]]; then
            ui_error "Could not remove /var/log/comis"
            return 1
        fi
        ui_success "Removed /var/log/comis"
    fi

    # CloakBrowser cache + wrapper. Use maybe_sudo for paths owned by the
    # service user; current-user paths fall through to a plain rm.
    for p in "${cloak_paths[@]}"; do
        [[ -d "$p" ]] || continue
        local owner_uid
        owner_uid="$(stat -c %u "$p" 2>/dev/null || stat -f %u "$p" 2>/dev/null || echo "")"
        if [[ "$owner_uid" == "$(id -u)" ]]; then
            rm -rf "$p"
        else
            maybe_sudo rm -rf "$p"
        fi
        ui_success "Removed ${p}"
    done
}

# uninstall_egress_chain
# ----------------------
# Reverse install_egress_logging(): drop the uid-scoped OUTPUT jump(s), then
# flush and delete the COMIS_EGRESS chain. Runs on the purge path BEFORE the
# comis user is removed - the OUTPUT rule is uid-scoped, and deleting by rule
# number keeps this working even when the uid no longer resolves to a name.
# Idempotent and non-fatal: silently skipped when iptables is unavailable or
# the chain does not exist.
uninstall_egress_chain() {
    [[ "$OS" == "linux" ]] || return 0
    command -v iptables >/dev/null 2>&1 || return 0

    local sudo_prefix=""
    if ! is_root; then
        sudo_prefix="sudo "
    fi

    $sudo_prefix iptables -L COMIS_EGRESS -n >/dev/null 2>&1 || return 0

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[dry-run] would: remove COMIS_EGRESS iptables chain (OUTPUT jump, flush, delete)"
        return 0
    fi

    # Unhook every OUTPUT jump into the chain, highest rule number first so
    # earlier deletions don't renumber the ones still pending.
    local jump_nums
    jump_nums="$($sudo_prefix iptables -L OUTPUT --line-numbers -n 2>/dev/null | awk '$2 == "COMIS_EGRESS" {print $1}' | sort -rn)"
    local n
    for n in $jump_nums; do
        $sudo_prefix iptables -D OUTPUT "$n" 2>/dev/null || true
    done

    $sudo_prefix iptables -F COMIS_EGRESS 2>/dev/null || true
    if $sudo_prefix iptables -X COMIS_EGRESS 2>/dev/null; then
        ui_success "Removed COMIS_EGRESS iptables chain"
    else
        ui_error "Could not delete COMIS_EGRESS chain - remove manually: iptables -X COMIS_EGRESS"
        return 1
    fi
    return 0
}

uninstall_managed_apparmor_profile() {
    [[ "$REMOVE_USER_FLAG" == "1" ]] || return 0
    [[ "$OS" == "linux" ]] || return 0
    local profile="/etc/apparmor.d/bwrap"
    [[ -e "$profile" || -L "$profile" ]] || return 0
    if [[ -L "$profile" ]]; then
        ui_error "${profile} is a symlink; refusing to treat it as installer-managed"
        return 1
    fi
    if ! apparmor_bwrap_profile_is_managed "$profile"; then
        if grep -Fxq "# managed-by: comis-installer" "$profile" 2>/dev/null; then
            ui_error "Installer-managed AppArmor profile ${profile} was modified; refusing to remove it"
            return 1
        fi
        ui_warn "${profile} is not installer-managed; leaving it untouched"
        return 0
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[dry-run] would: unload and remove ${profile}"
        return 0
    fi
    local loaded_profiles="/sys/kernel/security/apparmor/profiles"
    if [[ ! -f "$loaded_profiles" || -L "$loaded_profiles" || ! -r "$loaded_profiles" ]]; then
        ui_error "Cannot verify loaded AppArmor profiles; preserving ${profile}"
        return 1
    fi
    local profile_loaded=0
    if grep -q '^bwrap ' "$loaded_profiles" 2>/dev/null; then
        profile_loaded=1
    fi
    if [[ "$profile_loaded" == "1" ]]; then
        if ! command -v apparmor_parser >/dev/null 2>&1; then
            ui_error "The bwrap AppArmor profile is loaded but apparmor_parser is unavailable"
            return 1
        fi
        if ! maybe_sudo apparmor_parser -R "$profile" >/dev/null 2>&1; then
            ui_error "Could not unload installer-managed AppArmor profile ${profile}"
            return 1
        fi
    fi
    if grep -q '^bwrap ' "$loaded_profiles" 2>/dev/null; then
        ui_error "AppArmor still reports the bwrap profile as loaded"
        return 1
    fi
    maybe_sudo rm -f "$profile"
    if [[ -e "$profile" || -L "$profile" ]]; then
        ui_error "Could not remove installer-managed AppArmor profile at ${profile}"
        return 1
    fi
    ui_success "Removed installer-managed AppArmor profile"
}

uninstall_remove_user() {
    [[ "$REMOVE_USER_FLAG" == "1" ]] || return 0
    if [[ "$OS" != "linux" ]]; then
        ui_warn "--remove-user is Linux-only; ignoring"
        return 0
    fi
    if ! is_root; then
        ui_error "--remove-user requires root"
        return 1
    fi
    if ! install_receipt_is_valid; then
        ui_error "Refusing to delete ${COMIS_USER}: the installer-created account receipt is missing or invalid"
        return 1
    fi
    if ! install_receipt_matches_target "$COMIS_USER" "$UNINSTALL_TARGET_HOME"; then
        ui_error "Refusing to delete ${COMIS_USER}: the installer receipt does not match ${UNINSTALL_TARGET_HOME}"
        return 1
    fi

    local decommission_state created_user created_group receipt_uid receipt_gid identity_token
    decommission_state="$(install_receipt_raw_value decommission_state)"
    created_user="$(install_receipt_raw_value created_user)"
    created_group="$(install_receipt_raw_value created_group)"
    receipt_uid="$(install_receipt_raw_value target_uid)"
    receipt_gid="$(install_receipt_raw_value target_gid)"
    identity_token="$(install_receipt_raw_value identity_token)"

    if [[ "$decommission_state" != "active" ]]; then
        if install_receipt_owned_artifacts_present; then
            ui_error "Refusing to retry account deletion: the decommission receipt is ${decommission_state} but an owned path or identity is present"
            return 1
        fi
        if [[ "$DRY_RUN" == "1" ]]; then
            [[ "$decommission_state" == "removing" ]] \
                && ui_info "[dry-run] would: finalize the interrupted account-removal receipt"
            return 0
        fi
        if [[ "$decommission_state" == "removing" ]] \
            && ! update_install_receipt_decommission_state "removing" "removed"; then
            ui_error "Could not finalize the interrupted account-removal receipt"
            return 1
        fi
        return 0
    fi

    if [[ "$created_user" != "1" ]]; then
        ui_error "Refusing to delete ${COMIS_USER}: no installer-created user receipt matches ${UNINSTALL_TARGET_HOME}"
        return 1
    fi
    local user_exists=0
    id "$COMIS_USER" >/dev/null 2>&1 && user_exists=1
    if [[ "$user_exists" != "1" ]]; then
        ui_error "Refusing to delete stale account paths: the active receipt user no longer exists"
        return 1
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[dry-run] would: atomically mark the account-removal receipt as removing"
        ui_info "[dry-run] would: userdel -r ${COMIS_USER}"
        if [[ "$created_group" == "1" ]]; then
            ui_info "[dry-run] would: groupdel ${COMIS_USER}"
        fi
        return 0
    fi

    # Service cleanup runs first. Any remaining process means account deletion
    # is unsafe, regardless of its command name.
    if [[ "$user_exists" == "1" ]] && pgrep -u "$COMIS_USER" >/dev/null 2>&1; then
        ui_error "Other processes are running as ${COMIS_USER}; refusing to delete the user"
        return 1
    fi

    if ! update_install_receipt_decommission_state "active" "removing"; then
        ui_error "Could not mark the installer-created account as removing"
        return 1
    fi

    if ! userdel -r "$COMIS_USER" 2>/dev/null; then
        userdel "$COMIS_USER" 2>/dev/null || true
    fi
    if id "$COMIS_USER" >/dev/null 2>&1; then
        ui_error "Could not remove installer-created user ${COMIS_USER}"
        return 1
    fi

    # `userdel` without `-r` is the fallback on platforms where home removal
    # fails. Recheck both the root marker and numeric directory owner immediately
    # before deleting the remaining home.
    if [[ -e "$UNINSTALL_TARGET_HOME" || -L "$UNINSTALL_TARGET_HOME" ]]; then
        if ! install_home_identity_is_valid "$UNINSTALL_TARGET_HOME" \
            "$receipt_uid" "$receipt_gid" "$identity_token"; then
            ui_error "Receipt-owned home ${UNINSTALL_TARGET_HOME} no longer matches its recorded identity"
            return 1
        fi
        rm -rf "$UNINSTALL_TARGET_HOME"
        if [[ -e "$UNINSTALL_TARGET_HOME" || -L "$UNINSTALL_TARGET_HOME" ]]; then
            ui_error "Could not remove receipt-owned home ${UNINSTALL_TARGET_HOME}"
            return 1
        fi
    fi

    if [[ "$created_group" == "1" ]] && getent group "$COMIS_USER" >/dev/null 2>&1; then
        local current_group_gid
        current_group_gid="$(getent group "$COMIS_USER" 2>/dev/null | cut -d: -f3)"
        if [[ "$current_group_gid" != "$receipt_gid" ]]; then
            ui_error "Refusing to delete group ${COMIS_USER}: its GID no longer matches the installer receipt"
            return 1
        fi
        groupdel "$COMIS_USER" 2>/dev/null || true
        if getent group "$COMIS_USER" >/dev/null 2>&1; then
            ui_error "Could not remove installer-created group ${COMIS_USER}"
            return 1
        fi
    fi

    if install_receipt_owned_artifacts_present; then
        ui_error "Installer-owned account artifacts remain after deletion"
        return 1
    fi
    if ! update_install_receipt_decommission_state "removing" "removed"; then
        ui_error "Account removal completed, but its receipt state could not be finalized"
        return 1
    fi
    ui_success "Removed user ${COMIS_USER}"
    return 0
}

uninstall_install_receipt() {
    [[ "$REMOVE_USER_FLAG" == "1" ]] || return 0
    [[ -e "$INSTALL_RECEIPT_FILE" || -L "$INSTALL_RECEIPT_FILE" ]] || return 0
    if ! install_receipt_is_valid; then
        ui_error "Refusing to remove invalid installer receipt at ${INSTALL_RECEIPT_FILE}"
        return 1
    fi
    if ! install_receipt_matches_target "$COMIS_USER" "$UNINSTALL_TARGET_HOME"; then
        ui_error "Installer receipt does not match ${COMIS_USER} at ${UNINSTALL_TARGET_HOME}; preserving it"
        return 1
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[dry-run] would: rm ${INSTALL_RECEIPT_FILE}"
        return 0
    fi
    local decommission_state
    decommission_state="$(install_receipt_raw_value decommission_state)"
    if install_receipt_owned_artifacts_present; then
        ui_error "Installer-owned account artifacts still exist; preserving the decommission receipt"
        return 1
    fi
    if [[ "$decommission_state" == "removing" ]]; then
        if ! update_install_receipt_decommission_state "removing" "removed"; then
            ui_error "Could not finalize the interrupted account-removal receipt"
            return 1
        fi
        decommission_state="removed"
    fi
    if [[ "$decommission_state" != "removed" ]]; then
        ui_error "Dedicated account removal is not finalized; preserving its installer receipt"
        return 1
    fi
    maybe_sudo rm -f "$INSTALL_RECEIPT_FILE"
    if [[ -e "$INSTALL_RECEIPT_FILE" || -L "$INSTALL_RECEIPT_FILE" ]]; then
        ui_error "Could not remove installer receipt at ${INSTALL_RECEIPT_FILE}"
        return 1
    fi
    if [[ "$INSTALL_RECEIPT_FILE" == "/var/lib/comis-installer/receipt" ]]; then
        remove_empty_install_receipt_dir "/var/lib/comis-installer" 1 || return 1
    fi
    ui_success "Removed installer ownership receipt"
}

uninstall_main() {
    print_installer_banner
    detect_os_or_die
    preflight_full_uninstall
    if [[ "$FULL_UNINSTALL_NOOP" == "1" ]]; then
        return 0
    fi
    resolve_uninstall_target
    if [[ "$REMOVE_USER_FLAG" == "1" ]] && id "$COMIS_USER" >/dev/null 2>&1 \
        && ! install_receipt_created_user "$COMIS_USER" "$UNINSTALL_TARGET_HOME"; then
        ui_error "Cannot remove ${COMIS_USER}: the installer has no ownership receipt for that account"
        ui_info "Run without --remove-user to remove Comis while preserving the account"
        return 1
    fi

    ui_section "Uninstall plan"
    ui_kv "Mode" "uninstall"
    ui_kv "CLI user" "$UNINSTALL_TARGET_USER"
    ui_kv "Data directory" "${UNINSTALL_TARGET_HOME}/.comis"
    [[ "$PURGE" == "1" ]] && ui_kv "Purge data" "yes"
    [[ "$REMOVE_USER_FLAG" == "1" ]] && ui_kv "Remove user" "yes"
    [[ "$REMOVE_USER_FLAG" == "1" ]] && ui_kv "Shared host dependencies" "preserved"
    [[ "$DRY_RUN" == "1" ]] && ui_kv "Dry run" "yes"

    if [[ "$DRY_RUN" != "1" ]]; then
        confirm_uninstall
        bootstrap_gum_temp || true
        print_gum_status
    fi

    ui_stage "Stopping and unregistering services"

    # Try all three paths - they're all idempotent no-ops if nothing matches
    uninstall_systemd_unit "system"
    [[ "$OS" == "linux" ]] && [[ "${HOME}" != "/root" ]] && uninstall_systemd_unit "user"
    uninstall_xvfb_unit
    uninstall_sudoers_rule
    uninstall_pm2
    uninstall_direct_daemon

    ui_stage "Removing CLI"
    uninstall_binary

    if [[ "$PURGE" == "1" || "$REMOVE_USER_FLAG" == "1" ]]; then
        ui_stage "Purging data"
        uninstall_purge_data
        uninstall_egress_chain
    fi

    if [[ "$REMOVE_USER_FLAG" == "1" ]]; then
        uninstall_managed_apparmor_profile
        uninstall_remove_user
        uninstall_install_receipt
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_success "Dry run complete (no changes made)"
        return 0
    fi

    echo ""
    ui_celebrate "Comis uninstalled"

    if [[ "$REMOVE_USER_FLAG" == "1" ]]; then
        ui_info "Shared host runtimes and OS packages were preserved"
    fi

    if [[ "$PURGE" != "1" ]]; then
        echo ""
        show_preserved_data_location
    fi

    if [[ "$OS" == "macos" ]] && command -v pm2 >/dev/null 2>&1; then
        echo ""
        ui_info "pm2 is still installed. Other apps may depend on it."
        ui_info "To remove pm2 itself: npm uninstall -g pm2"
    fi
}

# Main installation flow
main() {
    if [[ "$HELP" == "1" ]]; then
        print_usage
        return 0
    fi

    # Uninstall dispatch happens before any other setup - it has its own flow
    if [[ "$UNINSTALL" == "1" ]]; then
        uninstall_main
        return $?
    fi

    if [[ "$COMIS_REEXEC" == "1" ]]; then
        detect_os_or_die
        echo ""
        ui_info "Continuing as user '$(whoami)'"
        # The re-exec'd instance installs the CLI for the comis user only.
        # Service registration is the parent (root) shell's job.
        SERVICE_MANAGER="none"
    else
        print_installer_banner
        detect_os_or_die
    fi

    if [[ "$OS" == "linux" ]] && ! validate_comis_user_name; then
        return 1
    fi

    # Reject an impossible local package source before sudo prompts, dependency
    # installation, account creation, or any other host mutation. install_comis()
    # checks again in case the path changes after this preflight.
    if ! validate_local_tarball_preflight; then
        return 1
    fi

    # Linux non-root: the dedicated-user layout is the default. Ask to elevate
    # (or require an explicit --no-user) before any other prompt runs, so the
    # sudo re-run owns the rest of the interactive flow.
    enforce_dedicated_user_default

    local detected_checkout=""
    detected_checkout="$(detect_comis_checkout "$PWD" || true)"

    if [[ -z "$INSTALL_METHOD" && -n "$detected_checkout" ]]; then
        if ! is_promptable; then
            ui_info "Found Comis checkout but no TTY; defaulting to npm install"
            INSTALL_METHOD="npm"
        else
            local selected_method=""
            selected_method="$(choose_install_method_interactive "$detected_checkout" || true)"
            case "$selected_method" in
                git|npm)
                    INSTALL_METHOD="$selected_method"
                    ;;
                *)
                    ui_info "Defaulting to npm install"
                    INSTALL_METHOD="npm"
                    ;;
            esac
        fi
    fi

    if [[ -z "$INSTALL_METHOD" ]]; then
        INSTALL_METHOD="npm"
    fi

    if [[ "$INSTALL_METHOD" != "npm" && "$INSTALL_METHOD" != "git" ]]; then
        ui_error "invalid --install-method: ${INSTALL_METHOD}"
        echo "Use: --install-method npm|git"
        exit 2
    fi

    # Resolve which service manager we'll use (validates --service flag early)
    resolve_service_manager
    if [[ "$COMIS_REEXEC" != "1" ]]; then
        downshift_xvfb_for_service_manager
    fi

    if [[ "$COMIS_REEXEC" != "1" ]]; then
        show_install_plan "$detected_checkout"
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_success "Dry run complete (no changes made)"
        if [[ "$RESOLVED_SERVICE_MANAGER" != "none" ]]; then
            ui_info "Would register service via: ${RESOLVED_SERVICE_MANAGER}"
        fi
        return 0
    fi

    bootstrap_gum_temp || true
    print_gum_status

    # On Linux as root: install system deps, create dedicated user, install CLI
    # as comis user (re-exec), then return here (still root) and register the
    # systemd system-scope service pointing at the comis user's install.
    if should_create_dedicated_user; then
        install_system_deps_as_root
        create_comis_user
        # Optional egress logging for the comis user. The function is an exact
        # opt-in gate and makes no iptables changes by default. Non-fatal when
        # enabled so diagnostics cannot block the install.
        install_egress_logging || true
        reexec_as_comis_user
        local user_rc=$?
        if [[ "$user_rc" -ne 0 ]]; then
            ui_error "CLI install as user '${COMIS_USER}' failed (rc=${user_rc})"
            return "$user_rc"
        fi

        # Still root. Register the service on the parent's behalf.
        if ! register_service; then
            ui_error "Comis CLI was installed, but service setup failed"
            ui_info "Review the error above, then rerun the installer or use --service none"
            return 1
        fi

        # Resolve version from the comis user's install (root can't see their PATH)
        local installed_version=""
        local comis_home
        comis_home="$(eval echo "~$COMIS_USER")"
        local comis_npm_root="${comis_home}/.npm-global/lib/node_modules"
        if [[ -f "${comis_npm_root}/comisai/package.json" ]]; then
            installed_version=$(node -e "console.log(require('${comis_npm_root}/comisai/package.json').version)" 2>/dev/null || true)
        fi
        if [[ -z "$installed_version" ]]; then
            installed_version=$(su - "$COMIS_USER" -c "comis --version 2>/dev/null" 2>/dev/null | head -n 1 | tr -d '\r' || true)
        fi

        echo ""
        if [[ -n "$installed_version" ]]; then
            ui_celebrate "Comis installed successfully (${installed_version})!"
        else
            ui_celebrate "Comis installed successfully!"
        fi
        echo ""

        show_next_step "comis init" "Set up your first agent and connect a chat channel"
        ui_section "Run commands as the comis user"
        echo "  su - $COMIS_USER"
        echo "  comis init"
        echo "  comis daemon start"

        show_footer_links
        return 0
    fi

    # Check for existing installation
    local is_upgrade=false
    if check_existing_comis; then
        is_upgrade=true
    fi

    ui_stage "Preparing environment"

    # Step 1: Homebrew (macOS only)
    install_homebrew

    # Step 2: Node.js
    if ! check_node; then
        install_node
    fi
    ensure_supported_node_on_path || true
    if ! has_supported_node; then
        ui_error "Node.js >=${MIN_NODE_VERSION} is required but could not be activated on PATH"
        echo "Detected node: $(command -v node 2>/dev/null || echo '(not found)')"
        echo "Current version: $(node -v 2>/dev/null || echo 'unknown')"
        echo "Install Node.js >=${MIN_NODE_VERSION} manually: https://nodejs.org"
        exit 1
    fi

    # Keep optional package-runner toolchains available on ordinary Linux
    # installs too. The dedicated system-user path installs them before re-exec.
    if [[ "$OS" == "linux" && "$COMIS_REEXEC" != "1" ]]; then
        install_uv
        install_rust
    fi

    ui_stage "Installing Comis"

    local final_git_dir=""
    if [[ "$INSTALL_METHOD" == "git" ]]; then
        # Clean up npm global install if switching to git
        if npm list -g comisai &>/dev/null; then
            ui_info "Removing npm global install (switching to git)"
            npm uninstall -g comisai 2>/dev/null || true
            ui_success "npm global install removed"
        fi

        local repo_dir="$GIT_DIR"
        if [[ -n "$detected_checkout" ]]; then
            repo_dir="$detected_checkout"
        fi
        final_git_dir="$repo_dir"
        install_comis_from_git "$repo_dir"
    else
        # Clean up git wrapper if switching to npm
        if [[ -x "$HOME/.local/bin/comis" ]]; then
            ui_info "Removing git wrapper (switching to npm)"
            rm -f "$HOME/.local/bin/comis"
            ui_success "git wrapper removed"
        fi

        # Step 3: Git (required for npm installs that may fetch from git or apply patches)
        if ! check_git; then
            install_git
        fi

        # Step 4: npm permissions (Linux)
        fix_npm_permissions

        # Step 5: Comis
        install_comis
        install_comis_compat_shim || true
    fi

    ui_stage "Finalizing setup"

    COMIS_BIN="$(resolve_comis_bin || true)"
    if [[ -z "$COMIS_BIN" ]]; then
        ui_error "Comis installation finished without an executable CLI on PATH"
        ui_info "Review the npm output above and rerun with --verbose"
        return 1
    fi
    local verified_cli_version=""
    verified_cli_version="$("$COMIS_BIN" --version 2>/dev/null | head -n 1 | tr -d '\r' || true)"
    if [[ -z "$verified_cli_version" ]]; then
        ui_error "The installed Comis CLI could not start"
        ui_info "Rerun with --verbose and inspect the package installation errors above"
        return 1
    fi

    # Restart daemon if already running under any manager
    restart_service_if_running

    # Run doctor on upgrades and git installs
    if [[ "$COMIS_REEXEC" != "1" ]] \
        && [[ "$is_upgrade" == "true" || "$INSTALL_METHOD" == "git" ]]; then
        run_doctor
    fi

    # CloakBrowser binary provisioning (per-user; runs in both the reexec'd
    # child and the non-root operator flow). No-op unless --with-cloakbrowser
    # is set. Must happen before register_service so the daemon's first start
    # finds the binary at ~/.cloakbrowser/.
    if [[ "$OS" == "linux" && "$WITH_CLOAKBROWSER" == "1" ]]; then
        install_cloakbrowser || true
    fi

    # Seed the browser config block here (in addition to the systemd-scope
    # call inside register_service_systemd) so that --service none / Docker
    # paths also get config.yaml populated. maybe_seed_browser_config is
    # idempotent: it skips when a `browser:` block already exists, and runs
    # only when --with-browser / --with-cloakbrowser / --with-xvfb is set.
    if [[ "$WITH_BROWSER" == "1" ]] && [[ "$COMIS_REEXEC" != "1" ]]; then
        # In the dedicated-user root flow, COMIS_CONFIG_FILE is set by
        # resolve_service_template_vars (called from register_service). When
        # --service none is in play that doesn't run, so we resolve the
        # config path here too. Default to the current user's ~/.comis path.
        if [[ -z "${COMIS_CONFIG_FILE:-}" ]]; then
            COMIS_CONFIG_FILE="${HOME}/.comis/config.yaml"
            mkdir -p "${HOME}/.comis" 2>/dev/null || true
        fi
        maybe_seed_browser_config
    fi

    # Register the daemon with the selected service manager.
    # For re-exec'd children (SERVICE_MANAGER=none), this is a silent no-op -
    # service registration and the success banner are the root parent's job.
    if [[ "$COMIS_REEXEC" != "1" ]]; then
        # Browser runtime - no-op unless --with-browser was passed. Runs here
        # so the non-root install path also gets Chromium provisioned (root +
        # dedicated-user installs hit install_browser_deps_linux earlier via
        # install_system_deps_as_root).
        if [[ "$OS" == "linux" ]]; then
            install_browser_deps_linux || true
        fi
        if ! register_service; then
            ui_error "Comis CLI was installed, but service setup failed"
            ui_info "Review the error above, then rerun the installer or use --service none"
            return 1
        fi
    fi

    # Re-exec'd children exit here - the root parent handles the success
    # banner and footer after it registers the systemd service.
    if [[ "$COMIS_REEXEC" == "1" ]]; then
        ui_success "Comis CLI installed"
        return 0
    fi

    local installed_version=""
    installed_version="$verified_cli_version"

    echo ""
    if [[ -n "$installed_version" ]]; then
        ui_celebrate "Comis installed successfully (${installed_version})!"
    else
        ui_celebrate "Comis installed successfully!"
    fi
    if [[ "$is_upgrade" == "true" ]]; then
        echo -e "${MUTED}Your config is intact, your agents are refreshed.${NC}"
    fi
    echo ""

    if [[ "$INSTALL_METHOD" == "git" && -n "$final_git_dir" ]]; then
        ui_section "Source install details"
        ui_kv "Checkout" "$final_git_dir"
        ui_kv "Wrapper" "$HOME/.local/bin/comis"
        ui_kv "Build command" "cd $final_git_dir && pnpm build"
        show_next_step "comis init" "Set up your first agent and connect a chat channel"
    elif [[ "$is_upgrade" == "true" ]]; then
        if (echo -n "" > /dev/tty) 2>/dev/null; then
            local comis_bin="${COMIS_BIN:-}"
            if [[ -z "$comis_bin" ]]; then
                comis_bin="$(resolve_comis_bin || true)"
            fi
            if [[ -z "$comis_bin" ]]; then
                warn_comis_not_found
                show_footer_links
                return 0
            fi
            ui_info "Running comis doctor"
            "$comis_bin" doctor </dev/tty || true
        else
            show_next_step "comis doctor" "Verify everything looks good"
        fi
    else
        if [[ "$NO_INIT" == "1" ]]; then
            show_next_step "comis init" "Set up your first agent and connect a chat channel"
        else
            local config_path="$HOME/.comis/config.yaml"
            if [[ -f "${config_path}" ]]; then
                run_doctor
            else
                if (echo -n "" > /dev/tty) 2>/dev/null; then
                    local comis_bin="${COMIS_BIN:-}"
                    if [[ -z "$comis_bin" ]]; then
                        comis_bin="$(resolve_comis_bin || true)"
                    fi
                    if [[ -z "$comis_bin" ]]; then
                        warn_comis_not_found
                        show_footer_links
                        return 0
                    fi
                    exec </dev/tty
                    exec "$comis_bin" init
                fi
                show_next_step "comis init" "Set up your first agent and connect a chat channel"
            fi
        fi
    fi

    # Final restart via whichever manager owns the daemon now
    restart_service_if_running

    show_footer_links
}

if [[ "${COMIS_INSTALL_SH_NO_RUN:-0}" != "1" ]]; then
    ORIGINAL_ARGS=("$@")
    parse_args "$@"
    configure_verbose
    main
fi
