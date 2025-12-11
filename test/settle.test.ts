import * as utils from "../src/stellar/utils";
import * as verifyModule from "../src/stellar/verify";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildInvokeTxBase64,
  buildPaymentPayload,
  buildPaymentRequirements,
} from "./helpers/payload";

import { settle } from "../src/stellar/settle";

vi.mock("@stellar/stellar-sdk", () => {
  class Transaction {
    operations: any[];
    signatures: any[];
    source: string | undefined;

    constructor(base64: string, _networkPassphrase?: string) {
      const raw = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));

      // Check if this is a test transaction
      if (raw.__testTransaction && (global as any).__testTxData) {
        const txData = (global as any).__testTxData;
        this.operations = txData.operations;
        this.signatures = txData.signatures;
        this.source = txData.source;
      } else {
        // Fallback for non-test transactions
        this.operations = raw.operations ?? [];
        this.signatures = raw.signatures ?? [];
        this.source = raw.source;
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
  network: "stellar-testnet",
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
      paymentPayload: buildPaymentPayload(tx),
      paymentRequirements: buildPaymentRequirements(),
    };

    const result = await settle(params as any, api, baseNetworkConfig);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settle_exact_stellar_network_mismatch");
  });

  test("settles via relayer when channel service not configured", async () => {
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
      paymentPayload: buildPaymentPayload(tx),
      paymentRequirements: buildPaymentRequirements(),
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

  test("settles via channel service when configured", async () => {
    const verifySpy = vi.spyOn(verifyModule, "verify").mockResolvedValue({
      isValid: true,
      payer: "G-PAYER",
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { hash: "HASH_CHANNEL" } }),
    } as any);

    const networkConfig = {
      ...baseNetworkConfig,
      channel_service_api_url: "https://channel.service/submit",
      channel_service_api_key: "channel-key",
    };

    const tx = buildInvokeTxBase64();
    const params = {
      paymentPayload: buildPaymentPayload(tx),
      paymentRequirements: buildPaymentRequirements(),
    };

    const result = await settle(params as any, makeApi(), networkConfig);

    expect(fetchMock).toHaveBeenCalled();
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
      paymentPayload: buildPaymentPayload(tx),
      paymentRequirements: buildPaymentRequirements(),
    };

    const result = await settle(params as any, makeApi(), baseNetworkConfig);

    expect(verifySpy).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("unsupported_asset");
  });

  test("fails when channel service returns error", async () => {
    vi.spyOn(verifyModule, "verify").mockResolvedValue({
      isValid: true,
      payer: "G-PAYER",
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "Internal Server Error",
    } as any);

    const networkConfig = {
      ...baseNetworkConfig,
      channel_service_api_url: "https://channel.service/submit",
      channel_service_api_key: "channel-key",
    };

    const tx = buildInvokeTxBase64();
    const params = {
      paymentPayload: buildPaymentPayload(tx),
      paymentRequirements: buildPaymentRequirements(),
    };

    const result = await settle(params as any, makeApi(), networkConfig);

    expect(fetchMock).toHaveBeenCalled();
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
      paymentPayload: buildPaymentPayload(tx),
      paymentRequirements: buildPaymentRequirements(),
    };

    const result = await settle(params as any, api, baseNetworkConfig);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("unexpected_settle_error");
  });
});
