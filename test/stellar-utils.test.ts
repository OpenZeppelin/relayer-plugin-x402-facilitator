import { describe, expect, test, vi } from "vitest";
import {
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  isValidStellarNetwork,
  mapRelayerNetworkToStellar,
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
});
