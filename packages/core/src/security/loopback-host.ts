// SPDX-License-Identifier: Apache-2.0
/**
 * Is a listener bind address a LOOPBACK address?
 *
 * A loopback-bound listener has no off-host network exposure, so running it
 * WITHOUT TLS is benign. This is the ONE definition of that posture judgment,
 * shared by every layer that makes it: the gateway's boot log (warn only on a
 * non-loopback plain-HTTP bind), the system `tlsOff` config-posture finding
 * (suppressed on loopback), and the `gateway-exposure` security check (flags
 * only a `0.0.0.0`-without-TLS bind as critical).
 *
 * `gateway.host` defaults to `127.0.0.1`, so a default daemon is loopback
 * (benign by default); only an operator-set non-loopback host opts into the
 * TLS-off posture findings. An absent/unknown host is treated as NON-loopback
 * (conservative — never suppress on doubt).
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (typeof host !== "string") return false;
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h.startsWith("127.");
}
