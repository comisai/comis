# Comis installer — Docker-based integration test results

**Run at:** Fri Apr 17 18:34:10 UTC 2026
**Host:**   Darwin 25.3.0 arm64
**Docker:** Docker version 28.0.1, build 068a01e
**Tarball:** /Users/mosheanconina/Projects/comisai/comis/packages/comis/comisai-1.0.3.tgz


### S1 — Linux+root → systemd system scope

- **Status:** PASS
- **Duration:** 227s

### S2 — Linux non-root → systemd user scope

- **Status:** PASS
- **Duration:** 207s

### S3 — --service none (explicit)

- **Status:** PASS
- **Duration:** 210s

### S6 — Debian without systemd → fallback to none

- **Status:** PASS
- **Duration:** 215s

### S8 — systemd + --no-autostart

- **Status:** PASS
- **Duration:** 231s

### S9 — systemd + --no-service-start

- **Status:** PASS
- **Duration:** 203s

### U2 — uninstall --yes --purge

- **Status:** PASS
- **Duration:** 225s

### U3 — uninstall --yes --remove-user

- **Status:** PASS
- **Duration:** 213s

### U5 — uninstall with nothing installed (no-op)

- **Status:** PASS
- **Duration:** 1s

### U6 — unit hand-edited (refuses to delete)

- **Status:** PASS
- **Duration:** 216s
- **Notes:** unit preserved as expected

### U8 — uninstall --dry-run

- **Status:** PASS
- **Duration:** 236s

### U10 — legacy direct-spawn cleanup

- **Status:** PASS
- **Duration:** 197s

### E1 — idempotent install (run twice)

- **Status:** PASS
- **Duration:** 344s
- **Notes:** checksum stable across runs

### E3 — nvm-style node rejected for service mode

- **Status:** PASS
- **Duration:** 228s
- **Notes:** rejected as expected (installer_rc=0, treated as warning)

### E6 — --tarball nonexistent path errors cleanly

- **Status:** PASS
- **Duration:** 60s

### E7 — --service bogus rejected

- **Status:** PASS
- **Duration:** 0s

### E8 — --dry-run on fresh system (no changes)

- **Status:** PASS
- **Duration:** 1s

## Summary

| Metric | Count |
| --- | --- |
| Total | 17 |
| Passed | 17 |
| Failed | 0 |
