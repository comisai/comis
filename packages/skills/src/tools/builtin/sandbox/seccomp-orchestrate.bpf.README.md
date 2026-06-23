<!-- SPDX-License-Identifier: Apache-2.0 -->

# `seccomp-orchestrate.bpf` — the bwrap seccomp profile (JAIL-01)

bwrap `--seccomp N` takes an **open file descriptor to raw BPF bytecode** — NOT a
JSON profile name/path (that is Docker/runc). `seccomp-profile.ts`
(`loadSeccompProfileFd()`) `open()`s the committed blob beside it and passes the
inheritable fd to bwrap. The blob is a **precompiled data artifact**, generated
**offline on Linux** via libseccomp (`scmp_export_bpf`) — never at runtime (no
runtime libseccomp dependency; macOS cannot build it at all).

## Why a committed blob (not runtime generation)

- No runtime libseccomp dependency in the daemon.
- Deterministic, auditable bytes (the filter is reviewed once, committed once).
- The blob rides the normal `tsc` + `copy-sandbox-assets.mjs` build into `dist/`
  (and therefore the published tarball + the Docker image) — no special COPY.

## Generating the blob (one-time, on Linux / the VPS)

Default-deny is impractical for a general interpreter jail (Node/Python/Ruby need
a wide syscall set), so the filter is an **allow-most, deny-dangerous** profile —
it denies the CVE-2024-1086-class and keystroke/escape surface while allowing the
common syscalls interpreters need. Example generator (compile + run on Linux with
`libseccomp-dev` installed):

```c
// gen-seccomp.c — cc gen-seccomp.c -lseccomp -o gen-seccomp && ./gen-seccomp > seccomp-orchestrate.bpf
#include <seccomp.h>
#include <unistd.h>
int main(void) {
  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW); // allow-most baseline
  // Deny the dangerous surface (defense-in-depth on top of --new-session):
  const int deny[] = {
    SCMP_SYS(add_key), SCMP_SYS(request_key), SCMP_SYS(keyctl),       // keyring
    SCMP_SYS(ptrace),                                                 // anti-debug/escape
    SCMP_SYS(perf_event_open),                                        // CVE-2024-1086 class
    SCMP_SYS(bpf),                                                    // no nested BPF
    SCMP_SYS(userfaultfd),                                            // exploit primitive
    SCMP_SYS(kexec_load), SCMP_SYS(kexec_file_load),
    SCMP_SYS(init_module), SCMP_SYS(finit_module), SCMP_SYS(delete_module),
  };
  for (unsigned i = 0; i < sizeof(deny)/sizeof(deny[0]); i++)
    seccomp_rule_add(ctx, SCMP_ACT_ERRNO(1 /* EPERM */), deny[i], 0);
  seccomp_export_bpf(ctx, STDOUT_FILENO); // raw BPF → the blob bwrap --seccomp reads
  seccomp_release(ctx);
  return 0;
}
```

Commit the produced `seccomp-orchestrate.bpf` (binary) into THIS directory. The
build copies it into `dist/` and `loadSeccompProfileFd()` starts returning its fd.

## Proof gate

`bwrap-hardening.linux.test.ts` is the gate that PROVES the blob blocks the
dangerous syscalls (TIOCSTI etc.) on the VPS (`pnpm validate:full`). Until the
blob is committed, `loadSeccompProfileFd()` returns `null`, `buildArgs` omits
`--seccomp`, and the OTHER §4.7 controls (`--new-session`, `--die-with-parent`,
`--unshare-net`, the bind-mount validator) still apply.
