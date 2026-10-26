import * as utils from "../src/stellar/utils";
import * as verifyModule from "../src/stellar/verify";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildInvokeTxBase64,
  buildPaymentPayload,
  buildPaymentPayloadV2,
  buildPaymentRequirements,
  buildPaymentRequirementsV2,
} from "./helpers/payload";

import { settle } from "../src/stellar/settle";

vi.mock("@stellar/stellar-sdk", () => {
  class Transaction {
    operations: any[];
    signatures: any[];
    source: string | undefined;
    fee: string;

    constructor(base64: string, _networkPassphrase?: string) {
      const raw = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));

      // Check if this is a test transaction
      if (raw.__testTransaction && (global as any).__testTxData) {
        const txData = (global as any).__testTxData;
        this.operations = txData.operations;
        this.signatures = txData.signatures;
        this.source = txData.source;
        this.fee = txData.fee ?? "100000";
      } else {
        // Fallback for non-test transactions
        this.operations = raw.operations ?? [];
        this.signatures = raw.signatures ?? [];
        this.source = raw.source;
        this.fee = raw.fee ?? "100000";
      }
    }
  }

  const Address = {
    fromScAddress: (addr: any) => ({
      toString: () => (typeof addr === "string" ? addr : String(addr)),
    }),
    fromScVal: (val: any) => ({
      toString: () =>
        typeof val.value === "string" ? val.value : String(val.value),
    }),
  };

  const scValToNative = (val: any) => {
    const v =
      val && typeof val === "object" && "value" in val
        ? (val as any).value
        : val;
    if (typeof v === "number") return BigInt(v);
    if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
    return v;
  };

  const rpc = { Api: { isSimulationError: () => false } };

  return { Address, Transaction, scValToNative, rpc, Operation: {}, xdr: {} };
});

const baseNetworkConfig = {
  network: "stellar:testnet",
  type: "stellar" as const,
  relayer_id: "relayer-1",
  assets: ["ASSET_CONTRACT"],
};

const makeRelayer = () => {
  const wait = vi
    .fn()
    .mockResolvedValue({ status: "confirmed", hash: "HASH_RELAYER" });
  return {
    getRelayer: vi
      .fn()
      .mockResolvedValue({ network: "testnet", address: "RELAYER_ADDR" }),
    rpc: vi.fn().mockResolvedValue({ result: {} }),
    sendTransaction: vi.fn().mockResolvedValue({ wait }),
  };
};

const makeApi = (relayer = makeRelayer()) =>
  ({
    useRelayer: vi.fn().mockReturnValue(relayer),
  }) as any;

