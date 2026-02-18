import { describe, expect, test, vi } from "vitest";
import {
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  isValidStellarNetwork,
  mapRelayerNetworkToStellar,
  validateVerifyRequest,
  validateSettleRequest,
} from "../src/stellar/utils";

describe("stellar utils", () => {
  describe("getNetworkPassphrase", () => {
    test("returns mainnet passphrase for stellar:pubnet", () => {
      const result = getNetworkPassphrase("stellar:pubnet");
      expect(result).toBe("Public Global Stellar Network ; September 2015");
    });

    test("returns testnet passphrase for stellar:testnet", () => {
      const result = getNetworkPassphrase("stellar:testnet");
      expect(result).toBe("Test SDF Network ; September 2015");
    });

    test("returns mainnet passphrase for mainnet", () => {
      const result = getNetworkPassphrase("mainnet");
      expect(result).toBe("Public Global Stellar Network ; September 2015");
    });

    test("returns testnet passphrase for testnet", () => {
      const result = getNetworkPassphrase("testnet");
      expect(result).toBe("Test SDF Network ; September 2015");
    });

    test("returns testnet passphrase for unknown network", () => {
      const result = getNetworkPassphrase("unknown-network");
      expect(result).toBe("Test SDF Network ; September 2015");
    });

    test("handles case insensitive network names", () => {
      const result = getNetworkPassphrase("STELLAR:PUBNET");
      expect(result).toBe("Public Global Stellar Network ; September 2015");
    });
  });

  describe("mapRelayerNetworkToStellar", () => {
    test("maps testnet to stellar:testnet", () => {
      const result = mapRelayerNetworkToStellar("testnet");
      expect(result).toBe("stellar:testnet");
    });

    test("maps mainnet to stellar:pubnet", () => {
      const result = mapRelayerNetworkToStellar("mainnet");
      expect(result).toBe("stellar:pubnet");
    });
  });

  describe("isValidStellarNetwork", () => {
    test("accepts stellar:testnet", () => {
      expect(isValidStellarNetwork("stellar:testnet")).toBe(true);
    });

    test("accepts stellar:pubnet", () => {
      expect(isValidStellarNetwork("stellar:pubnet")).toBe(true);
    });

    test("rejects non-CAIP-2 identifier 'testnet'", () => {
      expect(isValidStellarNetwork("testnet")).toBe(false);
    });

    test("rejects unknown CAIP-2 network 'stellar:devnet'", () => {
      expect(isValidStellarNetwork("stellar:devnet")).toBe(false);
    });

    test("rejects empty string", () => {
      expect(isValidStellarNetwork("")).toBe(false);
    });
  });

  describe("getEstimatedLedgerCloseTimeSeconds", () => {
    function makeRelayer(rpcHandler: (params: any) => any) {
      return { rpc: vi.fn().mockImplementation(rpcHandler) } as any;
    }

    test("returns average close time from getLedgers", async () => {
      const relayer = makeRelayer((params: any) => {
        if (params.method === "getLatestLedger") {
          return Promise.resolve({ result: { sequence: 1000 } });
        }
        if (params.method === "getLedgers") {
          return Promise.resolve({
            result: {
              ledgers: [
                { sequence: 991, ledgerCloseTime: "1000" },
                { sequence: 992, ledgerCloseTime: "1006" },
                { sequence: 993, ledgerCloseTime: "1012" },
                { sequence: 994, ledgerCloseTime: "1018" },
                { sequence: 995, ledgerCloseTime: "1024" },
              ],
            },
          });
        }
        return Promise.resolve({});
      });

      const result = await getEstimatedLedgerCloseTimeSeconds(relayer);
      expect(result).toBe(6);
    });

    test("falls back to default when getLedgers fails", async () => {
      const relayer = makeRelayer((params: any) => {
        if (params.method === "getLatestLedger") {
          return Promise.resolve({ result: { sequence: 1000 } });
        }
        if (params.method === "getLedgers") {
          return Promise.resolve({ error: "method not found" });
        }
        return Promise.resolve({});
      });

      const result = await getEstimatedLedgerCloseTimeSeconds(relayer);
      expect(result).toBe(5);
    });

    test("falls back to default with insufficient ledger data", async () => {
      const relayer = makeRelayer((params: any) => {
        if (params.method === "getLatestLedger") {
          return Promise.resolve({ result: { sequence: 1000 } });
        }
        if (params.method === "getLedgers") {
          return Promise.resolve({
            result: {
              ledgers: [{ sequence: 1000, ledgerCloseTime: "1000" }],
            },
          });
        }
        return Promise.resolve({});
      });

      const result = await getEstimatedLedgerCloseTimeSeconds(relayer);
      expect(result).toBe(5);
    });

    test("falls back to default when getLatestLedger fails", async () => {
      const relayer = makeRelayer((params: any) => {
        if (params.method === "getLatestLedger") {
          return Promise.resolve({ error: "rpc error" });
        }
        return Promise.resolve({});
      });

      const result = await getEstimatedLedgerCloseTimeSeconds(relayer);
      expect(result).toBe(5);
    });
  });

  function createValidRequestParams() {
    return {
      paymentPayload: {
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: "stellar:testnet",
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
        network: "stellar:testnet",
        amount: "1000",
        payTo: "RECIPIENT",
        asset: "ASSET_CONTRACT",
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
      },
    };
  }

  describe("validateVerifyRequest", () => {
    test("accepts valid request", () => {
      expect(validateVerifyRequest(createValidRequestParams())).toBe(true);
    });

    test("rejects null", () => {
      expect(validateVerifyRequest(null)).toBe(false);
    });

    test("rejects undefined", () => {
      expect(validateVerifyRequest(undefined)).toBe(false);
    });

    test("rejects empty object", () => {
      expect(validateVerifyRequest({})).toBe(false);
    });

    test("rejects missing paymentPayload", () => {
      const { paymentPayload, ...rest } = createValidRequestParams();
      expect(validateVerifyRequest(rest)).toBe(false);
    });

    test("rejects missing paymentRequirements", () => {
      const { paymentRequirements, ...rest } = createValidRequestParams();
      expect(validateVerifyRequest(rest)).toBe(false);
    });

    test("rejects null paymentPayload", () => {
      const params = createValidRequestParams();
      (params as any).paymentPayload = null;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects null paymentRequirements", () => {
      const params = createValidRequestParams();
      (params as any).paymentRequirements = null;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects missing paymentRequirements.scheme", () => {
      const params = createValidRequestParams();
      delete (params.paymentRequirements as any).scheme;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects missing paymentRequirements.network", () => {
      const params = createValidRequestParams();
      delete (params.paymentRequirements as any).network;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects missing paymentRequirements.amount", () => {
      const params = createValidRequestParams();
      delete (params.paymentRequirements as any).amount;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects missing paymentRequirements.payTo", () => {
      const params = createValidRequestParams();
      delete (params.paymentRequirements as any).payTo;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects missing paymentRequirements.asset", () => {
      const params = createValidRequestParams();
      delete (params.paymentRequirements as any).asset;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects missing paymentRequirements.maxTimeoutSeconds", () => {
      const params = createValidRequestParams();
      delete (params.paymentRequirements as any).maxTimeoutSeconds;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects non-number maxTimeoutSeconds", () => {
      const params = createValidRequestParams();
      (params.paymentRequirements as any).maxTimeoutSeconds = "60";
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects missing paymentPayload.x402Version", () => {
      const params = createValidRequestParams();
      delete (params.paymentPayload as any).x402Version;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects missing paymentPayload.accepted", () => {
      const params = createValidRequestParams();
      delete (params.paymentPayload as any).accepted;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects null paymentPayload.accepted", () => {
      const params = createValidRequestParams();
      (params.paymentPayload as any).accepted = null;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects missing paymentPayload.payload", () => {
      const params = createValidRequestParams();
      delete (params.paymentPayload as any).payload;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects null paymentPayload.payload", () => {
      const params = createValidRequestParams();
      (params.paymentPayload as any).payload = null;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects missing accepted.scheme", () => {
      const params = createValidRequestParams();
      delete (params.paymentPayload.accepted as any).scheme;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects missing accepted.network", () => {
      const params = createValidRequestParams();
      delete (params.paymentPayload.accepted as any).network;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects missing accepted.amount", () => {
      const params = createValidRequestParams();
      delete (params.paymentPayload.accepted as any).amount;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects missing accepted.maxTimeoutSeconds", () => {
      const params = createValidRequestParams();
      delete (params.paymentPayload.accepted as any).maxTimeoutSeconds;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects missing accepted.extra", () => {
      const params = createValidRequestParams();
      delete (params.paymentPayload.accepted as any).extra;
      expect(validateVerifyRequest(params)).toBe(false);
    });

    test("rejects accepted.extra without areFeesSponsored", () => {
      const params = createValidRequestParams();
      (params.paymentPayload.accepted as any).extra = {};
      expect(validateVerifyRequest(params)).toBe(false);
    });
  });

  describe("validateSettleRequest", () => {
    test("accepts valid request", () => {
      expect(validateSettleRequest(createValidRequestParams())).toBe(true);
    });

    test("rejects null", () => {
      expect(validateSettleRequest(null)).toBe(false);
    });

    test("rejects empty object", () => {
      expect(validateSettleRequest({})).toBe(false);
    });

    test("rejects missing paymentPayload", () => {
      const { paymentPayload, ...rest } = createValidRequestParams();
      expect(validateSettleRequest(rest)).toBe(false);
    });

    test("rejects missing paymentRequirements", () => {
      const { paymentRequirements, ...rest } = createValidRequestParams();
      expect(validateSettleRequest(rest)).toBe(false);
    });

    test("rejects missing paymentRequirements.network", () => {
      const params = createValidRequestParams();
      delete (params.paymentRequirements as any).network;
      expect(validateSettleRequest(params)).toBe(false);
    });

    test("rejects missing paymentPayload.accepted", () => {
      const params = createValidRequestParams();
      delete (params.paymentPayload as any).accepted;
      expect(validateSettleRequest(params)).toBe(false);
    });
  });
});
