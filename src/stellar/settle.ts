/**
 * Settles a Stellar payment by submitting the transaction on-chain.
 *
 * Settlement flow:
 * 1. Verify payment is valid
 * 2. Extract operation details and signed auth entries from user transaction
 * 3. Submit via relayer using operations with signed auth entries and an
 *    idempotency key derived from them
 * 4. Wait for confirmation
 *
 * A second settle of a payment that already settled fails verification on
 * the used nonce. Resource servers rely on that to reject replays, so this
 * plugin never reports an earlier settlement's success to a later call.
 *
 * The client signs only the auth entries (not the whole transaction envelope).
 * The relayer builds a fresh transaction with:
 * - Relayer as source account (provides sequence number and pays fees)
 * - User's signed auth entries (proves user authorization)
 * - Same contract invocation details
 */
import { createHash, randomUUID } from "node:crypto";
import { Address, Operation, Transaction, xdr } from "@stellar/stellar-sdk";
import {
  ExactStellarPayloadV2,
  NetworkConfig,
  SettleRequest,
  SettleResponse,
} from "../types";
import type {
  PluginAPI,
  Relayer,
  TransactionResponse,
} from "@openzeppelin/relayer-sdk";
import { ScVal, StellarTransactionResponse } from "@openzeppelin/relayer-sdk";
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_MESSAGE_LENGTH,
  getNetworkPassphrase,
  mapRelayerNetworkToStellar,
  networksMatch,
  scValToJsonArg,
} from "./utils";

import { verify } from "./verify";

/**
 * Options for `Relayer.sendTransaction`. Relayer 1.9.0+ reads
 * `idempotencyKey`; older Relayers drop it, so a resend there can create a
 * second transaction (see sendWithIdempotencyKey).
 * TODO: import `SendTransactionOptions` from `@openzeppelin/relayer-sdk`
 * once a release that exports it is published.
 */
type SendTransactionOptions = {
  idempotencyKey?: string;
};

type IdempotentRelayer = Omit<Relayer, "sendTransaction"> & {
  sendTransaction: (
    payload: Parameters<Relayer["sendTransaction"]>[0],
    options?: SendTransactionOptions,
  ) => ReturnType<Relayer["sendTransaction"]>;
};

/**
 * Derives the idempotency key for one settle call.
 *
 * The payer's signed auth entry carries a unique nonce, and the invocation
 * fixes the asset, payer, recipient and amount, so together with the network
 * they identify one transfer. The attempt id makes the key unique to a single
 * settle call: a resend within the call after a lost reply gets the
 * transaction already created, while a second settle call for the same
 * payment (a replay, concurrent or later) gets its own transaction, which
 * fails on the used nonce.
 */
export function settlementIdempotencyKey(
  network: string,
  funcXdr: string,
  authEntriesXdr: string[],
  attemptId: string,
): string {
  const hash = createHash("sha256");
  hash.update(network);
  hash.update("\n");
  hash.update(funcXdr);
  for (const entry of authEntriesXdr) {
    hash.update("\n");
    hash.update(entry);
  }
  return `x402-stellar-settle:${hash.digest("hex")}:${attemptId}`;
}

type ErrorReason =
  | "invalid_exact_stellar_payload_malformed"
  | "invalid_exact_stellar_payload_wrong_operation"
  | "settle_exact_stellar_transaction_failed"
  | "settle_exact_stellar_transaction_not_final"
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
/**
 * Upper bound for one channel service status request, so a dropped
 * connection cannot hang polling. Submits run until the settlement deadline:
 * the channel service has no idempotency key, so a submit aborted after it
 * was accepted cannot be found again.
 */
const CHANNEL_REQUEST_TIMEOUT_MS = 10_000;
const BUFFER_MS = 2_000;
const MAX_SUBMIT_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
/** Longest wait between channel service submits whose outcome is unknown. */
const MAX_BACKOFF_MS = 4000;
/**
 * Channel service errors for a submit under an Idempotency-Key whose outcome
 * is unknown: the fund relayer send failed but the transaction may still
 * land, or another request with the key is still creating it. Resending with
 * the same key is safe and returns the stored transaction.
 */
