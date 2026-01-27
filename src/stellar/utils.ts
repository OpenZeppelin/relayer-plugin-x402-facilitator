import { Address, StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";

/**
 * Shared utility functions for Stellar payment processing
 */
import { Relayer, ScVal } from "@openzeppelin/relayer-sdk";

// Default estimated ledger time in seconds (Stellar averages ~5-6 seconds per ledger)
const DEFAULT_ESTIMATED_LEDGER_SECONDS = 5;

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
 * Normalizes network identifier to handle both legacy and CAIP-2 formats.
 *
 * Currently returns the network unchanged as CAIP-2 format normalization
 * is not yet required. This function exists as an abstraction point for
 * future format handling without requiring changes to callers.
 *
 * @param network - Network identifier (e.g., "testnet", "stellar:testnet")
 * @returns The normalized network identifier
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
 * Extracts all addresses from auth entries attached to the operation.
 *
 * Returns all unique addresses found in auth entries, regardless of signature status.
 * This is used for security checks to ensure certain addresses don't appear in auth entries.
 */
export function getAllAddressesFromAuthEntries(
  authEntries: xdr.SorobanAuthorizationEntry[],
): string[] {
  const addresses: string[] = [];

  for (const authEntry of authEntries) {
    try {
      const credentials = authEntry.credentials();
      const credentialsType = credentials.switch().name;

      if (credentialsType === "sorobanCredentialsAddress") {
        const addressCredentials = credentials.address();
        const address = Address.fromScAddress(
          addressCredentials.address(),
        ).toString();
        addresses.push(address);
      }
    } catch (error) {
      console.error("Error extracting address from auth entry:", error);
    }
  }

  return addresses;
}

/**
 * Validates that the facilitator address does not appear in any auth entries.
 *
 * Security check: The facilitator MUST NOT appear in any authorization entries.
 * This prevents the facilitator from being tricked into authorizing unintended actions.
 *
 * @param authEntries - Authorization entries from the transaction
 * @param facilitatorAddress - The facilitator/relayer address to check against
 * @returns Error reason string if validation fails, null if valid
 */
export function validateFacilitatorNotInAuth(
  authEntries: xdr.SorobanAuthorizationEntry[],
  facilitatorAddress: string | undefined,
): string | null {
  if (!facilitatorAddress) {
    return null; // No facilitator address to check
  }

  const allAuthAddresses = getAllAddressesFromAuthEntries(authEntries);

  if (allAuthAddresses.includes(facilitatorAddress)) {
    console.error(
      `Security violation: facilitator address ${facilitatorAddress} found in auth entries`,
    );
    return "invalid_exact_stellar_payload_facilitator_in_auth";
  }

  return null;
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

/**
 * Represents a parsed transfer event from simulation
 */
export interface TransferEvent {
  contractId: string;
  from: string;
  to: string;
  amount: bigint;
}

/**
 * Result of validating simulation events
 */
export interface EventValidationResult {
  isValid: boolean;
  error?: string;
  transferEvents: TransferEvent[];
}

/**
 * Parses transfer events from simulation diagnostic events.
 *
 * SEP-41 token transfer events have the format:
 * - Topics: [Symbol("transfer"), Address(from), Address(to)]
 * - Data: i128(amount)
 *
 * @param diagnosticEvents - Decoded DiagnosticEvent array from simulation response
 * @returns Array of parsed transfer events
 */
export function parseTransferEventsFromSimulation(
  diagnosticEvents: xdr.DiagnosticEvent[] | string[],
): TransferEvent[] {
  const transferEvents: TransferEvent[] = [];

  for (let i = 0; i < diagnosticEvents.length; i++) {
    const rawEvent = diagnosticEvents[i];
    try {
      // Handle both string (base64 XDR) and already decoded DiagnosticEvent
      let diagnosticEvent: xdr.DiagnosticEvent;
      if (typeof rawEvent === "string") {
        diagnosticEvent = xdr.DiagnosticEvent.fromXDR(rawEvent, "base64");
      } else if (rawEvent && typeof rawEvent.event === "function") {
        diagnosticEvent = rawEvent;
      } else {
        continue;
      }

      const event = diagnosticEvent.event();

      // Skip events without contract ID (system events)
      const contractIdBuffer = event.contractId();
      if (!contractIdBuffer) {
        continue;
      }

      // Convert contract ID to string address
      // contractId() returns a Hash (Opaque type), convert to buffer
      const contractId = StrKey.encodeContract(
        Buffer.from(contractIdBuffer as unknown as Uint8Array),
      );

      // Get event type - we care about contract events
      // ContractEventType: 0 = System, 1 = Contract, 2 = Diagnostic
      const eventTypeName = event.type().name;

      if (eventTypeName !== "contract") {
        // Not a contract event, skip system and diagnostic events
        continue;
      }

      const body = event.body().v0();
      const topics = body.topics();
      const data = body.data();

      // Check if this is a transfer event
      // Topics should be: [Symbol("transfer"), Address(from), Address(to)]
      if (topics.length < 3) {
        continue;
      }

      // First topic should be the symbol "transfer"
      const firstTopic = topics[0];
      if (firstTopic.switch().name !== "scvSymbol") {
        continue;
      }

      const eventName = firstTopic.sym().toString();
      if (eventName !== "transfer") {
        continue;
      }

      // Extract from and to addresses from topics
      const fromTopic = topics[1];
      const toTopic = topics[2];

      let from: string;
      let to: string;

      // Handle different address formats in topics
      if (fromTopic.switch().name === "scvAddress") {
        from = Address.fromScVal(fromTopic).toString();
      } else {
        continue; // Not a standard transfer event format
      }

      if (toTopic.switch().name === "scvAddress") {
        to = Address.fromScVal(toTopic).toString();
      } else {
        continue; // Not a standard transfer event format
      }

      // Extract amount from data (should be i128)
      let amount: bigint;
      if (data.switch().name === "scvI128") {
        amount = scValToNative(data) as bigint;
      } else {
        // Try to extract as native value
        const nativeValue = scValToNative(data);
        if (typeof nativeValue === "bigint") {
          amount = nativeValue;
        } else if (typeof nativeValue === "number") {
          amount = BigInt(nativeValue);
        } else {
          continue; // Can't parse amount
        }
      }

      transferEvents.push({
        contractId,
        from,
        to,
        amount,
      });
    } catch (error) {
      // Skip events that can't be parsed - log only in debug scenarios
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.debug(`Error parsing simulation event: ${errorMessage}`);
      continue;
    }
  }

  return transferEvents;
}

/**
 * Validates simulation events against expected transfer parameters.
 *
 * Per spec: Simulation verification MUST emit events showing only the expected
 * balance changes (recipient increase, payer decrease) for requirements.amount
 * —no other balance changes allowed.
 *
 * @param diagnosticEvents - DiagnosticEvent array or base64 XDR strings from simulation response
 * @param expectedContractId - The token contract address (asset)
 * @param expectedFrom - The payer address
 * @param expectedTo - The recipient address (payTo)
 * @param expectedAmount - The exact amount to transfer
 * @returns Validation result with any error details
 */
export function validateSimulationEvents(
  diagnosticEvents: xdr.DiagnosticEvent[] | string[],
  expectedContractId: string,
  expectedFrom: string,
  expectedTo: string,
  expectedAmount: bigint,
): EventValidationResult {
  const transferEvents = parseTransferEventsFromSimulation(diagnosticEvents);

  // Filter transfer events for the expected token contract
  const tokenTransferEvents = transferEvents.filter(
    (e) => e.contractId === expectedContractId,
  );

  // There should be exactly one transfer event for the token
  if (tokenTransferEvents.length === 0) {
    return {
      isValid: false,
      error: "No transfer event found for the token contract",
      transferEvents,
    };
  }

  if (tokenTransferEvents.length > 1) {
    return {
      isValid: false,
      error: `Multiple transfer events (${tokenTransferEvents.length}) found for token contract, expected exactly one`,
      transferEvents,
    };
  }

  const transferEvent = tokenTransferEvents[0];

  // Validate from address matches payer
  if (transferEvent.from !== expectedFrom) {
    return {
      isValid: false,
      error: `Transfer from address mismatch: expected ${expectedFrom}, got ${transferEvent.from}`,
      transferEvents,
    };
  }

  // Validate to address matches recipient
  if (transferEvent.to !== expectedTo) {
    return {
      isValid: false,
      error: `Transfer to address mismatch: expected ${expectedTo}, got ${transferEvent.to}`,
      transferEvents,
    };
  }

  // Validate amount is exactly as expected
  if (transferEvent.amount !== expectedAmount) {
    return {
      isValid: false,
      error: `Transfer amount mismatch: expected ${expectedAmount}, got ${transferEvent.amount}`,
      transferEvents,
    };
  }

  // Check for unexpected transfer events from other contracts
  // This prevents attacks where additional transfers are hidden in the transaction
  const otherTransferEvents = transferEvents.filter(
    (e) => e.contractId !== expectedContractId,
  );

  if (otherTransferEvents.length > 0) {
    const unexpectedContracts = [
      ...new Set(otherTransferEvents.map((e) => e.contractId)),
    ];
    return {
      isValid: false,
      error: `Unexpected transfer events from other contracts: ${unexpectedContracts.join(", ")}`,
      transferEvents,
    };
  }

  return {
    isValid: true,
    transferEvents,
  };
}

/**
 * Result of auth entry expiration validation
 */
export interface ExpirationValidationResult {
  isValid: boolean;
  error?: string;
  currentLedger?: number;
}

/**
 * Validates that auth entry expiration ledgers are within the allowed window.
 *
 * Gets the current ledger from the network and validates each auth entry's
 * expiration is:
 * - Not already expired (expiration > currentLedger)
 * - Not too far in the future (expiration <= currentLedger + maxLedgerOffset)
 *
 * @param authEntries - Authorization entries from the transaction
 * @param relayer - Relayer instance for RPC calls
 * @param maxTimeoutSeconds - Maximum allowed timeout in seconds
 * @returns Validation result with current ledger info
 */
export async function validateAuthEntryExpirations(
  authEntries: xdr.SorobanAuthorizationEntry[],
  relayer: Relayer,
  maxTimeoutSeconds: number,
): Promise<ExpirationValidationResult> {
  // Get current ledger from the network
  const latestLedgerResponse = await relayer.rpc({
    method: "getLatestLedger",
    id: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
    jsonrpc: "2.0",
    params: {},
  });

  if (latestLedgerResponse.error || !latestLedgerResponse.result) {
    console.error("Failed to get latest ledger:", latestLedgerResponse.error);
    return {
      isValid: false,
      error: "invalid_exact_stellar_payload_simulation_failed",
    };
  }

  const currentLedger = (latestLedgerResponse.result as { sequence: number })
    .sequence;

  // Calculate max allowed expiration: currentLedger + ceil(maxTimeoutSeconds / estimatedLedgerSeconds)
  const maxLedgerOffset = Math.ceil(
    maxTimeoutSeconds / DEFAULT_ESTIMATED_LEDGER_SECONDS,
  );
  const maxAllowedExpiration = currentLedger + maxLedgerOffset;

  // Extract expiration ledgers from auth entries
  const expirationLedgers = getExpirationLedgersFromAuthEntries(authEntries);

  console.log("Auth entry expiration validation:", {
    currentLedger,
    maxTimeoutSeconds,
    maxLedgerOffset,
    maxAllowedExpiration,
    expirationLedgers,
  });

  for (const expirationLedger of expirationLedgers) {
    // Check if auth entry has already expired
    if (expirationLedger <= currentLedger) {
      console.error(
        `Auth entry already expired: expiration=${expirationLedger}, current=${currentLedger}`,
      );
      return {
        isValid: false,
        error: "invalid_exact_stellar_payload_auth_already_expired",
        currentLedger,
      };
    }

    // Check if auth entry expiration exceeds the allowed window
    if (expirationLedger > maxAllowedExpiration) {
      console.error(
        `Auth entry expiration exceeds allowed window: expiration=${expirationLedger}, max=${maxAllowedExpiration} (current=${currentLedger} + offset=${maxLedgerOffset})`,
      );
      return {
        isValid: false,
        error: "invalid_exact_stellar_payload_auth_expiration_too_far",
        currentLedger,
      };
    }
  }

  return { isValid: true, currentLedger };
}
