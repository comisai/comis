#!/bin/bash
set -euo pipefail

# Comis Installer for macOS and Linux
# Usage: curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh | bash

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

DEFAULT_TAGLINE="Friendly by nature. Powerful by design."

ORIGINAL_PATH="${PATH:-}"

TMPFILES=()
cleanup_tmpfiles() {
    local f
    for f in "${TMPFILES[@]:-}"; do
        rm -rf "$f" 2>/dev/null || true
    done
}
trap cleanup_tmpfiles EXIT

mktempfile() {
    local f
    f="$(mktemp)"
    TMPFILES+=("$f")
    echo "$f"
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

run_remote_bash() {
    local url="$1"
    local tmp
    tmp="$(mktempfile)"
    download_file "$url" "$tmp"
    /bin/bash "$tmp"
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

    echo -e "${ACCENT}${BOLD}"
    echo "  Comis Installer"
    echo -e "${NC}${INFO}  ${TAGLINE}${NC}"
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
        echo "On Windows, install Node.js 22+ from https://nodejs.org, then run:"
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
        echo -e "${MUTED}.${NC} ${msg}"
    fi
}

ui_warn() {
    local msg="$*"
    if [[ -n "$GUM" ]]; then
        "$GUM" log --level warn "$msg"
    else
        echo -e "${WARN}!${NC} ${msg}"
    fi
}

ui_success() {
    local msg="$*"
    if [[ -n "$GUM" ]]; then
        local mark
        mark="$("$GUM" style --foreground "#06B6D4" --bold "[ok]")"
        echo "${mark} ${msg}"
    else
        echo -e "${SUCCESS}[ok]${NC} ${msg}"
    fi
}

ui_error() {
    local msg="$*"
    if [[ -n "$GUM" ]]; then
        "$GUM" log --level error "$msg"
    else
        echo -e "${ERROR}[X]${NC} ${msg}"
    fi
}

INSTALL_STAGE_TOTAL=3
INSTALL_STAGE_CURRENT=0

ui_section() {
    local title="$1"
    if [[ -n "$GUM" ]]; then
        "$GUM" style --bold --foreground "#FF6B4A" --padding "1 0" "$title"
    else
        echo ""
        echo -e "${ACCENT}${BOLD}${title}${NC}"
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
        echo -e "${MUTED}${key}:${NC} ${value}"
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

show_install_plan() {
    local detected_checkout="$1"

    ui_section "Install plan"
    ui_kv "OS" "$OS"
    ui_kv "Install method" "$INSTALL_METHOD"
    ui_kv "Requested version" "$COMIS_VERSION"
    if [[ "$USE_BETA" == "1" ]]; then
        ui_kv "Beta channel" "enabled"
    fi
    if [[ "$INSTALL_METHOD" == "git" ]]; then
        ui_kv "Git directory" "$GIT_DIR"
        ui_kv "Git update" "$GIT_UPDATE"
    fi
    if [[ -n "$detected_checkout" ]]; then
        ui_kv "Detected checkout" "$detected_checkout"
    fi
    if should_create_dedicated_user; then
        ui_kv "Run as user" "$COMIS_USER"
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
        ui_kv "Dry run" "yes"
    fi
    if [[ "$NO_INIT" == "1" ]]; then
        ui_kv "Init" "skipped"
    fi
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
        echo -e "${SUCCESS}${BOLD}${msg}${NC}"
    fi
}

is_shell_function() {
    local name="${1:-}"
    [[ -n "$name" ]] && declare -F "$name" >/dev/null 2>&1
}

is_gum_raw_mode_failure() {
    local err_log="$1"
    [[ -s "$err_log" ]] || return 1
    grep -Eiq 'setrawmode' "$err_log"
}

run_with_spinner() {
    local title="$1"
    shift

    if [[ -n "$GUM" ]] && gum_is_tty && ! is_shell_function "${1:-}"; then
        local gum_err
        gum_err="$(mktempfile)"
        if "$GUM" spin --spinner dot --title "$title" -- "$@" 2>"$gum_err"; then
            return 0
        fi
        local gum_status=$?
        if is_gum_raw_mode_failure "$gum_err"; then
            GUM=""
            GUM_STATUS="skipped"
            GUM_REASON="gum raw mode unavailable"
            ui_warn "Spinner unavailable in this terminal; continuing without spinner"
            "$@"
            return $?
        fi
        if [[ -s "$gum_err" ]]; then
            cat "$gum_err" >&2
        fi
        return "$gum_status"
    fi

    "$@"
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
        # Show progress dots so the user knows something is happening
        # during long operations (apt install, npm install, etc.)
        echo -n "  ${title} " # no newline — dots append on same line
        "$@" >"$log" 2>&1 &
        local cmd_pid=$!
        while kill -0 "$cmd_pid" 2>/dev/null; do
            echo -n "."
            sleep 2
        done
        wait "$cmd_pid"
        local rc=$?
        if [[ "$rc" -eq 0 ]]; then
            echo " done"
            return 0
        fi
        echo " FAILED"
    fi

    ui_error "${title} failed - re-run with --verbose for details"
    if [[ -s "$log" ]]; then
        tail -n 80 "$log" >&2 || true
    fi
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

install_build_tools_linux() {
    require_sudo

    if command -v apt-get &> /dev/null; then
        if is_root; then
            run_quiet_step "Updating package index" apt-get update -qq
            run_quiet_step "Installing build tools" apt-get install -y -qq build-essential python3 make g++ cmake
        else
            run_quiet_step "Updating package index" sudo apt-get update -qq
            run_quiet_step "Installing build tools" sudo apt-get install -y -qq build-essential python3 make g++ cmake
        fi
        return 0
    fi

    if command -v dnf &> /dev/null; then
        if is_root; then
            run_quiet_step "Installing build tools" dnf install -y -q gcc gcc-c++ make cmake python3
        else
            run_quiet_step "Installing build tools" sudo dnf install -y -q gcc gcc-c++ make cmake python3
        fi
        return 0
    fi

    if command -v yum &> /dev/null; then
        if is_root; then
            run_quiet_step "Installing build tools" yum install -y -q gcc gcc-c++ make cmake python3
        else
            run_quiet_step "Installing build tools" sudo yum install -y -q gcc gcc-c++ make cmake python3
        fi
        return 0
    fi

    if command -v apk &> /dev/null; then
        if is_root; then
            run_quiet_step "Installing build tools" apk add --no-cache build-base python3 cmake
        else
            run_quiet_step "Installing build tools" sudo apk add --no-cache build-base python3 cmake
        fi
        return 0
    fi

    ui_warn "Could not detect package manager for auto-installing build tools"
    return 1
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

    "${cmd[@]}" >"$log" 2>&1
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
    return 0
}

TAGLINE="$DEFAULT_TAGLINE"

NO_INIT=${COMIS_NO_INIT:-0}
NO_PROMPT=${COMIS_NO_PROMPT:-0}
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

print_usage() {
    cat <<EOF
Comis installer (macOS + Linux)

Usage:
  curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh | bash -s -- [options]

Options:
  --install-method, --method npm|git   Install via npm (default) or from a git checkout
  --npm                               Shortcut for --install-method npm
  --git, --github                     Shortcut for --install-method git
  --version <version|dist-tag>         npm install: version (default: latest)
  --beta                               Use beta if available, else latest
  --git-dir, --dir <path>             Checkout directory (default: ~/comis)
  --no-git-update                      Skip git pull for existing checkout
  --user <name>                          Dedicated Linux user (default: comis, created if root)
  --no-user                              Install as current user even when root (skip user creation)
  --no-init                            Skip interactive init (non-interactive)
  --no-prompt                           Disable prompts (required in CI/automation)
  --dry-run                             Print what would happen (no changes)
  --verbose                             Print debug output (set -x, npm verbose)
  --help, -h                            Show this help

Environment variables:
  COMIS_INSTALL_METHOD=git|npm
  COMIS_VERSION=latest|next|<semver>
  COMIS_BETA=0|1
  COMIS_GIT_DIR=...
  COMIS_GIT_UPDATE=0|1
  COMIS_USER=comis                    Default user for Linux root installs
  COMIS_NO_PROMPT=1
  COMIS_DRY_RUN=1
  COMIS_NO_INIT=1
  COMIS_VERBOSE=1
  COMIS_NPM_LOGLEVEL=error|warn|notice  Default: error (hide npm deprecation noise)
  SHARP_IGNORE_GLOBAL_LIBVIPS=0|1    Default: 1 (avoid sharp building against global libvips)

Examples:
  curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh | bash
  curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh | bash -s -- --no-init
  curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh | bash -s -- --install-method git --no-init
EOF
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
                INSTALL_METHOD="$2"
                shift 2
                ;;
            --version)
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
                GIT_DIR="$2"
                shift 2
                ;;
            --no-git-update)
                GIT_UPDATE=0
                shift
                ;;
            --user)
                COMIS_USER="$2"
                shift 2
                ;;
            --no-user)
                COMIS_REEXEC=1
                shift
                ;;
            *)
                shift
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
    echo "  curl -fsSL https://comis.ai/install.sh | bash"
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
            run_quiet_step "Installing Homebrew" run_remote_bash "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"

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