const CHANNEL_RESEND_CODES = new Set([
  "IDEMPOTENCY_KEY_SEND_FAILED",
  "IDEMPOTENCY_KEY_IN_PROGRESS",
]);
/**
 * Channel service error for a key whose transaction the Relayer can no longer
 * report. It may have landed; resending the key returns the same error.
 */
const CHANNEL_OUTCOME_UNKNOWN_CODE = "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN";

/** A request or send that the settlement deadline cut off before it answered. */
class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeadlineError";
  }
}

/**
 * A send whose outcome is still unknown when it gives up: an earlier attempt
 * may have created the transaction, which may still land.
 */
class SendOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super(
      `Send outcome unknown: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "SendOutcomeUnknownError";
  }
}
const IN_PROGRESS_BACKOFF_MS = 500;
const RELAYER_POLL_INTERVAL_MS = 500;
/** Relayer error when another request holds the key but has no transaction yet. */
const IDEMPOTENCY_IN_PROGRESS_MESSAGE =
  "A request with this Idempotency-Key is already in progress";
/**
 * Plugin runtime errors where the Relayer's reply did not arrive: request
 * timeout, socket closed by the server, or socket lost before sending. Only
 * the pool executor reconnects, so on the direct executor a resend after a
 * closed socket fails too.
 */
const SOCKET_ERROR_PREFIXES = [
  "Socket request ",
  "Socket closed",
  "Socket became unavailable",
];
/** Plugin runtime error code when the socket to the Relayer closed. */
const SOCKET_CLOSED_CODE = "ESOCKETCLOSED";
/** `mined` is not final: the transaction still awaits confirmation. */
const FINAL_TRANSACTION_STATUSES = new Set([
  "confirmed",
  "canceled",
  "expired",
  "failed",
]);

type RelayerRequest = Parameters<Relayer["sendTransaction"]>[0];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Custom error for channel service failures that preserves the HTTP status, parsed response body,
 * error code and the server's `retry-after` hint.
 */
class ChannelServiceError extends Error {
  public readonly code: unknown;

  constructor(
    public readonly status: number,
    public readonly data: Record<string, unknown> | null,
    public readonly retryAfterMs: number | null = null,
  ) {
    const nested = data?.data as Record<string, unknown> | undefined;
    const code = nested?.code ?? data?.code;
    super(`Channel service error (${status}): code=${code ?? "unknown"}`);
    this.name = "ChannelServiceError";
    this.code = code;
  }
}

/**
 * Parses a `retry-after` header given in seconds. The Relayer rate limiter
 * sends whole seconds, often 0, so callers keep their own minimum delay.
 */
function parseRetryAfterMs(header: string | null | undefined): number | null {
  const seconds = Number(header);
  return header && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : null;
}

/**
 * Delay before retrying after `error`: `minMs`, or longer when the server
 * asked to wait longer.
 */
function retryDelayMs(error: unknown, minMs: number): number {
  const retryAfterMs =
    error instanceof ChannelServiceError ? error.retryAfterMs : null;
  return Math.max(minMs, retryAfterMs ?? 0);
}

/**
 * Describes a failed channel service response for SettleResponse.errorMessage.
 */
function channelFailureMessage(
  subject: string,
  response: ChannelServiceResponse,
): string {
  const status = response.data?.status;
  const error = response.data?.error;
  return `Channel service ${subject}${status ? ` (status ${status})` : ""}${error ? `: ${error}` : ""}`;
}

/**
 * Submits transaction via channel service API.
 * Used when channel_service_api_url and channel_service_api_key are configured.
 */
async function callChannelService(
  apiUrl: string,
  apiKey: string,
  params: Record<string, unknown>,
  deadlineMs: number,
  options: { requestTimeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<ChannelServiceResponse> {
  // Abort at the request timeout or the settlement deadline, whichever is first
  const timeoutMs = Math.max(
    Math.min(options.requestTimeoutMs ?? Infinity, deadlineMs - Date.now()),
    0,
  );
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DeadlineError(
          `Channel service request timed out after ${timeoutMs}ms`,
        ),
      ),
    timeoutMs,
  );

  try {
    return await sendChannelServiceRequest(
      apiUrl,
      apiKey,
      params,
      options.headers ?? {},
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function sendChannelServiceRequest(
  apiUrl: string,
  apiKey: string,
  params: Record<string, unknown>,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<ChannelServiceResponse> {
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ params }),
    signal,
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
    throw new ChannelServiceError(
      response.status,
      data,
      parseRetryAfterMs(response.headers?.get("retry-after")),
    );
  }

  return response.json() as Promise<ChannelServiceResponse>;
}

/**
 * Tells whether a failed channel service status request is permanent: a 4xx
 * response other than request timeout (408) or rate limit (429), such as a
 * rejected API key. Retrying it cannot succeed.
 */
function isPermanentChannelError(error: unknown): boolean {
  return (
    error instanceof ChannelServiceError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

/**
 * Polls channel service for transaction status until confirmed, failed, or timeout.
 * The transaction is already submitted, so a transient status request failure
 * (dropped connection, rate limit, timeout, 5xx) counts as a missed poll, not
 * a failed settlement. A permanent failure (see isPermanentChannelError) stops
 * polling with status `poll_failed`: the transaction's outcome is unknown, not
 * failed. On timeout or poll failure the last hash seen is returned, so a
 * transaction that lands can still be reconciled.
 */
async function pollTransactionStatus(
  apiUrl: string,
  apiKey: string,
  transactionId: string,
  timeoutMs: number,
  fundRelayerId?: string,
): Promise<ChannelServiceResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastHash: string | null = null;

  while (Date.now() < deadline) {
    let waitMs = CHANNEL_POLL_INTERVAL_MS;
    try {
      const result = await callChannelService(
        apiUrl,
        apiKey,
        {
          getTransaction: { transactionId },
          ...(fundRelayerId ? { fundRelayerId } : {}),
        },
        deadline,
        { requestTimeoutMs: CHANNEL_REQUEST_TIMEOUT_MS },
      );

      lastHash = result.data?.hash ?? lastHash;
      const status = result.data?.status;
      if (
        status &&
        status !== "pending" &&
        status !== "sent" &&
        status !== "submitted" &&
        status !== "mined"
      ) {
        return result;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (isPermanentChannelError(error)) {
        console.error(
          `Channel service status request failed permanently for ${transactionId}:`,
          errorMsg,
        );
        return {
          success: false,
          data: {
            transactionId,
            status: "poll_failed",
            hash: lastHash,
            error: errorMsg,
          },
        };
      }
      waitMs = retryDelayMs(error, CHANNEL_POLL_INTERVAL_MS);
      console.warn(
        `Channel service status request failed for ${transactionId}, retrying:`,
        errorMsg,
      );
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(waitMs, remaining)),
    );
  }

  return {
    success: false,
    data: {
      transactionId,
      status: "timeout",
      hash: lastHash,
      error: "Transaction polling timed out",
    },
  };
}

/**
 * Settles transaction via channel service.
 * Extracts host function and auth entries as XDR and submits to channel service.
 *
 * The submit carries the settle call's `Idempotency-Key` header, the same
 * key the Relayer path sends. Channel services that support it return the
 * transaction an earlier submit with the key created; older ones ignore it.
 * A submit whose reply is lost is not resent, since an older service would
 * create a second transaction.
 */
async function settleViaChannelService(
  func: xdr.HostFunctionInvokeContract,
  authEntriesXdr: string[],
  idempotencyKey: string,
  networkConfig: NetworkConfig,
  network: string,
  deadlineMs: number,
  payer?: string,
): Promise<SettleResponse> {
  const funcXdr = func.toXdr("base64");
  const apiUrl = networkConfig.channel_service_api_url!;
  const apiKey = networkConfig.channel_service_api_key!;

  console.log("Settling via channel service (skipWait):", {
    apiUrl,
    funcXdrLength: funcXdr.length,
    authEntriesCount: authEntriesXdr.length,
  });

  // Hash the submit reported, kept for reconciliation if polling fails
  let submitHash: string | undefined;
  try {
    // Submit with skipWait, retrying with exponential backoff on POOL_CAPACITY and on
    // Relayer rate limits (429), and with fundRelayerId to use the dedicated fund relayer
    // for fee-bumping. A Relayer 429 is sent by its middleware before the plugin runs, so
    // nothing was submitted. FEE_LIMIT_EXCEEDED is also a 429 but the fee budget stays
    // spent until it resets, so it is not retried. A submit whose outcome is unknown
    // (see CHANNEL_RESEND_CODES) is resent with the same key until the deadline.
    const fundRelayerId = networkConfig.channel_service_fund_relayer_id;
    let submitResponse!: ChannelServiceResponse;
    // Once an attempt leaves the outcome unknown, a later failure does not
    // settle it: the earlier submit may still land
    let outcomeUnknown = false;
    const giveUp = (error: unknown) =>
      outcomeUnknown ? new SendOutcomeUnknownError(error) : error;
    for (let attempt = 0; ; attempt++) {
      try {
        submitResponse = await callChannelService(
          apiUrl,
          apiKey,
          {
            func: funcXdr,
            auth: authEntriesXdr,
            skipWait: true,
            ...(fundRelayerId ? { fundRelayerId } : {}),
          },
          deadlineMs,
          { headers: { "Idempotency-Key": idempotencyKey } },
        );
        break; // Success – exit retry loop
      } catch (error) {
        const isPoolCapacity =
          error instanceof ChannelServiceError &&
          error.code === "POOL_CAPACITY";
        const isRateLimited =
          error instanceof ChannelServiceError &&
          error.status === 429 &&
          error.code !== "FEE_LIMIT_EXCEEDED";
        const isResendable =
          error instanceof ChannelServiceError &&
          CHANNEL_RESEND_CODES.has(String(error.code));
        if (isResendable) outcomeUnknown = true;

        if (
          !(isPoolCapacity || isRateLimited || isResendable) ||
          (!isResendable && attempt >= MAX_SUBMIT_RETRIES)
        ) {
          throw giveUp(error); // Not retryable or exhausted retries
        }

        const reason = isResendable
          ? `Outcome unknown (${(error as ChannelServiceError).code})`
          : isPoolCapacity
            ? "POOL_CAPACITY"
            : "Rate limited (429)";
        const backoffMs = retryDelayMs(
          error,
          Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS),
        );
        const remaining = deadlineMs - Date.now();

        if (remaining <= backoffMs) {
          console.warn(
            `${reason} retry skipped: insufficient time budget (${remaining}ms remaining, need ${backoffMs}ms)`,
          );
          throw giveUp(error);
        }

        console.log(
          `${reason}, retrying attempt ${attempt + 1} after ${backoffMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    submitHash = submitResponse.data?.hash ?? undefined;
    if (!submitResponse.success) {
      console.error("Channel service submission failed:", submitResponse);
      return errorResponse(
        "settle_channel_service_failed",
        network,
        payer,
        submitResponse.data?.hash ?? undefined,
        channelFailureMessage("submission failed", submitResponse),
      );
    }

    // Legacy flow: channel service confirmed directly with a hash (no skipWait support).
    // A skipWait or idempotent repeat response can carry the hash of a transaction that
    // is not final yet, so only a confirmed status, or none from older services, counts.
    const submitStatus = submitResponse.data?.status;
    if (
      submitResponse.data?.hash &&
      (submitStatus === undefined || submitStatus === "confirmed")
    ) {
      console.log(
        "Transaction confirmed via channel service (legacy):",
        submitResponse.data.hash,
      );
      return successResponse(submitResponse.data.hash, network, payer);
    }

    // Async flow: channel service returned a transactionId for polling
    if (!submitResponse.data?.transactionId) {
      console.error(
        "Channel service returned no confirmed hash or transactionId:",
        submitResponse,
      );
      return errorResponse(
        "settle_channel_service_failed",
        network,
        payer,
        submitResponse.data?.hash ?? undefined,
        "Channel service returned no confirmed hash or transactionId",
      );
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
      return errorResponse(
        "settle_exact_stellar_transaction_not_final",
        network,
        payer,
        submitResponse.data?.hash ?? undefined,
        `Transaction ${transactionId} submitted, but no time was left to poll its status`,
      );
    }
    const result = await pollTransactionStatus(
      apiUrl,
      apiKey,
      transactionId,
      remainingMs,
      fundRelayerId,
    );

    // Polling can end without a hash; the submit may already have reported one
    const lastHash = result.data?.hash ?? submitHash;
    const pollStatus = result.data?.status;
    if (pollStatus === "confirmed" && result.data?.hash) {
      console.log(
        "Transaction confirmed via channel service:",
        result.data.hash,
      );
      return successResponse(result.data.hash, network, payer);
    } else if (
      // Accepted but not seen final: timed out, polling failed, or confirmed without a hash
      pollStatus === "timeout" ||
      pollStatus === "poll_failed" ||
      pollStatus === "confirmed"
    ) {
      console.error(
        "Channel service transaction not final at deadline:",
        result,
      );
      return errorResponse(
        "settle_exact_stellar_transaction_not_final",
        network,
        payer,
        lastHash,
        pollStatus === "confirmed"
          ? `Channel service transaction ${transactionId} confirmed without a hash`
          : channelFailureMessage(
              `transaction ${transactionId} not final`,
              result,
            ),
      );
    } else {
      console.error("Channel service transaction failed:", result);
      return errorResponse(
        "settle_channel_service_failed",
        network,
        payer,
        lastHash,
        channelFailureMessage(`transaction ${transactionId}`, result),
      );
    }
  } catch (channelError) {
    const errorMsg =
      channelError instanceof Error
        ? channelError.message
        : String(channelError);
    console.error("Channel service error:", errorMsg);
    // The submit's outcome is unknown, so the transaction may still land.
    // Only the channel service's own status and code, or the deadline, are
    // returned; other errors may carry internal details and stay in the log.
    return errorResponse(
      isChannelOutcomeUnknown(channelError)
        ? "settle_exact_stellar_transaction_not_final"
        : "settle_channel_service_failed",
      network,
      payer,
      submitHash,
      channelError instanceof ChannelServiceError ||
        channelError instanceof DeadlineError
        ? channelError.message
        : channelError instanceof SendOutcomeUnknownError
          ? "Channel service submit outcome unknown: the transaction may still land"
          : "Channel service request failed",
    );
  }
}

