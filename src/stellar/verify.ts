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
 * 7. Re-simulate transaction to ensure it will succeed
 * 8. Validate transaction source is not the relayer (security check)
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
  getNetworkPassphrase,
  getSignedAddressesFromAuthEntries,
  mapRelayerNetworkToStellar,
} from "./utils";

import type { PluginAPI } from "@openzeppelin/relayer-sdk";

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
  | "invalid_exact_stellar_payload_has_envelope_signatures"
  | "invalid_exact_stellar_payload_missing_auth_entries"
  | "invalid_exact_stellar_payload_missing_payer_auth"
  | "invalid_exact_stellar_payload_unsigned_auth_entry"
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

    // 1. Validate protocol version, scheme, and network
    if (paymentPayload.x402Version !== 1) {
      return invalidResponse("invalid_x402_version");
    }

    if (paymentPayload.scheme !== "exact") {
      return invalidResponse("invalid_scheme");
    }

    if (
      paymentPayload.network !== paymentRequirements.network ||
      paymentPayload.network !== networkConfig.network
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

    if (mappedNetwork !== networkConfig.network) {
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

    if (toAddress !== paymentRequirements.payTo) {
      return invalidResponse(
        "invalid_exact_stellar_payload_wrong_recipient",
        fromAddress,
      );
    }

    const requiredAmount = BigInt(paymentRequirements.maxAmountRequired);
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

    // 8. Security check: ensure transaction source is not the relayer
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

    // 9. Re-simulate to ensure transaction will succeed when rebuilt
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
