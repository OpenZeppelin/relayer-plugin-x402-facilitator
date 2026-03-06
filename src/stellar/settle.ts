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
  ExactStellarPayloadV2,
  NetworkConfig,
  SettleRequest,
  SettleResponse,
} from "../types";
import type { PluginAPI, Relayer } from "@openzeppelin/relayer-sdk";
import { ScVal, StellarTransactionResponse } from "@openzeppelin/relayer-sdk";
import {
  DEFAULT_TIMEOUT_SECONDS,
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

/**
 * Channel service response type
 */
interface ChannelServiceResponse {
  success: boolean;
  data: {
    transactionId?: string;
    status?: string;
    hash?: string | null;
    error?: string;
  };
}

const CHANNEL_POLL_INTERVAL_MS = 1000;
const BUFFER_MS = 2_000;
const MAX_SUBMIT_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

/**
 * Custom error for channel service failures that preserves the HTTP status and parsed response body.
 */
class ChannelServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly data: Record<string, unknown> | null,
  ) {
    const nested = data?.data as Record<string, unknown> | undefined;
    const code = nested?.code ?? data?.code ?? "unknown";
    super(`Channel service error (${status}): code=${code}`);
    this.name = "ChannelServiceError";
  }
}

/**
 * Submits transaction via channel service API.
 * Used when channel_service_api_url and channel_service_api_key are configured.
 */
async function callChannelService(
  apiUrl: string,
  apiKey: string,
  params: Record<string, unknown>,
): Promise<ChannelServiceResponse> {
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ params }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    let data: Record<string, unknown> | null = null;
    try {
      data = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      // Response body is not JSON – preserve raw text in data
      data = { rawBody: bodyText };
    }
    throw new ChannelServiceError(response.status, data);
  }

  return response.json() as Promise<ChannelServiceResponse>;
}

/**
 * Polls channel service for transaction status until confirmed, failed, or timeout.
 */