/**
 * Tells whether a channel service submit error leaves its outcome unknown:
 * cut off by the deadline after it may have been accepted, resent with the
 * same key until time ran out, or reported unknown by the channel service.
 */
function isChannelOutcomeUnknown(error: unknown): boolean {
  if (error instanceof DeadlineError) return true;
  if (error instanceof SendOutcomeUnknownError) return true;
  return (
    error instanceof ChannelServiceError &&
    (CHANNEL_RESEND_CODES.has(String(error.code)) ||
      error.code === CHANNEL_OUTCOME_UNKNOWN_CODE)
  );
}

/**
 * Decodes the contract invocation and signed auth entries from the payload.
 * Returns null when the payload is not a single invoke contract operation.
 */
function extractInvocation(params: SettleRequest): {
  func: xdr.HostFunctionInvokeContract;
  funcXdr: string;
  authEntriesXdr: string[];
} | null {
  try {
    const stellarPayload = params.paymentPayload
      .payload as ExactStellarPayloadV2;
    const transaction = new Transaction(
      stellarPayload.transaction,
      getNetworkPassphrase(params.paymentRequirements.network),
    );
    const operation = transaction.operations[0] as Operation.InvokeHostFunction;
    const func = operation?.func;
    if (!func || func.type !== "hostFunctionTypeInvokeContract") {
      return null;
    }
    const authEntriesXdr = (operation.auth || []).map((entry) =>
      entry.toXdr("base64"),
    );
    return { func, funcXdr: func.toXdr("base64"), authEntriesXdr };
  } catch {
    return null;
  }
}

