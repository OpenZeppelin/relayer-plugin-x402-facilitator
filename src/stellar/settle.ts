/**
 * Settles a Stellar payment by submitting the transaction on-chain.
 *
 * Settlement flow:
 * 1. Verify payment is valid
 * 2. Extract operation details and signed auth entries from user transaction
 * 3. Submit via relayer using operations with signed auth entries
 * 4. Wait for confirmation
 *
 * The client signs only the auth entries (not the whole transaction envelope).
 * The relayer builds a fresh transaction with:
 * - Relayer as source account (provides sequence number and pays fees)
 * - User's signed auth entries (proves user authorization)
 * - Same contract invocation details
 */
import { Address, Operation, Transaction, xdr } from "@stellar/stellar-sdk";
import {
  ExactStellarPayload,
  NetworkConfig,
  PaymentRequirements,
  SettleRequest,
  SettleResponse,
} from "../types";
import type { PluginAPI, Relayer } from "@openzeppelin/relayer-sdk";
import { ScVal, StellarTransactionResponse } from "@openzeppelin/relayer-sdk";
import {
  getNetworkPassphrase,
  mapRelayerNetworkToStellar,
  networksMatch,
  scValToJsonArg,
} from "./utils";

import { verify } from "./verify";

type ErrorReason =
  | "invalid_exact_stellar_payload_malformed"
  | "invalid_exact_stellar_payload_wrong_operation"
  | "settle_exact_stellar_transaction_failed"
  | "settle_exact_stellar_network_mismatch"
  | "settle_channel_service_failed"
  | "unexpected_settle_error";

const DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * Channel service response type
 */
interface ChannelServiceResponse {
  success: boolean;
  data: {
    hash?: string;
    error?: string;
  };
}

/**
 * Submits transaction via channel service API.
 * Used when channel_service_api_url and channel_service_api_key are configured.
 */
