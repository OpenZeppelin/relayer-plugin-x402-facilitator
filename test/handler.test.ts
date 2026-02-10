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
      params: {
        paymentRequirements: { network: "stellar:testnet" },
        paymentPayload: { network: "stellar:testnet" },
      },
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
      params: {
        paymentRequirements: { network: "stellar:testnet" },
        paymentPayload: { network: "stellar:testnet" },
      },
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

  test("/verify throws error for unsupported network", async () => {
    await expect(
      handler({
        route: "/verify",
        params: {
          paymentRequirements: { network: "unsupported-network" },
          paymentPayload: { network: "unsupported-network" },
        },
        api: {} as any,
        config: networkConfig,
        kv: {} as any,
        headers: {},
        method: "POST",
        query: {},
      } as any),
    ).rejects.toThrow(
      "Network config not found for network: unsupported-network",
    );
  });

  test("/settle throws error for unsupported network", async () => {
    await expect(
      handler({
        route: "/settle",
        params: {
          paymentRequirements: { network: "unsupported-network" },
          paymentPayload: { network: "unsupported-network" },
        },
        api: {} as any,
        config: networkConfig,
        kv: {} as any,
        headers: {},
        method: "POST",
        query: {},
      } as any),
    ).rejects.toThrow(
      "Network config not found for network: unsupported-network",
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
