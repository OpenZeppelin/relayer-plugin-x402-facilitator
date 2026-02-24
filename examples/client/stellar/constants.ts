/**
 * CAIP-2 network identifiers for Stellar (V2)
 */
export const STELLAR_PUBNET_CAIP2 = "stellar:pubnet";
export const STELLAR_TESTNET_CAIP2 = "stellar:testnet";
export const STELLAR_WILDCARD_CAIP2 = "stellar:*";

export const STELLAR_NETWORK_TO_PASSPHRASE: ReadonlyMap<string, string> = new Map([
  [STELLAR_PUBNET_CAIP2, "Public Global Stellar Network ; September 2015"],
  [STELLAR_TESTNET_CAIP2, "Test SDF Network ; September 2015"],
]);

export const STELLAR_ASSET_ADDRESS_REGEX = /^(?:[C][ABCD][A-Z2-7]{54})$/;