describe("stellar settle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("fails when relayer network mismatches config", async () => {
    const relayer = makeRelayer();
    relayer.getRelayer.mockResolvedValue({
      network: "mainnet",
      address: "RELAYER_ADDR",
    });
    const api = makeApi(relayer);

    const tx = buildInvokeTxBase64();
    const params = {
      paymentPayload: buildPaymentPayloadV2(tx),
      paymentRequirements: buildPaymentRequirementsV2(),
    };

    const result = await settle(params as any, api, baseNetworkConfig);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settle_exact_stellar_network_mismatch");
  });

  test("settles via relayer when channel service not configured (v2)", async () => {
    const verifySpy = vi.spyOn(verifyModule, "verify").mockResolvedValue({
      isValid: true,
      payer: "G-PAYER",
    });

    vi.spyOn(utils, "scValToJsonArg").mockImplementation(() => ({
      address: "MOCK_ADDRESS",
    }));

    const relayer = makeRelayer();
    const api = makeApi(relayer);

    const tx = buildInvokeTxBase64();
    const params = {
      paymentPayload: buildPaymentPayloadV2(tx),
      paymentRequirements: buildPaymentRequirementsV2(),
    };

    const result = await settle(params as any, api, baseNetworkConfig);

    expect(verifySpy).toHaveBeenCalled();
    expect(relayer.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: expect.any(Array),
      }),
    );
    expect(result.success).toBe(true);
    expect(result.transaction).toBe("HASH_RELAYER");
    expect(result.payer).toBe("G-PAYER");
  });

  test("settles via channel service when configured (skipWait + poll)", async () => {
    const verifySpy = vi.spyOn(verifyModule, "verify").mockResolvedValue({
      isValid: true,
      payer: "G-PAYER",
    });

    let callCount = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First call: submit with skipWait, returns transactionId
          return {
            ok: true,
            json: async () => ({
              success: true,
              data: { transactionId: "TX_ID_1", status: "pending", hash: null },
            }),
          } as any;
        }
        // Second call: get-transaction poll, returns confirmed
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              transactionId: "TX_ID_1",
              status: "confirmed",
              hash: "HASH_CHANNEL",
            },
          }),
        } as any;
      });

    const networkConfig = {
      ...baseNetworkConfig,
      channel_service_api_url: "https://channel.service/submit",
      channel_service_api_key: "channel-key",
      channel_service_fund_relayer_id: "x402-fund",
    };

    const tx = buildInvokeTxBase64();
    const params = {
      paymentPayload: buildPaymentPayloadV2(tx),
      paymentRequirements: buildPaymentRequirementsV2(),
    };

    const result = await settle(params as any, makeApi(), networkConfig);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First call should include skipWait
    const firstCallBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(firstCallBody.params.skipWait).toBe(true);
    // Second call should be get-transaction with fundRelayerId
    const secondCallBody = JSON.parse((fetchMock.mock.calls[1][1] as any).body);
    expect(secondCallBody.params.getTransaction.transactionId).toBe("TX_ID_1");
    expect(secondCallBody.params.fundRelayerId).toBe("x402-fund");

    expect(verifySpy).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.transaction).toBe("HASH_CHANNEL");
  });

  test("fails when verification fails", async () => {
    const verifySpy = vi.spyOn(verifyModule, "verify").mockResolvedValue({
      isValid: false,
      invalidReason: "unsupported_asset",
    });

    const tx = buildInvokeTxBase64();
    const params = {
      paymentPayload: buildPaymentPayloadV2(tx),
      paymentRequirements: buildPaymentRequirementsV2(),
    };

    const result = await settle(params as any, makeApi(), baseNetworkConfig);

    expect(verifySpy).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("unsupported_asset");
  });

  test("settles via channel service legacy flow (direct hash, no polling)", async () => {
    vi.spyOn(verifyModule, "verify").mockResolvedValue({
      isValid: true,
      payer: "G-PAYER",
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { hash: "HASH_LEGACY" },
      }),
    } as any);

    const networkConfig = {
      ...baseNetworkConfig,
      channel_service_api_url: "https://channel.service/submit",
      channel_service_api_key: "channel-key",
    };

    const tx = buildInvokeTxBase64();
    const params = {
      paymentPayload: buildPaymentPayloadV2(tx),
      paymentRequirements: buildPaymentRequirementsV2(),
    };

    const result = await settle(params as any, makeApi(), networkConfig);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.transaction).toBe("HASH_LEGACY");
  });

  test("fails when channel service submit returns success with empty data", async () => {
    vi.spyOn(verifyModule, "verify").mockResolvedValue({
      isValid: true,
      payer: "G-PAYER",
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {},
      }),
    } as any);

    const networkConfig = {
      ...baseNetworkConfig,
      channel_service_api_url: "https://channel.service/submit",
      channel_service_api_key: "channel-key",
    };

    const tx = buildInvokeTxBase64();
    const params = {
      paymentPayload: buildPaymentPayloadV2(tx),
      paymentRequirements: buildPaymentRequirementsV2(),
    };

    const result = await settle(params as any, makeApi(), networkConfig);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settle_channel_service_failed");
  });

  test("fails when channel service submit returns error", async () => {
    vi.spyOn(verifyModule, "verify").mockResolvedValue({
      isValid: true,
      payer: "G-PAYER",
    });

    const body = JSON.stringify({
      success: false,
      data: { code: "INTERNAL_ERROR", error: "Internal Server Error" },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => body,
    } as any);

    const networkConfig = {
      ...baseNetworkConfig,
      channel_service_api_url: "https://channel.service/submit",
      channel_service_api_key: "channel-key",
    };

    const tx = buildInvokeTxBase64();
    const params = {
      paymentPayload: buildPaymentPayloadV2(tx),
      paymentRequirements: buildPaymentRequirementsV2(),
    };

    const result = await settle(params as any, makeApi(), networkConfig);

    expect(fetchMock).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settle_channel_service_failed");
  });

  test("fails when channel service transaction poll returns failed status", async () => {
    vi.spyOn(verifyModule, "verify").mockResolvedValue({
      isValid: true,
      payer: "G-PAYER",
    });

    let callCount = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            json: async () => ({
              success: true,
              data: { transactionId: "TX_ID_1", status: "pending", hash: null },
            }),
          } as any;
        }
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: { transactionId: "TX_ID_1", status: "failed", hash: null },
          }),
        } as any;
      });

    const networkConfig = {
      ...baseNetworkConfig,
      channel_service_api_url: "https://channel.service/submit",
      channel_service_api_key: "channel-key",
    };

    const tx = buildInvokeTxBase64();
    const params = {
      paymentPayload: buildPaymentPayloadV2(tx),
      paymentRequirements: buildPaymentRequirementsV2(),
    };

    const result = await settle(params as any, makeApi(), networkConfig);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settle_channel_service_failed");
  });

  test("retries on POOL_CAPACITY error and succeeds", async () => {
    vi.useFakeTimers();
    vi.spyOn(verifyModule, "verify").mockResolvedValue({
      isValid: true,
      payer: "G-PAYER",
    });

    let callCount = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First call: POOL_CAPACITY error
          const body = JSON.stringify({
            success: false,
            data: { code: "POOL_CAPACITY", error: "All channels busy" },
          });
          return {
            ok: false,
            status: 503,
            text: async () => body,
          } as any;
        }
        if (callCount === 2) {
          // Second call (retry): success with hash
          return {
            ok: true,
            json: async () => ({
              success: true,
              data: { hash: "HASH_RETRY" },
            }),
          } as any;
        }
        throw new Error("Unexpected fetch call");
      });

    const networkConfig = {
      ...baseNetworkConfig,
      channel_service_api_url: "https://channel.service/submit",
      channel_service_api_key: "channel-key",
    };

    const tx = buildInvokeTxBase64();
    const params = {
      paymentPayload: buildPaymentPayloadV2(tx),
      paymentRequirements: buildPaymentRequirementsV2(),
    };

    const resultPromise = settle(params as any, makeApi(), networkConfig);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.transaction).toBe("HASH_RETRY");
  });

  test("does not retry on non-POOL_CAPACITY errors", async () => {
    vi.spyOn(verifyModule, "verify").mockResolvedValue({
      isValid: true,
      payer: "G-PAYER",
    });

    const body = JSON.stringify({
      success: false,
      data: { code: "INTERNAL_ERROR", error: "Something broke" },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => body,
    } as any);

    const networkConfig = {
      ...baseNetworkConfig,
      channel_service_api_url: "https://channel.service/submit",
      channel_service_api_key: "channel-key",
    };

    const tx = buildInvokeTxBase64();
    const params = {
      paymentPayload: buildPaymentPayloadV2(tx),
      paymentRequirements: buildPaymentRequirementsV2(),
    };

    const result = await settle(params as any, makeApi(), networkConfig);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settle_channel_service_failed");
  });

  test("fails after exhausting all POOL_CAPACITY retries", async () => {
    vi.useFakeTimers();
    vi.spyOn(verifyModule, "verify").mockResolvedValue({
      isValid: true,
      payer: "G-PAYER",
    });

    const body = JSON.stringify({
      success: false,
      data: { code: "POOL_CAPACITY", error: "All channels busy" },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => body,
    } as any);

    const networkConfig = {
      ...baseNetworkConfig,
      channel_service_api_url: "https://channel.service/submit",
      channel_service_api_key: "channel-key",
    };

    const tx = buildInvokeTxBase64();
    const params = {
      paymentPayload: buildPaymentPayloadV2(tx),
      paymentRequirements: buildPaymentRequirementsV2(),
    };

    const resultPromise = settle(params as any, makeApi(), networkConfig);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    // 1 initial + 3 retries = 4 total
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settle_channel_service_failed");
  });

  test("skips retry when insufficient time budget remains", async () => {
    vi.spyOn(verifyModule, "verify").mockResolvedValue({
      isValid: true,
      payer: "G-PAYER",
    });

    const body = JSON.stringify({
      success: false,
      data: { code: "POOL_CAPACITY", error: "All channels busy" },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => body,
    } as any);

    const networkConfig = {
      ...baseNetworkConfig,
      channel_service_api_url: "https://channel.service/submit",
      channel_service_api_key: "channel-key",
    };

    const tx = buildInvokeTxBase64();
    const params = {
      paymentPayload: buildPaymentPayloadV2(tx),
      // Very short timeout so no time for retries
      paymentRequirements: buildPaymentRequirementsV2({ maxTimeoutSeconds: 1 }),
    };

    const result = await settle(params as any, makeApi(), networkConfig);

    // Should only attempt once since there's no time budget for backoff
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settle_channel_service_failed");
  });

  test("fails when relayer sendTransaction fails", async () => {
    vi.spyOn(verifyModule, "verify").mockResolvedValue({
      isValid: true,
      payer: "G-PAYER",
    });

    vi.spyOn(utils, "scValToJsonArg").mockImplementation(() => ({
      address: "MOCK_ADDRESS",
    }));

    const relayer = makeRelayer();
    relayer.sendTransaction.mockRejectedValue(new Error("Transaction failed"));
    const api = makeApi(relayer);

    const tx = buildInvokeTxBase64();
    const params = {
      paymentPayload: buildPaymentPayloadV2(tx),
      paymentRequirements: buildPaymentRequirementsV2(),
    };

    const result = await settle(params as any, api, baseNetworkConfig);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("unexpected_settle_error");
  });
});