/**
 * Resolves with the promise's value, or rejects once timeoutMs passes.
 * The promise keeps running; a late rejection is ignored.
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new DeadlineError(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Tells whether a sendTransaction error leaves the outcome unknown and can
 * be retried with the same key: another request holds the key but has no
 * transaction yet, or the Relayer's reply was lost. Errors the Relayer
 * returned for this request are final.
 */
function isRetryableSendError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(IDEMPOTENCY_IN_PROGRESS_MESSAGE) ||
    SOCKET_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix)) ||
    (error as { code?: unknown })?.code === SOCKET_CLOSED_CODE
  );
}

/**
 * Submits the transaction with an idempotency key, bounding each send by
 * the settlement deadline. When the outcome is unknown (see
 * isRetryableSendError), resends with the same key within the deadline: the
 * Relayer returns the transaction it holds for the key, or creates it if the
 * earlier send never arrived. Callers must have verified the payment.
 *
 * Requires Relayer 1.9.0+: older Relayers drop the key, so a resend after a
 * lost reply creates a second transaction, which then fails on the used
 * nonce.
 */
async function sendWithIdempotencyKey(
  relayer: Relayer,
  payload: RelayerRequest,
  idempotencyKey: string,
  deadlineMs: number,
): ReturnType<Relayer["sendTransaction"]> {
  // Once a reply is lost, a later failure does not settle the outcome: the
  // earlier send may have created the transaction
  let outcomeUnknown = false;
  for (let attempt = 0; ; attempt++) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      const error = new Error("No time remaining to send the transaction");
      throw outcomeUnknown ? new SendOutcomeUnknownError(error) : error;
    }
    try {
      return await withTimeout(
        (relayer as IdempotentRelayer).sendTransaction(payload, {
          idempotencyKey,
        }),
        remainingMs,
        "Send to Relayer",
      );
    } catch (error) {
      // Sent but unanswered by the deadline: the transaction may exist
      if (error instanceof DeadlineError) {
        throw new SendOutcomeUnknownError(error);
      }
      if (!isRetryableSendError(error)) {
        throw outcomeUnknown ? new SendOutcomeUnknownError(error) : error;
      }
      outcomeUnknown = true;

      const backoffMs = IN_PROGRESS_BACKOFF_MS * Math.pow(2, attempt);
      const remaining = deadlineMs - Date.now();
      if (attempt >= MAX_SUBMIT_RETRIES || remaining <= backoffMs) {
        throw new SendOutcomeUnknownError(error);
      }

      console.log(
        `Settlement outcome unknown (${error instanceof Error ? error.message : String(error)}), sending again (retry ${attempt + 1}/${MAX_SUBMIT_RETRIES}) after ${backoffMs}ms`,
      );
      await sleep(backoffMs);
    }
  }
}