async function submitViaChannelService(
  apiUrl: string,
  apiKey: string,
  funcXdr: string,
  authXdrs: string[],
): Promise<ChannelServiceResponse> {
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      params: {
        func: funcXdr,
        auth: authXdrs,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Channel service error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<ChannelServiceResponse>;
}

/**
 * Settles transaction via channel service.
 * Extracts host function and auth entries as XDR and submits to channel service.
 */
async function settleViaChannelService(
  func: xdr.HostFunction,
  authEntriesXdr: string[],
  networkConfig: NetworkConfig,
  network: string,
  payer?: string,
): Promise<SettleResponse> {
  const funcXdr = func.toXDR("base64");

  console.log("Settling via channel service:", {
    apiUrl: networkConfig.channel_service_api_url,
    funcXdrLength: funcXdr.length,
    authEntriesCount: authEntriesXdr.length,
  });

  try {
    const channelResponse = await submitViaChannelService(
      networkConfig.channel_service_api_url!,
      networkConfig.channel_service_api_key!,
      funcXdr,
      authEntriesXdr,
    );

    if (channelResponse.success && channelResponse.data?.hash) {
      console.log(
        "Transaction confirmed via channel service:",
        channelResponse.data.hash,
      );
      return successResponse(channelResponse.data.hash, network, payer);
    } else {
      console.error("Channel service submission failed:", channelResponse);
      return errorResponse(
        "settle_channel_service_failed",
        network,
        payer,
        channelResponse.data?.hash,
      );
    }
  } catch (channelError) {
    const errorMsg =
      channelError instanceof Error
        ? channelError.message
        : String(channelError);
    console.error("Channel service error:", errorMsg);
    return errorResponse("settle_channel_service_failed", network, payer);
  }
}

/**
 * Settles transaction via relayer API.
 * Converts operation details to JSON format and submits via relayer.
 */
async function settleViaRelayer(
  func: xdr.HostFunction,
  authEntriesXdr: string[],
  relayer: Relayer,
  paymentRequirements: PaymentRequirements,
  network: string,
  payer?: string,
): Promise<SettleResponse> {
  const invokeContractArgs = func.invokeContract();

  // Convert contract address from ScAddress to string
  const contractAddress = Address.fromScAddress(
    invokeContractArgs.contractAddress(),
  ).toString();

  // Convert function name from ScSymbol to string
  const functionName = invokeContractArgs.functionName().toString();

  // Convert XDR args to JSON format for the relayer API
  const args = invokeContractArgs.args();
  const jsonArgs: ScVal[] = [];
  for (let i = 0; i < args.length; i++) {
    jsonArgs.push(scValToJsonArg(args[i]));
  }

  console.log("Settling via relayer:", {
    contractAddress,
    functionName,
    argsCount: jsonArgs.length,
    authEntriesCount: authEntriesXdr.length,
  });

  const txResult = await relayer.sendTransaction({
    network: paymentRequirements.network,
    operations: [
      {
        type: "invoke_contract",
        contract_address: contractAddress,
        function_name: functionName,
        args: jsonArgs,
        auth: {
          type: "xdr",
          entries: authEntriesXdr,
        },
      },
    ],
  });

  // Wait for transaction confirmation
  const confirmedTx = await txResult.wait({
    interval: 500,
    timeout:
      (paymentRequirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
  });

  const txHash = (confirmedTx as StellarTransactionResponse).hash;

  if (confirmedTx.status === "confirmed") {
    console.log("Transaction confirmed:", txHash);
    return successResponse(txHash!, network, payer);
  } else {
    console.error(
      `Transaction failed with status: ${confirmedTx.status}`,
      confirmedTx,
    );
    return errorResponse(
      "settle_exact_stellar_transaction_failed",
      network,
      payer,
      txHash,
    );
  }
}

/**
 * Creates a successful settlement response
 */
function successResponse(
  txHash: string,
  network: string,
  payer?: string,
): SettleResponse {
  return {
    success: true,
    transaction: txHash,
    network,
    payer,
  };
}

/**
 * Creates a failed settlement response
 */
function errorResponse(
  reason: ErrorReason | string,
  network: string,
  payer?: string,
  txHash?: string,
): SettleResponse {
  return {
    success: false,
    errorReason: reason,
    transaction: txHash ?? "",
    network,
    payer,
  };
}

export async function settle(
  params: SettleRequest,
  api: PluginAPI,
  networkConfig: NetworkConfig,
): Promise<SettleResponse> {
  const { paymentPayload, paymentRequirements } = params;

  // Extract network from accepted field
  if (!paymentPayload.accepted) {
    return errorResponse(
      "invalid_exact_stellar_payload_malformed - missing accepted field",
      "",
    );
  }
  const network = paymentPayload.accepted.network;

  const relayer = api.useRelayer(networkConfig.relayer_id);
  const relayerInfo = await relayer.getRelayer();

  const mappedNetwork = mapRelayerNetworkToStellar(relayerInfo.network);

  // Return error response instead of throwing for network mismatch
  if (!networksMatch(mappedNetwork, networkConfig.network)) {
    console.error(
      `Relayer network mismatch: ${relayerInfo.network} (${mappedNetwork}) !== ${networkConfig.network}`,
    );
    return errorResponse("settle_exact_stellar_network_mismatch", network);
  }

  let payer: string | undefined;

  try {
    // 1. Verify payment before settlement
    const verifyResult = await verify(params, api, networkConfig);
    if (!verifyResult.isValid) {
      return errorResponse(
        verifyResult.invalidReason!,
        network,
        verifyResult.payer,
      );
    }

    payer = verifyResult.payer;

    // 2. Extract and parse the user-signed transaction XDR
    const stellarPayload = paymentPayload.payload as ExactStellarPayload;
    const networkPassphrase = getNetworkPassphrase(paymentRequirements.network);
    const transaction = new Transaction(
      stellarPayload.transaction,
      networkPassphrase,
    );

    // 3. Extract the operation details and signed auth entries from the transaction
    const operation = transaction.operations[0] as Operation.InvokeHostFunction;
    const func = operation.func;

    if (!func || func.switch().name !== "hostFunctionTypeInvokeContract") {
      return errorResponse(
        "invalid_exact_stellar_payload_wrong_operation",
        network,
        payer,
      );
    }

    // Extract signed auth entries (contain the user's signatures)
    const authEntries = operation.auth || [];
    const authEntriesXdr = authEntries.map((entry) => entry.toXDR("base64"));

    // 4. Submit transaction via channel service or relayer
    const useChannelService =
      networkConfig.channel_service_api_url &&
      networkConfig.channel_service_api_key;

    if (useChannelService) {
      return await settleViaChannelService(
        func,
        authEntriesXdr,
        networkConfig,
        network,
        payer,
      );
    } else {
      return await settleViaRelayer(
        func,
        authEntriesXdr,
        relayer,
        paymentRequirements,
        network,
        payer,
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Unexpected settlement error:", errorMessage);
    return errorResponse("unexpected_settle_error", network, payer);
  }
}
