import * as stellarSettle from "../src/stellar/settle";
import * as stellarVerify from "../src/stellar/verify";

import { describe, expect, test, vi } from "vitest";

import type { PluginAPI } from "@openzeppelin/relayer-sdk";
import { handler } from "../src/handler";

const networkConfig = {
  networks: [
    {
      network: "stellar:testnet",
      type: "stellar",
      relayer_id: "relayer-1",
      assets: ["ASSET_CONTRACT"],
    },
  ],
};

function createValidParams(network: string) {
  return {
    paymentPayload: {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network,
        amount: "1000",
        payTo: "RECIPIENT",
        asset: "ASSET_CONTRACT",
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
      },
      payload: { transaction: "base64tx" },
    },
    paymentRequirements: {
      scheme: "exact",
      network,
      amount: "1000",
      payTo: "RECIPIENT",
      asset: "ASSET_CONTRACT",
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true },
    },
  };
}

function createApiWithLedger(sequence: number, address?: string): PluginAPI {
  return {
    useRelayer: () =>
      ({
        getRelayer: async () => ({
          network: "testnet",
          address: address || "RELAYER_ADDR",
        }),
        rpc: async () => ({ result: { sequence } }),
      }) as any,
  } as any;
}

describe("handler routing", () => {
  test("default route returns info", async () => {
    const result = await handler({
      route: "",
      params: {},
      api: {} as any,
      config: networkConfig,
      kv: {} as any,
      headers: {},
      method: "POST",
      query: {},
    } as any);

    expect(result).toHaveProperty("message");
    expect(result).toHaveProperty("availableEndpoints");
    expect((result as any).message).toContain("X402 Facilitator");
    expect((result as any).availableEndpoints).toContain(
      "/verify - Verify a transaction",
    );
  });

  test("/verify delegates to stellar verify", async () => {
    const verifySpy = vi
      .spyOn(stellarVerify, "verify")
      .mockResolvedValue({ isValid: true, payer: "PAYER" });

    const result = await handler({
      route: "/verify",
      params: createValidParams("stellar:testnet"),
      api: {} as any,
      config: networkConfig,
      kv: {} as any,
      headers: {},
      method: "POST",
      query: {},
    } as any);

    expect(verifySpy).toHaveBeenCalled();
    expect(result).toHaveProperty("isValid");
    expect((result as any).isValid).toBe(true);
  });

  test("/settle delegates to stellar settle", async () => {
    const settleSpy = vi.spyOn(stellarSettle, "settle").mockResolvedValue({
      success: true,
      transaction: "TX",
      network: "stellar:testnet",
    });

    const result = await handler({
      route: "/settle",
      params: createValidParams("stellar:testnet"),
      api: {} as any,
      config: networkConfig,
      kv: {} as any,
      headers: {},
      method: "POST",
      query: {},
    } as any);

    expect(settleSpy).toHaveBeenCalled();
    expect(result).toHaveProperty("success");
    expect((result as any).success).toBe(true);
  });

  test("/supported returns kinds array with signers and extensions", async () => {
    const api = createApiWithLedger(100, "G-RELAYER123");
    const result = await handler({
      route: "/supported",
      params: {},
      api,
      config: networkConfig,
      kv: {} as any,
      headers: {},
      method: "POST",
      query: {},
    } as any);

    expect(result).toHaveProperty("kinds");
    // kinds is a flat array with x402Version in each item
    expect((result as any).kinds).toHaveLength(1);
    expect((result as any).kinds[0].x402Version).toBe(2);
    expect((result as any).kinds[0].network).toBe("stellar:testnet");
    expect((result as any).kinds[0].scheme).toBe("exact");
    expect((result as any).kinds[0].extra?.areFeesSponsored).toBe(true);

    // signers field
    expect(result).toHaveProperty("signers");
    expect((result as any).signers).toHaveProperty("stellar:testnet");
    expect((result as any).signers["stellar:testnet"]).toContain(
      "G-RELAYER123",
    );

    // extensions field (may be undefined if empty)
    expect(result).toHaveProperty("extensions");
  });

  test("unknown route returns 404 error", async () => {
    await expect(
      handler({
        route: "/not-found",
        params: {},
        api: {} as any,
        config: networkConfig,
        kv: {} as any,
        headers: {},
        method: "POST",
        query: {},
      } as any),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("throws error when config is missing", async () => {
    await expect(
      handler({
        route: "/verify",
        params: {},
        api: {} as any,
        config: undefined,
        kv: {} as any,
        headers: {},
        method: "POST",
        query: {},
      } as any),
    ).rejects.toThrow("X402 plugin config not found");
  });

  test("/verify returns invalid for malformed payload (empty params)", async () => {
    const result = await handler({
      route: "/verify",
      params: {},
      api: {} as any,
      config: networkConfig,
      kv: {} as any,
      headers: {},
      method: "POST",
      query: {},
    } as any);
    expect(result).toEqual({
      isValid: false,
      invalidReason: "invalid_exact_payload_malformed",
    });
  });

  test("/verify returns invalid for malformed payload (missing required fields)", async () => {
    const result = await handler({
      route: "/verify",
      params: {
        paymentPayload: { x402Version: 2 },
        paymentRequirements: { network: "stellar:testnet" },
      },
      api: {} as any,
      config: networkConfig,
      kv: {} as any,
      headers: {},
      method: "POST",
      query: {},
    } as any);
    expect(result).toEqual({
      isValid: false,
      invalidReason: "invalid_exact_payload_malformed",
    });
  });

  test("/settle returns error for malformed payload (empty params)", async () => {
    const result = await handler({
      route: "/settle",
      params: {},
      api: {} as any,
      config: networkConfig,
      kv: {} as any,
      headers: {},
      method: "POST",
      query: {},
    } as any);
    expect(result).toEqual({
      success: false,
      errorReason: "invalid_exact_payload_malformed",
      transaction: "",
      network: "",
    });
  });

  test("/settle returns error for malformed payload (missing required fields)", async () => {
    const result = await handler({
      route: "/settle",
      params: {
        paymentPayload: { x402Version: 2 },
        paymentRequirements: { network: "stellar:testnet" },
      },
      api: {} as any,
      config: networkConfig,
      kv: {} as any,
      headers: {},
      method: "POST",
      query: {},
    } as any);
    expect(result).toEqual({
      success: false,
      errorReason: "invalid_exact_payload_malformed",
      transaction: "",
      network: "",
    });
  });

  test("/verify returns invalid for unsupported network", async () => {
    const result = await handler({
      route: "/verify",
      params: createValidParams("unsupported-network"),
      api: {} as any,
      config: networkConfig,
      kv: {} as any,
      headers: {},
      method: "POST",
      query: {},
    } as any);
    expect(result).toEqual({
      isValid: false,
      invalidReason: "unsupported_network",
    });
  });

  test("/settle returns error for unsupported network", async () => {
    const result = await handler({
      route: "/settle",
      params: createValidParams("unsupported-network"),
      api: {} as any,
      config: networkConfig,
      kv: {} as any,
      headers: {},
      method: "POST",
      query: {},
    } as any);
    expect(result).toEqual({
      success: false,
      errorReason: "unsupported_network",
      transaction: "",
      network: "",
    });
  });

  test("/supported returns channel_service_fund_relayer_address when configured", async () => {
    const api = createApiWithLedger(100, "G-RELAYER123");
    const configWithChannelSigner = {
      networks: [
        {
          network: "stellar:testnet",
          type: "stellar",
          relayer_id: "relayer-1",
          assets: ["ASSET_CONTRACT"],
          channel_service_fund_relayer_address: "G-CHANNEL-SIGNER",
        },
      ],
    };

    const result = await handler({
      route: "/supported",
      params: {},
      api,
      config: configWithChannelSigner,
      kv: {} as any,
      headers: {},
      method: "POST",
      query: {},
    } as any);

    expect((result as any).signers["stellar:testnet"]).toContain(
      "G-CHANNEL-SIGNER",
    );
    expect((result as any).signers["stellar:testnet"]).not.toContain(
      "G-RELAYER123",
    );
  });

  test("/supported falls back to relayer address when channel_service_fund_relayer_address is not configured", async () => {
    const api = createApiWithLedger(100, "G-RELAYER123");
    const result = await handler({
      route: "/supported",
      params: {},
      api,
      config: networkConfig,
      kv: {} as any,
      headers: {},
      method: "POST",
      query: {},
    } as any);

    expect((result as any).signers["stellar:testnet"]).toContain(
      "G-RELAYER123",
    );
  });

  test("/supported returns configured fund relayer address even when getRelayer fails", async () => {
    const api = {
      useRelayer: () =>
        ({
          getRelayer: async () => {
            throw new Error("Failed to get relayer info");
          },
        }) as any,
    } as any;

    const configWithChannelSigner = {
      networks: [
        {
          network: "stellar:testnet",
          type: "stellar",
          relayer_id: "relayer-1",
          assets: ["ASSET_CONTRACT"],
          channel_service_fund_relayer_address: "G-CHANNEL-SIGNER",
        },
      ],
    };

    const result = await handler({
      route: "/supported",
      params: {},
      api,
      config: configWithChannelSigner,
      kv: {} as any,
      headers: {},
      method: "POST",
      query: {},
    } as any);

    expect((result as any).signers["stellar:testnet"]).toContain(
      "G-CHANNEL-SIGNER",
    );
  });

  test("/supported handles relayer info errors gracefully", async () => {
    const api = {
      useRelayer: () =>
        ({
          getRelayer: async () => {
            throw new Error("Failed to get relayer info");
          },
        }) as any,
    } as any;

    const result = await handler({
      route: "/supported",
      params: {},
      api,
      config: networkConfig,
      kv: {} as any,
      headers: {},
      method: "POST",
      query: {},
    } as any);

    expect(result).toHaveProperty("kinds");
    // kinds is a flat array
    expect((result as any).kinds).toHaveLength(1);
    expect((result as any).kinds[0].x402Version).toBe(2);
    expect((result as any).kinds[0].network).toBe("stellar:testnet");
    expect((result as any).kinds[0].extra?.areFeesSponsored).toBe(true);
    // signers should be undefined when relayer info fetch fails
    expect((result as any).signers).toBeUndefined();
  });

  test("root route '/' returns info", async () => {
    const result = await handler({
      route: "/",
      params: {},
      api: {} as any,
      config: networkConfig,
      kv: {} as any,
      headers: {},
      method: "POST",
      query: {},
    } as any);

    expect(result).toHaveProperty("message");
    expect(result).toHaveProperty("availableEndpoints");
    expect((result as any).message).toContain("X402 Facilitator");
    expect((result as any).availableEndpoints).toHaveLength(3);
  });
});
