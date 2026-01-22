import { describe, expect, test } from "vitest";
import {
  getNetworkPassphrase,
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

    test("maps mainnet to stellar", () => {
      const result = mapRelayerNetworkToStellar("mainnet");
      expect(result).toBe("stellar");
    });
  });
});