async function pollTransactionStatus(
  apiUrl: string,
  apiKey: string,
  transactionId: string,
  timeoutMs: number,
  fundRelayerId?: string,
): Promise<ChannelServiceResponse> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await callChannelService(apiUrl, apiKey, {
      getTransaction: { transactionId },
      ...(fundRelayerId ? { fundRelayerId } : {}),
    });

    const status = result.data?.status;
    if (
      status &&
      status !== "pending" &&
      status !== "sent" &&
      status !== "submitted"
    ) {
      return result;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(CHANNEL_POLL_INTERVAL_MS, remaining)),
    );
  }

  return {
    success: false,
    data: {
      transactionId,
      status: "timeout",
      error: "Transaction polling timed out",
    },
  };
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
  deadlineMs: number,
  payer?: string,
): Promise<SettleResponse> {
  const funcXdr = func.toXDR("base64");
  const apiUrl = networkConfig.channel_service_api_url!;
  const apiKey = networkConfig.channel_service_api_key!;

  console.log("Settling via channel service (skipWait):", {
    apiUrl,
    funcXdrLength: funcXdr.length,
    authEntriesCount: authEntriesXdr.length,
  });

  try {
    // Submit with skipWait, retrying on POOL_CAPACITY errors with exponential backoff
    // and with fundRelayerId to use the dedicated fund relayer for fee-bumping.
    const fundRelayerId = networkConfig.channel_service_fund_relayer_id;
    let submitResponse!: ChannelServiceResponse;
    for (let attempt = 0; attempt <= MAX_SUBMIT_RETRIES; attempt++) {
      try {
        submitResponse = await callChannelService(apiUrl, apiKey, {
          func: funcXdr,
          auth: authEntriesXdr,
          skipWait: true,
          ...(fundRelayerId ? { fundRelayerId } : {}),
        });
        break; // Success – exit retry loop
      } catch (error) {
        const nestedData =
          error instanceof ChannelServiceError
            ? (error.data?.data as Record<string, unknown> | undefined)
            : undefined;
        const isPoolCapacity =
          error instanceof ChannelServiceError &&
          (nestedData?.code === "POOL_CAPACITY" ||
            error.data?.code === "POOL_CAPACITY");

        if (!isPoolCapacity || attempt === MAX_SUBMIT_RETRIES) {
          throw error; // Not retryable or exhausted retries
        }

        const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        const remaining = deadlineMs - Date.now();

        if (remaining <= backoffMs) {
          console.warn(
            `POOL_CAPACITY retry skipped: insufficient time budget (${remaining}ms remaining, need ${backoffMs}ms)`,
          );
          throw error;
        }

        console.log(
          `POOL_CAPACITY error, retrying attempt ${attempt + 1}/${MAX_SUBMIT_RETRIES} after ${backoffMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    if (!submitResponse.success) {
      console.error("Channel service submission failed:", submitResponse);
      return errorResponse(
        "settle_channel_service_failed",
        network,
        payer,
        submitResponse.data?.hash ?? undefined,
      );
    }

    // Legacy flow: channel service confirmed directly with a hash (no skipWait support)
    if (submitResponse.data?.hash) {
      console.log(
        "Transaction confirmed via channel service (legacy):",
        submitResponse.data.hash,
      );
      return successResponse(submitResponse.data.hash, network, payer);
    }

    // Async flow: channel service returned a transactionId for polling
    if (!submitResponse.data?.transactionId) {
      console.error(
        "Channel service returned no hash or transactionId:",
        submitResponse,
      );
      return errorResponse("settle_channel_service_failed", network, payer);
    }

    const transactionId = submitResponse.data.transactionId;
    console.log(
      "Transaction submitted via channel service, polling for status:",
      transactionId,
    );

    // Poll for transaction status using remaining time budget
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      console.error("No time remaining for polling after submit");
      return errorResponse("settle_channel_service_failed", network, payer);
    }
    const result = await pollTransactionStatus(
      apiUrl,
      apiKey,
      transactionId,
      remainingMs,
      fundRelayerId,
    );

    if (result.data?.status === "confirmed" && result.data?.hash) {
      console.log(
        "Transaction confirmed via channel service:",
        result.data.hash,
      );
      return successResponse(result.data.hash, network, payer);
    } else {
      console.error("Channel service transaction failed:", result);
      return errorResponse(
        "settle_channel_service_failed",
        network,
        payer,
        result.data?.hash ?? undefined,
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
  network: string,
  deadlineMs: number,
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
    network,
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

  // Wait for transaction confirmation using remaining time budget
  const remainingMs = deadlineMs - Date.now();
  const confirmedTx = await txResult.wait({
    interval: 500,
    timeout: Math.max(remainingMs, 0),
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
  const startTime = Date.now();
  const timeoutMs =
    (paymentRequirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const bufferMs = Math.min(BUFFER_MS, timeoutMs / 2);
  const deadlineMs = startTime + timeoutMs - bufferMs;

  // Extract network from accepted field
  if (!paymentPayload.accepted) {
    return errorResponse("invalid_exact_stellar_payload_malformed", "");
  }
  const network = paymentPayload.accepted.network;

  // Validate incoming request network matches requirements and config
  // Note: This is also validated in verify(), but checking here provides
  // defense-in-depth against future code changes
  if (
    !networksMatch(network, paymentRequirements.network) ||
    !networksMatch(network, networkConfig.network)
  ) {
    return errorResponse("settle_exact_stellar_network_mismatch", network);
  }

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
    const stellarPayload = paymentPayload.payload as ExactStellarPayloadV2;
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
        deadlineMs,
        payer,
      );
    } else {
      return await settleViaRelayer(
        func,
        authEntriesXdr,
        relayer,
        network,
        deadlineMs,
        payer,
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Unexpected settlement error:", errorMessage);
    return errorResponse("unexpected_settle_error", network, payer);
  }
}
