/**
 * Asset identity.
 *
 * Stellar assets are identified by a code *and* an issuer. Two assets sharing a
 * code but not an issuer are entirely different assets — a lookalike `USDC`
 * from an arbitrary issuer is not Circle's USDC. Comparing on code alone is a
 * security bug, so this module only ever exposes the canonical form
 * `CODE:ISSUER` (or the sentinel `native` for XLM) and there is deliberately no
 * accessor that returns a bare code for comparison.
 *
 * A third form, `contract:C...`, represents a SEP-41 token that is not a
 * Stellar Asset Contract (#22). It has its own decimals and no classic issuer.
 * A SAC (Stellar Asset Contract) is the same asset as its classic `CODE:ISSUER`
 * form; the two compare equal through the SAC equality helpers below.
 */

/** Canonical asset identifier: `native`, `CODE:ISSUER`, or `contract:C...`. */
export type AssetId = string & { readonly __brand: "AssetId" };

/** The native asset (XLM). */
export const NATIVE: AssetId = "native" as AssetId;

/** Stellar asset codes are 1-12 alphanumeric characters. */
const CODE_RE = /^[A-Za-z0-9]{1,12}$/;
/** Ed25519 public keys (`G...`) are 56 base32 characters. */
const ISSUER_RE = /^G[A-Z2-7]{55}$/;
/** Stellar contract addresses (`C...`) are 56 base32 characters. */
const CONTRACT_RE = /^C[A-Z2-7]{55}$/;

/** Prefix used in the canonical string form for contract tokens. */
const CONTRACT_PREFIX = "contract:";

export class InvalidAssetError extends Error {
  public readonly code = "INVALID_ASSET";
  constructor(message: string) {
    super(message);
    this.name = "InvalidAssetError";
  }
}

/** Build a canonical `AssetId` from a code and issuer. */
export function asset(code: string, issuer: string): AssetId {
  if (!CODE_RE.test(code)) {
    throw new InvalidAssetError(
      `Invalid asset code ${JSON.stringify(code)}: expected 1-12 alphanumeric characters.`,
    );
  }
  if (!ISSUER_RE.test(issuer)) {
    throw new InvalidAssetError(
      `Invalid asset issuer ${JSON.stringify(issuer)}: expected a 56-character G... address.`,
    );
  }
  return `${code}:${issuer}` as AssetId;
}

/**
 * Build a canonical `AssetId` for a SEP-41 contract token (#22).
 * The text form is `contract:C...` so it sorts and compares unambiguously
 * and can never be confused with a `CODE:ISSUER` whose code happens to be
 * "contract".
 */
export function contractAsset(contractId: string): AssetId {
  if (!CONTRACT_RE.test(contractId)) {
    throw new InvalidAssetError(
      `Invalid contract id ${JSON.stringify(contractId)}: expected a 56-character C... address.`,
    );
  }
  return `${CONTRACT_PREFIX}${contractId}` as AssetId;
}

/** True when the asset id represents a SEP-41 contract token. */
export function isContractAsset(id: AssetId): boolean {
  return id.startsWith(CONTRACT_PREFIX);
}

/** Extract the contract address from a contract asset id, or null for other forms. */
export function contractIdOf(id: AssetId): string | null {
  if (!isContractAsset(id)) return null;
  return id.slice(CONTRACT_PREFIX.length);
}

/** Parse a canonical asset id, round-tripping `asset()`, `contractAsset()` and `NATIVE`. */
export function parseAsset(id: string): AssetId {
  if (id === NATIVE) return NATIVE;
  // contract:C... form (#22)
  if (id.startsWith(CONTRACT_PREFIX)) {
    return contractAsset(id.slice(CONTRACT_PREFIX.length));
  }
  const idx = id.indexOf(":");
  if (idx === -1) {
    throw new InvalidAssetError(
      `Invalid asset id ${JSON.stringify(id)}: expected "native", "CODE:ISSUER", or "contract:C...".`,
    );
  }
  return asset(id.slice(0, idx), id.slice(idx + 1));
}

export function isNative(id: AssetId): boolean {
  return id === NATIVE;
}

/** The issuer of a non-native classic asset, or `null` for native and contract tokens. */
export function issuerOf(id: AssetId): string | null {
  if (id === NATIVE) return null;
  if (isContractAsset(id)) return null;
  return id.slice(id.indexOf(":") + 1);
}

/**
 * True when two assets share a code but have different issuers.
 *
 * This is the lookalike-asset case. It exists so callers can raise a
 * `WRONG_ASSET` exception that explains *why* two same-looking assets did not
 * match, rather than reporting a bare inequality.
 *
 * For contract tokens: a contract token whose symbol() happens to equal a
 * classic asset code is NOT the same asset and is NOT considered a lookalike
 * here — the lookalike rule only applies between two classic CODE:ISSUER assets
 * (#22). The check returns false when either side is a contract token or native.
 */
export function isSameCodeDifferentIssuer(a: AssetId, b: AssetId): boolean {
  if (a === b) return false;
  if (a === NATIVE || b === NATIVE) return false;
  if (isContractAsset(a) || isContractAsset(b)) return false;
  return a.slice(0, a.indexOf(":")) === b.slice(0, b.indexOf(":"));
}
