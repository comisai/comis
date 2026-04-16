/**
 * Credential validator factory: structural pattern for platform credential validation.
 *
 * Each platform provides a CredentialDescriptor with:
 * - platform name (for error messages)
 * - input validation (sync, returns error string or undefined)
 * - API call (async, returns Result)
 *
 * The factory wraps these into a standard validate function that checks inputs first,
 * then delegates to the platform-specific API call.
 *
 * @module
 */
import { err, type Result } from "@comis/shared";

export interface CredentialDescriptor<TOpts, TInfo> {
  readonly platform: string;
  readonly validateInputs: (opts: TOpts) => string | undefined;
  readonly callApi: (opts: TOpts) => Promise<Result<TInfo, Error>>;
}

export function createCredentialValidator<TOpts, TInfo>(
  descriptor: CredentialDescriptor<TOpts, TInfo>,
): (opts: TOpts) => Promise<Result<TInfo, Error>> {
  return async (opts: TOpts) => {
    const inputError = descriptor.validateInputs(opts);
    if (inputError) {
      return err(new Error(`Invalid ${descriptor.platform} credentials: ${inputError}`));
    }
    return descriptor.callApi(opts);
  };
}