/**
 * Maps a Relayer transaction to the settle response.
 */
function settlementResponse(
  tx: TransactionResponse | null,
  network: string,
  payer?: string,
): SettleResponse {
  // The transaction was created, so without a final status it may still land
  if (!tx) {
    console.error("No transaction status received before the deadline");
    return errorResponse(
      "settle_exact_stellar_transaction_not_final",
      network,
      payer,
      undefined,
      "No transaction status received before the deadline",
    );
  }

  const txHash = (tx as StellarTransactionResponse).hash;

  if (tx.status === "confirmed" && txHash) {
    console.log("Transaction confirmed:", txHash);
    return successResponse(txHash, network, payer);
  }

  // Confirmed without a hash cannot be reported as settled; reconcile it
  if (tx.status === "confirmed" || !FINAL_TRANSACTION_STATUSES.has(tx.status)) {
    console.error(
      `Transaction not final at deadline, status: ${tx.status}`,
      tx,
    );
    return errorResponse(
      "settle_exact_stellar_transaction_not_final",
      network,
      payer,
      txHash ?? undefined,
      tx.status === "confirmed"
        ? "Transaction confirmed without a hash"
        : `Transaction still ${tx.status} at the deadline`,
    );
  }

  console.error(`Transaction failed with status: ${tx.status}`, tx);
  const statusReason = (tx as StellarTransactionResponse).status_reason;
  return errorResponse(
    "settle_exact_stellar_transaction_failed",
    network,
    payer,
    txHash,
    `Transaction ${tx.status}${statusReason ? `: ${statusReason}` : ""}`,
  );
}