node_major_version() {
    if ! command -v node &> /dev/null; then
        return 1
    fi
    local version major
    version="$(node -v 2>/dev/null || true)"
    major="${version#v}"
    major="${major%%.*}"
    if [[ "$major" =~ ^[0-9]+$ ]]; then
        echo "$major"
        return 0
    fi
    return 1
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

    local major=""
    major="$(node_major_version || true)"
    if [[ -n "$major" && "$major" -ge 22 ]]; then
        return 0
    fi

    local active_path active_version
    active_path="$(command -v node 2>/dev/null || echo "not found")"
    active_version="$(node -v 2>/dev/null || echo "missing")"

    ui_error "Node.js v22 was installed but this shell is using ${active_version} (${active_path})"
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
        NODE_VERSION="$(node_major_version || true)"
        if [[ -n "$NODE_VERSION" && "$NODE_VERSION" -ge 22 ]]; then
            ui_success "Node.js v$(node -v | cut -d'v' -f2) found"
            print_active_node_paths || true
            return 0
        else
            if [[ -n "$NODE_VERSION" ]]; then
                ui_info "Node.js $(node -v) found, upgrading to v22+"
            else
                ui_info "Node.js found but version could not be parsed; reinstalling v22+"
            fi
            return 1
        fi
    else
        ui_info "Node.js not found, installing it now"
        return 1
    fi
}