describe("channel service under rate limiting", () => {
  const channelConfig = {
    ...baseNetworkConfig,
    channel_service_api_url: "https://channel.service/submit",
    channel_service_api_key: "channel-key",
  };

  const okResponse = (data: Record<string, unknown>) =>
    ({ ok: true, json: async () => ({ success: true, data }) }) as any;

  const submitted = okResponse({
    transactionId: "TX_ID_1",
    status: "pending",
    hash: null,
  });
  const confirmed = okResponse({
    transactionId: "TX_ID_1",
    status: "confirmed",
    hash: "HASH_CHANNEL",
  });

  const makeParams = (overrides: Record<string, unknown> = {}) => ({
    paymentPayload: buildPaymentPayloadV2(buildInvokeTxBase64()),
    paymentRequirements: buildPaymentRequirementsV2(overrides),
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(verifyModule, "verify").mockResolvedValue({
      isValid: true,
      payer: "G-PAYER",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("lets a slow submit run until the settlement deadline", async () => {
    vi.useFakeTimers();
    let submitSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce((_url, init) => {
        submitSignal = init?.signal ?? undefined;
        // The channel service accepts but answers after 15 seconds
        return new Promise((resolve) =>
          setTimeout(() => resolve(submitted), 15_000),
        );
      })
      .mockResolvedValueOnce(confirmed);

    const promise = settle(
      makeParams({ maxTimeoutSeconds: 60 }) as any,
      makeApi(),
      channelConfig,
    );
    await vi.advanceTimersByTimeAsync(16_000);
    const result = await promise;

    expect(submitSignal?.aborted).toBe(false);
    expect(result.success).toBe(true);
    expect(result.transaction).toBe("HASH_CHANNEL");
  });

  test("keeps polling past mined until confirmed", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(submitted)
      .mockResolvedValueOnce(
        okResponse({ transactionId: "TX_ID_1", status: "mined", hash: null }),
      )
      .mockResolvedValueOnce(confirmed);

    const promise = settle(makeParams() as any, makeApi(), channelConfig);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("HASH_CHANNEL");
  });

  test("keeps polling when a status request is dropped", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(submitted)
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(confirmed);

    const promise = settle(makeParams() as any, makeApi(), channelConfig);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("HASH_CHANNEL");
  });

  test("keeps polling when a status request is rate limited", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(submitted)
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Too Many Requests",
      } as any)
      .mockResolvedValueOnce(confirmed);

    const promise = settle(makeParams() as any, makeApi(), channelConfig);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("HASH_CHANNEL");
  });

  test.each([408, 500, 503])(
    "keeps polling after a %i status response",
    async (status) => {
      vi.useFakeTimers();
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(submitted)
        .mockResolvedValueOnce({
          ok: false,
          status,
          text: async () => "unavailable",
        } as any)
        .mockResolvedValueOnce(confirmed);

      const promise = settle(makeParams() as any, makeApi(), channelConfig);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.transaction).toBe("HASH_CHANNEL");
    },
  );

  test.each([400, 401, 403, 404])(
    "stops polling on a permanent %i status response",
    async (status) => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(submitted)
        .mockResolvedValue({
          ok: false,
          status,
          text: async () => JSON.stringify({ code: "UNAUTHORIZED" }),
        } as any);

      const result = await settle(
        makeParams() as any,
        makeApi(),
        channelConfig,
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("settle_channel_service_failed");
    },
  );

  test("returns within the deadline when a status request hangs", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(submitted)
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            // A dropped connection never answers; only an abort ends it
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal!.reason),
            );
          }),
      )
      .mockResolvedValue(confirmed);

    let settled = false;
    const promise = settle(
      makeParams({ maxTimeoutSeconds: 30 }) as any,
      makeApi(),
      channelConfig,
    ).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(settled).toBe(true);
    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.transaction).toBe("HASH_CHANNEL");
  });
});