/**
 * Polls the Relayer until the transaction reaches a final status or the
 * deadline passes. Each status request is bounded by the remaining time,
 * and a failed request counts as a missed poll, not a failed settlement.
 * Returns the last status received, or null if none arrived.
 */
async function waitForRelayerTransaction(
  relayer: Relayer,
  transactionId: string,
  deadlineMs: number,
): Promise<TransactionResponse | null> {
  let tx: TransactionResponse | null = null;

  for (;;) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) return tx;

    try {
      tx = await withTimeout(
        relayer.getTransaction({ transactionId }),
        remainingMs,
        `Status request for ${transactionId}`,
      );
      if (FINAL_TRANSACTION_STATUSES.has(tx.status)) return tx;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn(
        `Relayer status request failed for ${transactionId}, retrying:`,
        errorMsg,
      );
    }

    const delayMs = Math.min(RELAYER_POLL_INTERVAL_MS, deadlineMs - Date.now());
    if (delayMs <= 0) return tx;
    await sleep(delayMs);
  }
}

/**
 * Converts the contract invocation and signed auth entries to the Relayer's
 * JSON transaction request.
 */
function buildRelayerRequest(
  func: xdr.HostFunctionInvokeContract,
  authEntriesXdr: string[],
  network: string,
): RelayerRequest {
  const invokeContractArgs = func.invokeContract;

  // Convert contract address from ScAddress to string
  const contractAddress = Address.fromScAddress(
    invokeContractArgs.contractAddress,
  ).toString();

  // Convert function name from ScSymbol to string
  const functionName = invokeContractArgs.functionName.toString();

  // Convert XDR args to JSON format for the relayer API
  const args = invokeContractArgs.args;
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

  return {
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
  };
}

