/**
 * Verifies a Stellar payment payload against payment requirements.
 *
 * Verification steps:
 * 1. Validate protocol version, scheme, and network
 * 2. Decode transaction from XDR
 * 3. Validate it's an invokeHostFunction operation calling transfer
 * 4. Validate contract address, recipient, and amount
 * 5. Ensure transaction envelope signatures are empty (relayer rebuilds the tx)
 * 6. Verify auth entries are present and signed by the payer
 * 7. Validate auth entry expiration is within allowed window
 * 8. Validate transaction source is not the relayer (security check)
 * 9. Re-simulate transaction to ensure it will succeed
 *
 * Note: For Soroban transactions, signatures are in auth entries, not the envelope.
 * The client signs auth entries which authorize the contract invocation.
 * The relayer will rebuild the transaction with its own source account.
 */
import {
  Address,
  Operation,
  Transaction,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  ExactStellarPayload,
  NetworkConfig,
  VerifyRequest,
  VerifyResponse,
} from "../types";
import {
  getAllAddressesFromAuthEntries,
  getExpirationLedgersFromAuthEntries,
  getNetworkPassphrase,
  getSignedAddressesFromAuthEntries,
  mapRelayerNetworkToStellar,
  networksMatch,
} from "./utils";

import type { PluginAPI } from "@openzeppelin/relayer-sdk";

// Default estimated ledger time in seconds (Stellar averages ~5-6 seconds per ledger)
const DEFAULT_ESTIMATED_LEDGER_SECONDS = 5;

type ErrorReason =
  | "invalid_x402_version"
  | "invalid_scheme"
  | "invalid_network"
  | "invalid_exact_stellar_payload_malformed"
  | "invalid_exact_stellar_payload_wrong_operation"
  | "invalid_exact_stellar_payload_wrong_asset"
  | "invalid_exact_stellar_payload_wrong_function_name"
  | "invalid_exact_stellar_payload_wrong_function_args"
  | "invalid_exact_stellar_payload_wrong_recipient"
  | "invalid_exact_stellar_payload_wrong_amount"
  | "invalid_exact_stellar_payload_simulation_failed"
  | "invalid_exact_stellar_payload_unsafe_tx_or_op_source"
  | "invalid_exact_stellar_payload_unsafe_from_address"
  | "invalid_exact_stellar_payload_facilitator_in_auth"
  | "invalid_exact_stellar_payload_unexpected_balance_changes"
  | "invalid_exact_stellar_payload_has_envelope_signatures"
  | "invalid_exact_stellar_payload_missing_auth_entries"
  | "invalid_exact_stellar_payload_missing_payer_auth"
  | "invalid_exact_stellar_payload_unsigned_auth_entry"
  | "invalid_exact_stellar_payload_auth_expiration_too_far"
  | "invalid_exact_stellar_payload_auth_already_expired"
  | "verify_network_mismatch"
  | "unexpected_verify_error"
  | "unsupported_asset";

/**
 * Creates an invalid verification response
 */
function invalidResponse(
  reason: ErrorReason | string,
  payer?: string,
): VerifyResponse {
  return { isValid: false, invalidReason: reason, payer };
}

/**
 * Creates a valid verification response
 */
function validResponse(payer: string): VerifyResponse {
  return { isValid: true, payer };
}

