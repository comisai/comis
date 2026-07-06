// SPDX-License-Identifier: Apache-2.0
/**
 * Encrypted-attachment codec + a bounded encrypted-file cache for the Matrix
 * media path — pure GLUE around the audited WASM engine.
 *
 * The blob cryptography (AES-CTR encryption plus a SHA-256 integrity hash) is
 * delegated to `@matrix-org/matrix-sdk-crypto-wasm`; it is NEVER hand-rolled here.
 * A tampered ciphertext therefore fails closed inside the codec (the hash check
 * throws) rather than returning partial plaintext.
 *
 * The WASM engine is loaded LAZILY through a dynamic import on first codec use, so
 * a plaintext-only install — one that never sends or receives an encrypted
 * attachment — never pulls the WASM. The import lives only inside the codec
 * functions, never at module top level.
 *
 * The cache exists because the encrypted-file keys (the JWK key, iv and hashes)
 * cannot ride the normalized attachment: they are the decryption secret and the
 * attachment schema is strict. The inbound mapper stores them keyed by mxc when an
 * encrypted media event arrives; the resolver reads them back to decrypt. A miss
 * is a clean `undefined` for the caller to turn into a fail-closed error.
 *
 * @module
 */

/** The dynamic-import type of the crypto engine — a compile-time reference only. */
type CryptoWasmModule = typeof import("@matrix-org/matrix-sdk-crypto-wasm");

/**
 * The Matrix encrypted-file wire shape as it appears on `content.file` of an
 * encrypted media event. Defined structurally so this module carries no
 * dependency on the SDK's own type. The codec consumes it MINUS `url`.
 */
export interface EncryptedFileLike {
  /** `mxc://` reference — present on the event; STRIPPED before the codec sees it. */
  url: string;
  /** The JWK symmetric key. */
  key: { alg: string; key_ops: string[]; kty: string; k: string; ext: boolean };
  /** Base64 initialisation vector. */
  iv: string;
  /** Content hashes; `sha256` is required and integrity-checked on decrypt. */
  hashes: { [alg: string]: string };
  /** Encrypted-attachment version tag (`"v2"`). */
  v: string;
}

/**
 * The output of {@link encryptAttachment}: the ciphertext plus the media-encryption
 * info in the encrypted-file wire shape, already minus `url` (the caller adds the
 * `url` after uploading the ciphertext and gaining an mxc).
 */
export interface EncryptedAttachmentParts {
  ciphertext: Buffer;
  info: Omit<EncryptedFileLike, "url">;
}

/**
 * Cached engine load: the dynamic import and its `initAsync` warm-up run exactly
 * once, and concurrent first callers await the same promise (idempotent).
 */
let codecPromise: Promise<CryptoWasmModule> | undefined;

async function loadCodec(): Promise<CryptoWasmModule> {
  codecPromise ??= (async () => {
    const mod = await import("@matrix-org/matrix-sdk-crypto-wasm");
    // Warm the WASM engine if the module exposes an async initializer (idempotent).
    if (typeof mod.initAsync === "function") await mod.initAsync();
    return mod;
  })();
  return codecPromise;
}

/**
 * Encrypt attachment bytes with the WASM codec. Returns the ciphertext and the
 * media-encryption info; the info is already url-less (the codec emits it that
 * way — the caller stitches the mxc `url` on after upload).
 */
export async function encryptAttachment(bytes: Buffer | Uint8Array): Promise<EncryptedAttachmentParts> {
  const { Attachment } = await loadCodec();
  const enc = Attachment.encrypt(new Uint8Array(bytes));
  const info = JSON.parse(enc.mediaEncryptionInfo!) as Omit<EncryptedFileLike, "url">;
  return { ciphertext: Buffer.from(enc.encryptedData), info };
}

/**
 * Decrypt attachment ciphertext against an event's `content.file`. The event shape
 * carries `url`, which the codec rejects, so it is stripped here before the info is
 * handed over. A tampered ciphertext throws on the internal SHA-256 check.
 *
 * `EncryptedAttachment` is single-use — its media-encryption info is consumed by
 * `decrypt` — so a fresh instance is built per call and never reused afterwards.
 */
export async function decryptAttachment(
  ciphertext: Buffer | Uint8Array,
  encFile: EncryptedFileLike,
): Promise<Buffer> {
  const { Attachment, EncryptedAttachment } = await loadCodec();
  const { url: _url, ...mediaInfo } = encFile;
  const attachment = new EncryptedAttachment(new Uint8Array(ciphertext), JSON.stringify(mediaInfo));
  return Buffer.from(Attachment.decrypt(attachment));
}

/**
 * A bounded, insertion-ordered cache of encrypted-file keys keyed by mxc. Once the
 * entry count would exceed `maxEntries`, the oldest entry is evicted before the new
 * one is inserted; re-setting an existing key refreshes its position. A miss
 * returns `undefined`.
 */
export function createEncryptedFileCache(maxEntries = 256): {
  get(mxc: string): EncryptedFileLike | undefined;
  set(mxc: string, file: EncryptedFileLike): void;
} {
  const store = new Map<string, EncryptedFileLike>();
  return {
    get(mxc: string): EncryptedFileLike | undefined {
      return store.get(mxc);
    },
    set(mxc: string, file: EncryptedFileLike): void {
      if (store.has(mxc)) {
        store.delete(mxc); // refresh position so a re-set is treated as newest
      } else if (store.size >= maxEntries) {
        const oldest = store.keys().next().value; // insertion-ordered → first is oldest
        if (oldest !== undefined) store.delete(oldest);
      }
      store.set(mxc, file);
    },
  };
}
