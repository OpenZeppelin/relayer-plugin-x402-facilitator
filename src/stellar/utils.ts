import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";

/**
 * Shared utility functions for Stellar payment processing
 */
import { ScVal } from "@openzeppelin/relayer-sdk";

/**
 * Gets the network passphrase for a given network
 */
export function getNetworkPassphrase(network: string): string {
  const networkMap: Record<string, string> = {
    "stellar:pubnet": "Public Global Stellar Network ; September 2015",
    "stellar:testnet": "Test SDF Network ; September 2015",
    mainnet: "Public Global Stellar Network ; September 2015",
    testnet: "Test SDF Network ; September 2015",
  };

  return (
    networkMap[network] ||
    networkMap[network.toLowerCase()] ||
    "Test SDF Network ; September 2015"
  );
}

/**
 * Maps relayer network name to Stellar network format
 */
export function mapRelayerNetworkToStellar(relayerNetwork: string): string {
  return relayerNetwork === "testnet" ? "stellar:testnet" : "stellar";
}

/**
 * Normalizes network identifier to handle both legacy and CAIP-2 formats
 */
export function normalizeNetwork(network: string): string {
  return network;
}

/**
 * Checks if two networks match, handling CAIP-2 and legacy formats
 */
export function networksMatch(network1: string, network2: string): boolean {
  return normalizeNetwork(network1) === normalizeNetwork(network2);
}

/**
 * Converts an ScVal to the JSON format expected by the relayer API.
 * Inspects the XDR type to determine the correct JSON representation.
 */
export function scValToJsonArg(scVal: xdr.ScVal): ScVal {
  const scValType = scVal.switch().name;

  switch (scValType) {
    case "scvAddress": {
      const address = Address.fromScVal(scVal).toString();
      return { address };
    }
    case "scvI128": {
      const i128 = scVal.i128();
      return {
        i128: {
          hi: i128.hi().toString(),
          lo: i128.lo().toString(),
        },
      };
    }
    case "scvU128": {
      const u128 = scVal.u128();
      return {
        u128: {
          hi: u128.hi().toString(),
          lo: u128.lo().toString(),
        },
      };
    }
    case "scvI64":
      return { i64: scVal.i64().toString() };
    case "scvU64":
      return { u64: scVal.u64().toString() };
    case "scvI32":
      return { i32: scVal.i32() };
    case "scvU32":
      return { u32: scVal.u32() };
    case "scvBool":
      return { bool: scVal.b() };
    case "scvString":
      return { string: scVal.str().toString() };
    case "scvSymbol":
      return { symbol: scVal.sym().toString() };
    case "scvBytes":
      return { bytes: scVal.bytes().toString("hex") };
    case "scvVec": {
      const vec = scVal.vec();
      return { vec: Array.from((vec ?? []).values()).map(scValToJsonArg) };
    }
    case "scvMap": {
      const map = scVal.map();
      return {
        map: Array.from(map ?? []).map((entry) => ({
          key: scValToJsonArg(entry.key()),
          val: scValToJsonArg(entry.val()),
        })),
      };
    }
    case "scvVoid":
    default:
      // For void and other unsupported types, use scValToNative as fallback
      // Note: void types are rare in contract arguments
      return scValToNative(scVal) as ScVal;
  }
}

/**
 * Extracts expiration ledger sequences from auth entries.
 *
 * For Soroban transactions with `sorobanCredentialsAddress` type credentials,
 * the signatureExpirationLedger field specifies when the authorization expires.
 *
 * @returns Array of expiration ledger numbers from all address-credential auth entries
 */
export function getExpirationLedgersFromAuthEntries(
  authEntries: xdr.SorobanAuthorizationEntry[],
): number[] {
  const expirationLedgers: number[] = [];

  for (const authEntry of authEntries) {
    try {
      const credentials = authEntry.credentials();
      const credentialsType = credentials.switch().name;

      if (credentialsType === "sorobanCredentialsAddress") {
        const addressCredentials = credentials.address();
        const expirationLedger = addressCredentials.signatureExpirationLedger();
        expirationLedgers.push(expirationLedger);
      }
      // sorobanCredentialsSourceAccount doesn't have an expiration ledger
    } catch (error) {
      console.error(
        "Error extracting expiration ledger from auth entry:",
        error,
      );
    }
  }

  return expirationLedgers;
}

/**
 * Extracts signed addresses from auth entries attached to the operation.
 *
 * For Soroban transactions, the client signs auth entries (not the transaction envelope).
 * Each auth entry with `sorobanCredentialsAddress` type should have a signature
 * in its credentials.
 */
export function getSignedAddressesFromAuthEntries(
  authEntries: xdr.SorobanAuthorizationEntry[],
): { signedAddresses: string[]; unsignedAddresses: string[] } {
  const signedAddresses: string[] = [];
  const unsignedAddresses: string[] = [];

  for (const authEntry of authEntries) {
    try {
      const credentials = authEntry.credentials();
      const credentialsType = credentials.switch().name;

      if (credentialsType === "sorobanCredentialsAddress") {
        const addressCredentials = credentials.address();
        const address = Address.fromScAddress(
          addressCredentials.address(),
        ).toString();

        // Check if the auth entry has a signature
        // A signed auth entry has a non-void signature in its credentials
        const signature = addressCredentials.signature();
        const signatureType = signature.switch().name;

        // scvVoid means unsigned, anything else (typically scvVec with signature data) means signed
        const isSigned = signatureType !== "scvVoid";

        if (isSigned) {
          signedAddresses.push(address);
        } else {
          unsignedAddresses.push(address);
        }
      }
      // sorobanCredentialsSourceAccount doesn't need explicit signature validation
      // as it's authorized by the transaction source account
    } catch (error) {
      console.error("Error processing auth entry:", error);
    }
  }

  return { signedAddresses, unsignedAddresses };
}