export async function verify(
  params: VerifyRequest,
  api: PluginAPI,
  networkConfig: NetworkConfig,
): Promise<VerifyResponse> {
  try {
    const { paymentPayload, paymentRequirements } = params;

    // 1. Validate protocol version - only v2 is supported
    if (paymentPayload.x402Version !== 2) {
      return invalidResponse(
        "invalid_x402_version - only x402 v2 is supported. For v1 support, please use a previous version of this facilitator.",
      );
    }

    // Extract scheme and network from accepted field
    if (!paymentPayload.accepted) {
      return invalidResponse("invalid_x402_version - missing accepted field");
    }

    const scheme = paymentPayload.accepted.scheme;
    const network = paymentPayload.accepted.network;

    if (scheme !== "exact") {
      return invalidResponse("invalid_scheme");
    }

    // Validate requirements.scheme is also "exact"
    if (paymentRequirements.scheme !== "exact") {
      return invalidResponse("invalid_scheme");
    }

    // Validate network matches between accepted, requirements, and config
    if (
      !networksMatch(network, paymentRequirements.network) ||
      !networksMatch(network, networkConfig.network)
    ) {
      return invalidResponse("invalid_network");
    }

    // Check if asset is supported in the network config
    if (!networkConfig.assets.includes(paymentRequirements.asset)) {
      return invalidResponse("unsupported_asset");
    }

    // Get relayer info and validate network
    const relayer = api.useRelayer(networkConfig.relayer_id);
    const relayerInfo = await relayer.getRelayer();
    const mappedNetwork = mapRelayerNetworkToStellar(relayerInfo.network);

    if (!networksMatch(mappedNetwork, networkConfig.network)) {
      console.error(
        `Relayer network mismatch: ${relayerInfo.network} (${mappedNetwork}) !== ${networkConfig.network}`,
      );
      return invalidResponse("verify_network_mismatch");
    }

    // 2. Parse and decode transaction
    const stellarPayload = paymentPayload.payload as ExactStellarPayload;
    if (!stellarPayload.transaction) {
      return invalidResponse("invalid_exact_stellar_payload_malformed");
    }

    const networkPassphrase = getNetworkPassphrase(paymentRequirements.network);

    let transaction: Transaction;
    try {
      transaction = new Transaction(
        stellarPayload.transaction,
        networkPassphrase,
      );
    } catch (error) {
      console.error("Error parsing transaction:", error);
      return invalidResponse("invalid_exact_stellar_payload_malformed");
    }

    // 3. Validate transaction structure - must have exactly one operation
    if (transaction.operations.length !== 1) {
      console.error(
        "Invalid transaction operations length:",
        transaction.operations.length,
      );
      return invalidResponse("invalid_exact_stellar_payload_wrong_operation");
    }

    const operation = transaction.operations[0];
    if (operation.type !== "invokeHostFunction") {
      return invalidResponse("invalid_exact_stellar_payload_wrong_operation");
    }

    // 4. Extract and validate contract invocation details
    const invokeOp = operation as Operation.InvokeHostFunction;
    const func = invokeOp.func;

    if (!func || func.switch().name !== "hostFunctionTypeInvokeContract") {
      return invalidResponse("invalid_exact_stellar_payload_wrong_operation");
    }

    const invokeContractArgs = func.invokeContract();
    const contractAddress = Address.fromScAddress(
      invokeContractArgs.contractAddress(),
    ).toString();
    const functionName = invokeContractArgs.functionName().toString();
    const args = invokeContractArgs.args();

    // Validate contract address matches the required asset (token contract)
    if (contractAddress !== paymentRequirements.asset) {
      return invalidResponse("invalid_exact_stellar_payload_wrong_asset");
    }

    // Validate function is "transfer"
    if (functionName !== "transfer") {
      return invalidResponse(
        "invalid_exact_stellar_payload_wrong_function_name",
      );
    }

    // Validate transfer has 3 arguments: from, to, amount
    if (args.length !== 3) {
      return invalidResponse(
        "invalid_exact_stellar_payload_wrong_function_args",
      );
    }

    // 5. Extract and validate transfer arguments
    const fromAddress = scValToNative(args[0]) as string;
    const toAddress = scValToNative(args[1]) as string;
    const amount = scValToNative(args[2]) as bigint;

    // Security check: facilitator MUST NOT be the from address in the transfer
    // This prevents the facilitator from being tricked into transferring their own funds
    if (relayerInfo.address && fromAddress === relayerInfo.address) {
      console.error(
        `Security violation: from address is the facilitator: ${fromAddress}`,
      );
      return invalidResponse(
        "invalid_exact_stellar_payload_unsafe_from_address",
        fromAddress,
      );
    }

    if (toAddress !== paymentRequirements.payTo) {
      return invalidResponse(
        "invalid_exact_stellar_payload_wrong_recipient",
        fromAddress,
      );
    }

    // Validate amount (v2 uses amount field)
    if (!paymentRequirements.amount) {
      return invalidResponse(
        "invalid_exact_stellar_payload_wrong_amount - missing amount",
        fromAddress,
      );
    }
    const requiredAmount = BigInt(paymentRequirements.amount);
    if (amount < requiredAmount) {
      return invalidResponse(
        "invalid_exact_stellar_payload_wrong_amount",
        fromAddress,
      );
    }

    // 6. Ensure transaction envelope signatures are empty
    // The relayer will rebuild the transaction with its own source account
    if (transaction.signatures.length > 0) {
      console.error(
        "Transaction has envelope signatures, expected empty for relayer rebuild",
      );
      return invalidResponse(
        "invalid_exact_stellar_payload_has_envelope_signatures",
        fromAddress,
      );
    }

    // 7. Validate auth entries - must exist and be signed by the payer
    const authEntries = invokeOp.auth || [];

    if (authEntries.length === 0) {
      console.error("No auth entries found in transaction");
      return invalidResponse(
        "invalid_exact_stellar_payload_missing_auth_entries",
        fromAddress,
      );
    }

    // Check signatures in the auth entries attached to the operation
    const { signedAddresses, unsignedAddresses } =
      getSignedAddressesFromAuthEntries(authEntries);

    console.log("Auth entry validation:", {
      signedAddresses,
      unsignedAddresses,
      expectedPayer: fromAddress,
    });

    // The payer (fromAddress) must have signed their auth entry
    if (!signedAddresses.includes(fromAddress)) {
      console.error(
        `Payer ${fromAddress} has not signed auth entry. Signed: ${signedAddresses.join(
          ", ",
        )}`,
      );
      return invalidResponse(
        "invalid_exact_stellar_payload_missing_payer_auth",
        fromAddress,
      );
    }

    // All auth entries requiring signatures should be signed
    if (unsignedAddresses.length > 0) {
      console.error(
        `Unsigned auth entries for: ${unsignedAddresses.join(", ")}`,
      );
      return invalidResponse(
        "invalid_exact_stellar_payload_unsigned_auth_entry",
        fromAddress,
      );
    }

    // Security check: facilitator address MUST NOT appear in any authorization entries
    // This prevents the facilitator from being tricked into authorizing unintended actions
    const allAuthAddresses = getAllAddressesFromAuthEntries(authEntries);
    if (
      relayerInfo.address &&
      allAuthAddresses.includes(relayerInfo.address)
    ) {
      console.error(
        `Security violation: facilitator address ${relayerInfo.address} found in auth entries`,
      );
      return invalidResponse(
        "invalid_exact_stellar_payload_facilitator_in_auth",
        fromAddress,
      );
    }

    // 8. Validate auth entry expiration ledgers are within allowed window
    // Get current ledger from the network
    const latestLedgerResponse = await relayer.rpc({
      method: "getLatestLedger",
      id: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
      jsonrpc: "2.0",
      params: {},
    });

    if (latestLedgerResponse.error || !latestLedgerResponse.result) {
      console.error("Failed to get latest ledger:", latestLedgerResponse.error);
      return invalidResponse(
        "invalid_exact_stellar_payload_simulation_failed",
        fromAddress,
      );
    }

    const currentLedger = (latestLedgerResponse.result as { sequence: number })
      .sequence;

    // Calculate max allowed expiration: currentLedger + ceil(maxTimeoutSeconds / estimatedLedgerSeconds)
    const maxTimeoutSeconds = paymentRequirements.maxTimeoutSeconds ?? 30;
    const maxLedgerOffset = Math.ceil(
      maxTimeoutSeconds / DEFAULT_ESTIMATED_LEDGER_SECONDS,
    );
    const maxAllowedExpiration = currentLedger + maxLedgerOffset;

    // Extract expiration ledgers from auth entries and validate
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
        return invalidResponse(
          "invalid_exact_stellar_payload_auth_already_expired",
          fromAddress,
        );
      }

      // Check if auth entry expiration exceeds the allowed window
      if (expirationLedger > maxAllowedExpiration) {
        console.error(
          `Auth entry expiration exceeds allowed window: expiration=${expirationLedger}, max=${maxAllowedExpiration} (current=${currentLedger} + offset=${maxLedgerOffset})`,
        );
        return invalidResponse(
          "invalid_exact_stellar_payload_auth_expiration_too_far",
          fromAddress,
        );
      }
    }

    // 9. Security check: ensure transaction source is not the relayer
    // This prevents the client from trying to authorize actions on behalf of the relayer
    if (
      operation.source === relayerInfo.address ||
      transaction.source === relayerInfo.address
    ) {
      return invalidResponse(
        "invalid_exact_stellar_payload_unsafe_tx_or_op_source",
        fromAddress,
      );
    }

    // 10. Re-simulate to ensure transaction will succeed when rebuilt
    const simulateRpcResponse = await relayer.rpc({
      method: "simulateTransaction",
      id: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
      jsonrpc: "2.0",
      params: {
        transaction: stellarPayload.transaction,
      },
    });

    if (simulateRpcResponse.error) {
      console.error("Simulation RPC error:", simulateRpcResponse.error);
      return invalidResponse(
        "invalid_exact_stellar_payload_simulation_failed",
        fromAddress,
      );
    }

    const simulateResponse =
      simulateRpcResponse.result as rpc.Api.SimulateTransactionResponse;
    if (rpc.Api.isSimulationError(simulateResponse)) {
      console.error("Simulation error:", simulateResponse.error);
      return invalidResponse(
        "invalid_exact_stellar_payload_simulation_failed",
        fromAddress,
      );
    }

    console.log("Verification successful for payer:", fromAddress);
    return validResponse(fromAddress);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Unexpected verification error:", errorMessage);
    return invalidResponse("unexpected_verify_error");
  }
}