node_major_from_binary() {
    local node_bin="$1"
    if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
        return 1
    fi
    "$node_bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

node_is_supported_binary() {
    local node_bin="$1"
    local major=""
    major="$(node_major_from_binary "$node_bin")"
    if [[ ! "$major" =~ ^[0-9]+$ ]]; then
        return 1
    fi
    [[ "$major" -ge 22 ]]
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
    ui_warn "Configured comis shim at ${shim_path} for Node $("$node_bin" -v 2>/dev/null || echo '22+')"
    return 0
}

install_node_standalone() {
    # Download Node.js directly from nodejs.org - no sudo, no package manager.
    # Installs to ~/.comis/node/ and symlinks into ~/.local/bin/.
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

    local index_url="https://nodejs.org/dist/latest-v22.x/"
    local tarball_name=""
    local index_tmp
    index_tmp="$(mktempfile)"
    if ! download_file "$index_url" "$index_tmp"; then
        ui_warn "Could not fetch Node.js release index"
        return 1
    fi

    tarball_name="$(grep -oE "node-v22\.[0-9]+\.[0-9]+-${node_os}-${node_arch}\.tar\.xz" "$index_tmp" | head -1 || true)"
    if [[ -z "$tarball_name" ]]; then
        tarball_name="$(grep -oE "node-v22\.[0-9]+\.[0-9]+-${node_os}-${node_arch}\.tar\.gz" "$index_tmp" | head -1 || true)"
    fi
    if [[ -z "$tarball_name" ]]; then
        ui_warn "Could not find Node.js 22 binary for ${node_os}-${node_arch}"
        return 1
    fi

    local download_url="${index_url}${tarball_name}"
    local tmp_dir
    tmp_dir="$(mktemp -d)"
    TMPFILES+=("$tmp_dir")

    ui_info "Downloading ${tarball_name}..."
    if ! download_file "$download_url" "$tmp_dir/$tarball_name"; then
        ui_warn "Node.js download failed"
        return 1
    fi

    if [[ "$tarball_name" == *.tar.xz ]]; then
        tar xf "$tmp_dir/$tarball_name" -C "$tmp_dir" >/dev/null 2>&1
    else
        tar xzf "$tmp_dir/$tarball_name" -C "$tmp_dir" >/dev/null 2>&1
    fi

    local extracted_dir=""
    extracted_dir="$(find "$tmp_dir" -maxdepth 1 -type d -name 'node-v*' 2>/dev/null | head -1 || true)"
    if [[ -z "$extracted_dir" || ! -d "$extracted_dir" ]]; then
        ui_warn "Node.js extraction failed"
        return 1
    fi

    local comis_node_dir="$HOME/.comis/node"
    rm -rf "$comis_node_dir"
    mkdir -p "$HOME/.comis"
    mv "$extracted_dir" "$comis_node_dir"

    ensure_user_local_bin_on_path
    ln -sf "$comis_node_dir/bin/node" "$HOME/.local/bin/node"
    ln -sf "$comis_node_dir/bin/npm" "$HOME/.local/bin/npm"
    ln -sf "$comis_node_dir/bin/npx" "$HOME/.local/bin/npx"
    export PATH="$comis_node_dir/bin:$PATH"
    refresh_shell_command_cache

    local installed_ver=""
    installed_ver="$("$comis_node_dir/bin/node" --version 2>/dev/null || true)"
    ui_success "Node.js ${installed_ver} installed to ~/.comis/node/ (no sudo required)"
    return 0
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
                    echo "Please install Node.js 22+ manually: https://nodejs.org"
                    exit 1
                fi
            fi
        else
            ui_warn "Homebrew install failed; trying standalone download from nodejs.org"
            if ! install_node_standalone; then
                ui_error "Could not install Node.js"
                echo "Please install Node.js 22+ manually: https://nodejs.org"
                exit 1
            fi
        fi
    elif [[ "$OS" == "linux" ]]; then
        local nodesource_ok=false

        # Try NodeSource first (system-managed, gets security updates via apt/dnf).
        # Both build tools and NodeSource require root/sudo.
        if is_root || (command -v sudo &> /dev/null && sudo -n true 2>/dev/null); then
            ui_info "Installing Linux build tools (make/g++/cmake/python3)"
            if install_build_tools_linux; then
                ui_success "Build tools installed"
            else
                ui_warn "Continuing without auto-installing build tools"
            fi

            ui_info "Installing Node.js via NodeSource"
            require_sudo
            if command -v apt-get &> /dev/null; then
                local tmp
                tmp="$(mktempfile)"
                if download_file "https://deb.nodesource.com/setup_22.x" "$tmp"; then
                    if is_root; then
                        run_quiet_step "Configuring NodeSource repository" bash "$tmp" && \
                        run_quiet_step "Installing Node.js" apt-get install -y -qq nodejs && \
                        nodesource_ok=true
                    else
                        run_quiet_step "Configuring NodeSource repository" sudo -E bash "$tmp" && \
                        run_quiet_step "Installing Node.js" sudo apt-get install -y -qq nodejs && \
                        nodesource_ok=true
                    fi
                fi
            elif command -v dnf &> /dev/null; then
                local tmp
                tmp="$(mktempfile)"
                if download_file "https://rpm.nodesource.com/setup_22.x" "$tmp"; then
                    if is_root; then
                        run_quiet_step "Configuring NodeSource repository" bash "$tmp" && \
                        run_quiet_step "Installing Node.js" dnf install -y -q nodejs && \
                        nodesource_ok=true
                    else
                        run_quiet_step "Configuring NodeSource repository" sudo bash "$tmp" && \
                        run_quiet_step "Installing Node.js" sudo dnf install -y -q nodejs && \
                        nodesource_ok=true
                    fi
                fi
            elif command -v yum &> /dev/null; then
                local tmp
                tmp="$(mktempfile)"
                if download_file "https://rpm.nodesource.com/setup_22.x" "$tmp"; then
                    if is_root; then
                        run_quiet_step "Configuring NodeSource repository" bash "$tmp" && \
                        run_quiet_step "Installing Node.js" yum install -y -q nodejs && \
                        nodesource_ok=true
                    else
                        run_quiet_step "Configuring NodeSource repository" sudo bash "$tmp" && \
                        run_quiet_step "Installing Node.js" sudo yum install -y -q nodejs && \
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
                echo "Please install Node.js 22+ manually: https://nodejs.org"
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
        local major="${current_version#v}"
        major="${major%%.*}"

        if [[ -n "$major" && "$major" -lt 22 ]]; then
            ui_warn ""
            ui_warn "NVM detected with old default Node version"
            ui_warn "   Your shell is using NVM's Node ${current_version}, but Comis requires Node 22+"
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

COMIS_USER="${COMIS_USER:-comis}"
COMIS_REEXEC="${COMIS_REEXEC:-0}"

should_create_dedicated_user() {
    # Only on Linux, only when running as root, and not already re-execed
    [[ "$OS" == "linux" ]] && is_root && [[ "$COMIS_REEXEC" != "1" ]]
}

comis_user_exists() {
    id "$COMIS_USER" &>/dev/null
}

create_comis_user() {
    if comis_user_exists; then
        ui_success "User '$COMIS_USER' already exists"
        return 0
    fi

    ui_info "Creating dedicated system user '$COMIS_USER'"
    useradd --system --create-home --shell /bin/bash \
        --comment "Comis AI agent platform" "$COMIS_USER"
    ui_success "User '$COMIS_USER' created (home: $(eval echo "~$COMIS_USER"))"
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

    ui_success "System dependencies ready"
}

reexec_as_comis_user() {
    local comis_home
    comis_home="$(eval echo "~$COMIS_USER")"

    # Forward relevant args and env to the re-exec
    local -a forwarded_args=()
    [[ "$NO_INIT" == "1" ]] && forwarded_args+=(--no-init)
    [[ "$NO_PROMPT" == "1" ]] && forwarded_args+=(--no-prompt)
    [[ "$DRY_RUN" == "1" ]] && forwarded_args+=(--dry-run)
    [[ "$VERBOSE" == "1" ]] && forwarded_args+=(--verbose)
    [[ -n "$INSTALL_METHOD" ]] && forwarded_args+=(--install-method "$INSTALL_METHOD")
    [[ "$COMIS_VERSION" != "latest" ]] && forwarded_args+=(--version "$COMIS_VERSION")
    [[ "$USE_BETA" == "1" ]] && forwarded_args+=(--beta)

    # Copy the install script to a location the comis user can read
    local script_copy="${comis_home}/.comis-install.sh"
    if [[ -f "$0" ]]; then
        cp "$0" "$script_copy"
    else
        # Piped via curl — save stdin copy
        local self_tmp
        self_tmp="$(mktemp)"
        TMPFILES+=("$self_tmp")
        # The script is already running, so we need the original file.
        # Fall back to re-downloading if we can't find ourselves.
        if [[ -f "/proc/self/fd/255" ]]; then
            cp /proc/self/fd/255 "$script_copy" 2>/dev/null || true
        fi
        if [[ ! -s "$script_copy" ]]; then
            download_file "https://comis.ai/install.sh" "$script_copy"
        fi
    fi
    chmod +x "$script_copy"
    chown "$COMIS_USER:$COMIS_USER" "$script_copy"

    ui_info "Handing off to user '$COMIS_USER'"
    echo ""

    # Re-exec as the comis user with COMIS_REEXEC=1 to skip the handoff loop
    su - "$COMIS_USER" -c "COMIS_REEXEC=1 bash '$script_copy' ${forwarded_args[*]}"
    local rc=$?

    rm -f "$script_copy" 2>/dev/null || true

    if [[ "$rc" -eq 0 ]]; then
        echo ""
        ui_section "Run commands as the comis user"
        echo "  su - $COMIS_USER"
        echo "  comis init"
        echo "  comis daemon start"
    fi

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
                run_quiet_step "Updating package index" apt-get update -qq
                run_quiet_step "Installing Git" apt-get install -y -qq git
            else
                run_quiet_step "Updating package index" sudo apt-get update -qq
                run_quiet_step "Installing Git" sudo apt-get install -y -qq git
            fi
        elif command -v dnf &> /dev/null; then
            if is_root; then
                run_quiet_step "Installing Git" dnf install -y -q git
            else
                run_quiet_step "Installing Git" sudo dnf install -y -q git
            fi
        elif command -v yum &> /dev/null; then
            if is_root; then
                run_quiet_step "Installing Git" yum install -y -q git
            else
                run_quiet_step "Installing Git" sudo yum install -y -q git
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
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
        if [[ -f "$rc" ]] && ! grep -q ".npm-global" "$rc"; then
            echo "$path_line" >> "$rc"
        fi
    done

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
        if [[ -f "$rc" ]] && ! grep -q ".local/bin" "$rc"; then
            echo "$path_line" >> "$rc"
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
            run_quiet_step "Updating repository" git -C "$repo_dir" pull --rebase || true
        else
            # Auto-stash local changes, pull, then restore
            local stash_name="comis-install-autostash-$(date -u +%Y%m%d-%H%M%S)"
            ui_info "Local changes detected; stashing before update"
            git -C "$repo_dir" stash push --include-untracked -m "$stash_name" >/dev/null 2>&1 || true
            local stash_ref=""
            stash_ref="$(git -C "$repo_dir" rev-parse --verify refs/stash 2>/dev/null || true)"

            run_quiet_step "Updating repository" git -C "$repo_dir" pull --rebase || true

            if [[ -n "$stash_ref" ]]; then
                ui_info "Restoring stashed local changes"
                if git -C "$repo_dir" stash pop >/dev/null 2>&1; then
                    ui_success "Local changes restored"
                else
                    ui_warn "Could not auto-restore local changes (conflict?)"
                    ui_info "Your changes are preserved in: git -C ${repo_dir} stash list"
                fi
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
    local install_spec=""
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

# Main installation flow
main() {
    if [[ "$HELP" == "1" ]]; then
        print_usage
        return 0
    fi

    bootstrap_gum_temp || true
    print_installer_banner
    print_gum_status
    detect_os_or_die

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

    show_install_plan "$detected_checkout"

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_success "Dry run complete (no changes made)"
        return 0
    fi

    # On Linux as root: install system deps, create dedicated user, re-exec
    if should_create_dedicated_user; then
        install_system_deps_as_root
        create_comis_user
        reexec_as_comis_user
        return $?
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
        ui_error "Node.js v22+ is required but could not be activated on PATH"
        echo "Detected node: $(command -v node 2>/dev/null || echo '(not found)')"
        echo "Current version: $(node -v 2>/dev/null || echo 'unknown')"
        echo "Install Node.js 22+ manually: https://nodejs.org"
        exit 1
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

    # Restart daemon if already running
    restart_daemon_if_running

    # Run doctor on upgrades and git installs
    if [[ "$is_upgrade" == "true" || "$INSTALL_METHOD" == "git" ]]; then
        run_doctor
    fi

    local installed_version
    installed_version=$(resolve_comis_version)

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

    # Restart daemon if running after upgrade
    if command -v comis &> /dev/null; then
        local comis_bin="${COMIS_BIN:-}"
        if [[ -z "$comis_bin" ]]; then
            comis_bin="$(resolve_comis_bin || true)"
        fi
        if [[ -n "$comis_bin" ]] && is_daemon_running "$comis_bin"; then
            if [[ "$DRY_RUN" == "1" ]]; then
                ui_info "Daemon detected; would restart (comis daemon stop && comis daemon start)"
            else
                ui_info "Daemon detected; restarting"
                if "$comis_bin" daemon stop >/dev/null 2>&1 && "$comis_bin" daemon start >/dev/null 2>&1; then
                    ui_success "Daemon restarted"
                else
                    ui_warn "Daemon restart failed; try: comis daemon stop && comis daemon start"
                fi
            fi
        fi
    fi

    show_footer_links
}

if [[ "${COMIS_INSTALL_SH_NO_RUN:-0}" != "1" ]]; then
    parse_args "$@"
    configure_verbose
    main
fi