/**
 * Settles transaction via relayer API.
 */
async function settleViaRelayer(
  request: RelayerRequest,
  idempotencyKey: string,
  relayer: Relayer,
  network: string,
  deadlineMs: number,
  payer?: string,
): Promise<SettleResponse> {
  let txResult: Awaited<ReturnType<typeof sendWithIdempotencyKey>>;
  try {
    txResult = await sendWithIdempotencyKey(
      relayer,
      request,
      idempotencyKey,
      deadlineMs,
    );
  } catch (error) {
    if (!(error instanceof SendOutcomeUnknownError)) throw error;
    console.error("Transaction not final at deadline:", error.message);
    return errorResponse(
      "settle_exact_stellar_transaction_not_final",
      network,
      payer,
      undefined,
      "No reply to the transaction send before the deadline: the transaction may still land",
    );
  }

  // Wait for transaction confirmation using remaining time budget
  const confirmedTx = await waitForRelayerTransaction(
    relayer,
    txResult.id,
    deadlineMs,
  );

  return settlementResponse(confirmedTx, network, payer);
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
 * Creates a failed settlement response. The message is returned to the
 * caller, so it must not carry configuration or internal error details.
 */
function errorResponse(
  reason: ErrorReason | string,
  network: string,
  payer?: string,
  txHash?: string,
  message?: string,
): SettleResponse {
  return {
    success: false,
    errorReason: reason,
    ...(message ? { errorMessage: message.slice(0, MAX_MESSAGE_LENGTH) } : {}),
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
        undefined,
        verifyResult.invalidMessage,
      );
    }

    payer = verifyResult.payer;

    // 2. Extract the operation details and signed auth entries (contain the
    // user's signatures) from the user-signed transaction
    const invocation = extractInvocation(params);
    if (!invocation) {
      return errorResponse(
        "invalid_exact_stellar_payload_wrong_operation",
        network,
        payer,
      );
    }
    const { func, funcXdr, authEntriesXdr } = invocation;
    const idempotencyKey = settlementIdempotencyKey(
      network,
      funcXdr,
      authEntriesXdr,
      randomUUID(),
    );

    // 3. Submit transaction via channel service or relayer
    const useChannelService =
      networkConfig.channel_service_api_url &&
      networkConfig.channel_service_api_key;

    if (useChannelService) {
      return await settleViaChannelService(
        func,
        authEntriesXdr,
        idempotencyKey,
        networkConfig,
        network,
        deadlineMs,
        payer,
      );
    } else {
      return await settleViaRelayer(
        buildRelayerRequest(func, authEntriesXdr, network),
        idempotencyKey,
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
