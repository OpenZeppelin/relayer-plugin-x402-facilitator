import { describe, expect, test } from "vitest";
import { Address, Keypair } from "@stellar/stellar-sdk";
import {
  ESTIMATED_LEDGER_CLOSE_SECONDS,
  getNetworkPassphrase,
  isValidStellarNetwork,
  mapRelayerNetworkToStellar,
  validateVerifyRequest,
  validateSettleRequest,
  validateAuthEntries,
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

  describe("ESTIMATED_LEDGER_CLOSE_SECONDS", () => {
    test("is a reasonable value for Stellar ledger close time", () => {
      expect(ESTIMATED_LEDGER_CLOSE_SECONDS).toBeGreaterThanOrEqual(4);
      expect(ESTIMATED_LEDGER_CLOSE_SECONDS).toBeLessThanOrEqual(7);
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

  describe("validateAuthEntries", () => {
    function mockAuthEntry(stellarAddress: string) {
      const addr = new Address(stellarAddress);
      return {
        credentials: () => ({
          switch: () => ({ name: "sorobanCredentialsAddress" }),
          address: () => ({
            address: () => addr.toScAddress(),
          }),
        }),
        rootInvocation: () => ({
          subInvocations: () => [],
        }),
      } as any;
    }

    // Generate valid Stellar public keys for tests using deterministic seeds
    const RELAYER_ADDR = Keypair.fromRawEd25519Seed(
      Buffer.alloc(32, 1),
    ).publicKey();
    const CHANNEL_FUND_ADDR = Keypair.fromRawEd25519Seed(
      Buffer.alloc(32, 2),
    ).publicKey();
    const PAYER_ADDR = Keypair.fromRawEd25519Seed(
      Buffer.alloc(32, 3),
    ).publicKey();

    test("returns null for valid auth entries with no facilitator match", () => {
      const entries = [mockAuthEntry(PAYER_ADDR)];
      const result = validateAuthEntries(entries, RELAYER_ADDR);
      expect(result).toBeNull();
    });

    test("rejects when primary facilitator address is in auth entries", () => {
      const entries = [mockAuthEntry(RELAYER_ADDR)];
      const result = validateAuthEntries(entries, RELAYER_ADDR);
      expect(result).toBe("invalid_exact_stellar_payload_facilitator_in_auth");
    });

    test("rejects when additional facilitator address is in auth entries", () => {
      const entries = [mockAuthEntry(CHANNEL_FUND_ADDR)];
      const result = validateAuthEntries(entries, RELAYER_ADDR, [
        CHANNEL_FUND_ADDR,
      ]);
      expect(result).toBe("invalid_exact_stellar_payload_facilitator_in_auth");
    });

    test("allows when additional facilitator addresses are not in auth entries", () => {
      const entries = [mockAuthEntry(PAYER_ADDR)];
      const result = validateAuthEntries(entries, RELAYER_ADDR, [
        CHANNEL_FUND_ADDR,
      ]);
      expect(result).toBeNull();
    });

    test("filters undefined values from additional facilitator addresses", () => {
      const entries = [mockAuthEntry(PAYER_ADDR)];
      const result = validateAuthEntries(entries, RELAYER_ADDR, [undefined]);
      expect(result).toBeNull();
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
