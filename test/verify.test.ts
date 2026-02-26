import * as utils from "../src/stellar/utils";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildInvokeTxBase64,
  buildPaymentPayload,
  buildPaymentPayloadV2,
  buildPaymentRequirements,
  buildPaymentRequirementsV2,
} from "./helpers/payload";

import { verify } from "../src/stellar/verify";

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

const networkConfig = {
  network: "stellar:testnet",
  type: "stellar" as const,
  relayer_id: "relayer-1",
  assets: ["ASSET_CONTRACT"],
};

const makeApi = (overrides: Partial<any> = {}) =>
  ({
    useRelayer: vi.fn().mockReturnValue({
      getRelayer: vi
        .fn()
        .mockResolvedValue({ network: "testnet", address: "RELAYER_ADDR" }),
      rpc: vi.fn().mockImplementation((params: any) => {
        if (params.method === "getLatestLedger") {
          return Promise.resolve({ result: { sequence: 1000 } });
        }
        // simulateTransaction
        return Promise.resolve({
          result: { events: ["mock_event"], minResourceFee: "50000" },
        });
      }),
      ...overrides,
    }),
  }) as any;

describe("stellar verify", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("rejects unsupported asset", async () => {
    const tx = buildInvokeTxBase64();
    const reqs = buildPaymentRequirementsV2({ asset: "OTHER_ASSET" });
    const payload = buildPaymentPayloadV2(tx, { asset: "OTHER_ASSET" });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      makeApi(),
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("unsupported_asset");
  });

  test("rejects when relayer network mismatches config", async () => {
    const tx = buildInvokeTxBase64();
    const api = makeApi({
      getRelayer: vi
        .fn()
        .mockResolvedValue({ network: "mainnet", address: "RELAYER_ADDR" }),
    });
    const payload = buildPaymentPayloadV2(tx);
    const reqs = buildPaymentRequirementsV2();

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("verify_network_mismatch");
  });

  test("validates success path and returns payer (v1 - should be rejected)", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
    });
    const payload = buildPaymentPayload(tx);
    const reqs = buildPaymentRequirements({
      payTo: "G-PAYEE",
      maxAmountRequired: "150",
    });

    const api = makeApi();
    vi.spyOn(utils, "getSignedAddressesFromAuthEntries").mockReturnValue({
      signedAddresses: ["G-PAYER"],
      unsignedAddresses: [],
    });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    // v1 should be rejected
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_x402_version");
  });

  test("rejects v1 x402 version", async () => {
    const tx = buildInvokeTxBase64();
    const payload = buildPaymentPayload(tx);
    const reqs = buildPaymentRequirements();

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      makeApi(),
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_x402_version");
  });

  test("validates v2 payload successfully", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
    });

    const api = makeApi();
    vi.spyOn(utils, "validateAuthEntries").mockReturnValue(null);
    vi.spyOn(utils, "getSignedAddressesFromAuthEntries").mockReturnValue({
      signedAddresses: ["G-PAYER"],
      unsignedAddresses: [],
    });
    vi.spyOn(utils, "validateAuthEntryExpirations").mockResolvedValue({
      isValid: true,
      currentLedger: 1000,
    });
    vi.spyOn(utils, "validateSimulationEvents").mockReturnValue({
      isValid: true,
      transferEvents: [],
    });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe("G-PAYER");
  });

  test("rejects v2 payload with missing accepted field", async () => {
    const tx = buildInvokeTxBase64();
    const payload = {
      x402Version: 2,
      payload: { transaction: tx },
    };

    const result = await verify(
      {
        paymentPayload: payload,
        paymentRequirements: buildPaymentRequirementsV2(),
      } as any,
      makeApi(),
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_x402_version");
  });

  test("rejects invalid scheme", async () => {
    const tx = buildInvokeTxBase64();
    const payload = buildPaymentPayloadV2(tx, { scheme: "invalid" as any });
    const reqs = buildPaymentRequirementsV2({ scheme: "invalid" as any });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      makeApi(),
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_scheme");
  });

  test("rejects non-CAIP-2 network identifier", async () => {
    const tx = buildInvokeTxBase64();
    const payload = buildPaymentPayloadV2(tx, { network: "testnet" });
    const reqs = buildPaymentRequirementsV2({ network: "testnet" });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      makeApi(),
      { ...networkConfig, network: "testnet" },
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_network");
  });

  test("rejects unknown CAIP-2 network", async () => {
    const tx = buildInvokeTxBase64();
    const payload = buildPaymentPayloadV2(tx, { network: "stellar:devnet" });
    const reqs = buildPaymentRequirementsV2({ network: "stellar:devnet" });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      makeApi(),
      { ...networkConfig, network: "stellar:devnet" },
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_network");
  });

  test("rejects network mismatch between payload and requirements", async () => {
    const tx = buildInvokeTxBase64();
    const payload = buildPaymentPayloadV2(tx, { network: "stellar:pubnet" });
    const reqs = buildPaymentRequirementsV2({ network: "stellar:testnet" });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      makeApi(),
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_network");
  });

  test("rejects wrong recipient address", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-WRONG",
      amount: 200n,
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-WRONG",
      amount: "150",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "150",
    });

    const api = makeApi();

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_wrong_recipient",
    );
    expect(result.payer).toBe("G-PAYER");
  });

  test("rejects insufficient payment amount (v2)", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 100n,
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "150",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "150",
    });

    const api = makeApi();

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_wrong_amount",
    );
    expect(result.payer).toBe("G-PAYER");
  });

  test("rejects transaction with envelope signatures", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
      signatures: [{ signature: "SIG" }],
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
    });

    const api = makeApi();

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_has_envelope_signatures",
    );
  });

  test("rejects auth entries with unsupported credential type", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
    });

    const api = makeApi();
    vi.spyOn(utils, "validateAuthEntries").mockReturnValue(
      "invalid_exact_stellar_payload_unsupported_credential_type",
    );

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_unsupported_credential_type",
    );
    expect(result.payer).toBe("G-PAYER");
  });

  test("rejects transaction with unsigned auth entries", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
    });

    const api = makeApi();
    vi.spyOn(utils, "validateAuthEntries").mockReturnValue(null);
    vi.spyOn(utils, "getSignedAddressesFromAuthEntries").mockReturnValue({
      signedAddresses: [],
      unsignedAddresses: ["G-PAYER"],
    });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    // The error is "missing_payer_auth" because no signed addresses means payer didn't sign
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_missing_payer_auth",
    );
  });

  test("rejects wrong contract address", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
      asset: "WRONG_CONTRACT",
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "150",
      asset: "WRONG_CONTRACT",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "150",
    });

    const api = makeApi();

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_wrong_asset",
    );
  });

  test("rejects wrong function name", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
      funcOverrides: {
        functionName: () => Buffer.from("approve"),
      },
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "150",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "150",
    });

    const api = makeApi();

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_wrong_function_name",
    );
  });

  test("rejects auth entry that has already expired", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
      maxTimeoutSeconds: 30,
    });

    const api = makeApi();
    vi.spyOn(utils, "validateAuthEntries").mockReturnValue(null);
    vi.spyOn(utils, "getSignedAddressesFromAuthEntries").mockReturnValue({
      signedAddresses: ["G-PAYER"],
      unsignedAddresses: [],
    });
    // Mock validateAuthEntryExpirations to return auth already expired error
    vi.spyOn(utils, "validateAuthEntryExpirations").mockResolvedValue({
      isValid: false,
      error: "invalid_exact_stellar_payload_auth_already_expired",
      currentLedger: 1000,
    });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_auth_already_expired",
    );
    expect(result.payer).toBe("G-PAYER");
  });

  test("rejects auth entry expiration too far in the future", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    // maxTimeoutSeconds=30 means max offset = ceil(30/5) = 6 ledgers
    // current ledger = 1000, so max allowed = 1006
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
      maxTimeoutSeconds: 30,
    });

    const api = makeApi();
    vi.spyOn(utils, "validateAuthEntries").mockReturnValue(null);
    vi.spyOn(utils, "getSignedAddressesFromAuthEntries").mockReturnValue({
      signedAddresses: ["G-PAYER"],
      unsignedAddresses: [],
    });
    // Mock validateAuthEntryExpirations to return expiration too far error
    vi.spyOn(utils, "validateAuthEntryExpirations").mockResolvedValue({
      isValid: false,
      error: "invalid_exact_stellar_payload_auth_expiration_too_far",
      currentLedger: 1000,
    });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_auth_expiration_too_far",
    );
    expect(result.payer).toBe("G-PAYER");
  });

  test("accepts auth entry expiration within allowed window", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    // maxTimeoutSeconds=30 means max offset = ceil(30/5) = 6 ledgers
    // current ledger = 1000, so max allowed = 1006
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
      maxTimeoutSeconds: 30,
    });

    const api = makeApi();
    vi.spyOn(utils, "validateAuthEntries").mockReturnValue(null);
    vi.spyOn(utils, "getSignedAddressesFromAuthEntries").mockReturnValue({
      signedAddresses: ["G-PAYER"],
      unsignedAddresses: [],
    });
    vi.spyOn(utils, "validateAuthEntryExpirations").mockResolvedValue({
      isValid: true,
      currentLedger: 1000,
    });
    vi.spyOn(utils, "validateSimulationEvents").mockReturnValue({
      isValid: true,
      transferEvents: [],
    });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe("G-PAYER");
  });

  test("rejects transaction with sub-invocations in auth entries", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
    });

    const api = makeApi();
    vi.spyOn(utils, "validateAuthEntries").mockReturnValue(
      "invalid_exact_stellar_payload_has_subinvocations",
    );

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_has_subinvocations",
    );
    expect(result.payer).toBe("G-PAYER");
  });

  test("rejects simulation with zero events", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
    });

    // Override simulateTransaction to return no events
    const api = makeApi({
      rpc: vi.fn().mockImplementation((params: any) => {
        if (params.method === "getLatestLedger") {
          return Promise.resolve({ result: { sequence: 1000 } });
        }
        // simulateTransaction returns no events
        return Promise.resolve({ result: {} });
      }),
    });
    vi.spyOn(utils, "validateAuthEntries").mockReturnValue(null);
    vi.spyOn(utils, "getSignedAddressesFromAuthEntries").mockReturnValue({
      signedAddresses: ["G-PAYER"],
      unsignedAddresses: [],
    });
    vi.spyOn(utils, "validateAuthEntryExpirations").mockResolvedValue({
      isValid: true,
      currentLedger: 1000,
    });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_no_transfer_events",
    );
    expect(result.payer).toBe("G-PAYER");
  });

  test("rejects simulation with non-transfer contract events", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
    });

    const api = makeApi();
    vi.spyOn(utils, "validateAuthEntries").mockReturnValue(null);
    vi.spyOn(utils, "getSignedAddressesFromAuthEntries").mockReturnValue({
      signedAddresses: ["G-PAYER"],
      unsignedAddresses: [],
    });
    vi.spyOn(utils, "validateAuthEntryExpirations").mockResolvedValue({
      isValid: true,
      currentLedger: 1000,
    });
    vi.spyOn(utils, "validateSimulationEvents").mockReturnValue({
      isValid: false,
      error: "Non-transfer contract event detected",
      errorCode: "invalid_exact_stellar_payload_event_not_transfer",
      transferEvents: [],
    });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_event_not_transfer",
    );
    expect(result.payer).toBe("G-PAYER");
  });

  test("rejects simulation with missing contract ID in events", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
    });

    const api = makeApi();
    vi.spyOn(utils, "validateAuthEntries").mockReturnValue(null);
    vi.spyOn(utils, "getSignedAddressesFromAuthEntries").mockReturnValue({
      signedAddresses: ["G-PAYER"],
      unsignedAddresses: [],
    });
    vi.spyOn(utils, "validateAuthEntryExpirations").mockResolvedValue({
      isValid: true,
      currentLedger: 1000,
    });
    vi.spyOn(utils, "validateSimulationEvents").mockReturnValue({
      isValid: false,
      error: "Simulation event missing contract ID",
      errorCode: "invalid_exact_stellar_payload_event_missing_contract_id",
      transferEvents: [],
    });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_event_missing_contract_id",
    );
    expect(result.payer).toBe("G-PAYER");
  });

  test("rejects transaction with fee below minimum resource fee", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
      fee: "1000",
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
    });

    // minResourceFee = 50000, transaction fee = 1000 -> should fail
    const api = makeApi();
    vi.spyOn(utils, "validateAuthEntries").mockReturnValue(null);
    vi.spyOn(utils, "getSignedAddressesFromAuthEntries").mockReturnValue({
      signedAddresses: ["G-PAYER"],
      unsignedAddresses: [],
    });
    vi.spyOn(utils, "validateAuthEntryExpirations").mockResolvedValue({
      isValid: true,
      currentLedger: 1000,
    });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_fee_below_minimum",
    );
    expect(result.payer).toBe("G-PAYER");
  });

  test("rejects transaction with fee exceeding maximum cap", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
      fee: "200000",
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
    });

    const configWithMaxFee = {
      ...networkConfig,
      maxTransactionFeeStroops: "100000",
    };

    const api = makeApi();
    vi.spyOn(utils, "validateAuthEntries").mockReturnValue(null);
    vi.spyOn(utils, "getSignedAddressesFromAuthEntries").mockReturnValue({
      signedAddresses: ["G-PAYER"],
      unsignedAddresses: [],
    });
    vi.spyOn(utils, "validateAuthEntryExpirations").mockResolvedValue({
      isValid: true,
      currentLedger: 1000,
    });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      configWithMaxFee,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_fee_exceeds_maximum",
    );
    expect(result.payer).toBe("G-PAYER");
  });

  test("accepts transaction with fee exactly equal to minimum resource fee", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
      fee: "50000",
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
    });

    const api = makeApi();
    vi.spyOn(utils, "validateAuthEntries").mockReturnValue(null);
    vi.spyOn(utils, "getSignedAddressesFromAuthEntries").mockReturnValue({
      signedAddresses: ["G-PAYER"],
      unsignedAddresses: [],
    });
    vi.spyOn(utils, "validateAuthEntryExpirations").mockResolvedValue({
      isValid: true,
      currentLedger: 1000,
    });
    vi.spyOn(utils, "validateSimulationEvents").mockReturnValue({
      isValid: true,
      transferEvents: [],
    });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe("G-PAYER");
  });

  test("accepts transaction with fee within valid range", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
      fee: "75000",
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
    });

    const configWithMaxFee = {
      ...networkConfig,
      maxTransactionFeeStroops: "100000",
    };

    const api = makeApi();
    vi.spyOn(utils, "validateAuthEntries").mockReturnValue(null);
    vi.spyOn(utils, "getSignedAddressesFromAuthEntries").mockReturnValue({
      signedAddresses: ["G-PAYER"],
      unsignedAddresses: [],
    });
    vi.spyOn(utils, "validateAuthEntryExpirations").mockResolvedValue({
      isValid: true,
      currentLedger: 1000,
    });
    vi.spyOn(utils, "validateSimulationEvents").mockReturnValue({
      isValid: true,
      transferEvents: [],
    });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      configWithMaxFee,
    );

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe("G-PAYER");
  });

  test("rejects when from address is channel service fund relayer address", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-CHANNEL-FUND-RELAYER",
      payTo: "G-PAYEE",
      amount: 200n,
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
    });

    const api = makeApi();
    const configWithFundRelayer = {
      ...networkConfig,
      channel_service_fund_relayer_address: "G-CHANNEL-FUND-RELAYER",
    };

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      configWithFundRelayer,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_unsafe_from_address",
    );
    expect(result.payer).toBe("G-CHANNEL-FUND-RELAYER");
  });

  test("rejects when transaction source is channel service fund relayer address", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
      source: "G-CHANNEL-FUND-RELAYER",
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
    });

    const api = makeApi();
    vi.spyOn(utils, "validateAuthEntries").mockReturnValue(null);
    vi.spyOn(utils, "getSignedAddressesFromAuthEntries").mockReturnValue({
      signedAddresses: ["G-PAYER"],
      unsignedAddresses: [],
    });
    vi.spyOn(utils, "validateAuthEntryExpirations").mockResolvedValue({
      isValid: true,
      currentLedger: 1000,
    });

    const configWithFundRelayer = {
      ...networkConfig,
      channel_service_fund_relayer_address: "G-CHANNEL-FUND-RELAYER",
    };

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      configWithFundRelayer,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_unsafe_tx_or_op_source",
    );
    expect(result.payer).toBe("G-PAYER");
  });

  test("rejects when operation source is channel service fund relayer address", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
      opSource: "G-CHANNEL-FUND-RELAYER",
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
    });

    const api = makeApi();
    vi.spyOn(utils, "validateAuthEntries").mockReturnValue(null);
    vi.spyOn(utils, "getSignedAddressesFromAuthEntries").mockReturnValue({
      signedAddresses: ["G-PAYER"],
      unsignedAddresses: [],
    });
    vi.spyOn(utils, "validateAuthEntryExpirations").mockResolvedValue({
      isValid: true,
      currentLedger: 1000,
    });

    const configWithFundRelayer = {
      ...networkConfig,
      channel_service_fund_relayer_address: "G-CHANNEL-FUND-RELAYER",
    };

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      configWithFundRelayer,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_stellar_payload_unsafe_tx_or_op_source",
    );
    expect(result.payer).toBe("G-PAYER");
  });

  test("skips max fee check when maxTransactionFeeStroops not configured", async () => {
    const tx = buildInvokeTxBase64({
      payer: "G-PAYER",
      payTo: "G-PAYEE",
      amount: 200n,
      fee: "999999999",
    });
    const payload = buildPaymentPayloadV2(tx, {
      payTo: "G-PAYEE",
      amount: "200",
    });
    const reqs = buildPaymentRequirementsV2({
      payTo: "G-PAYEE",
      amount: "200",
    });

    // networkConfig has no maxTransactionFeeStroops, so max check should be skipped
    const api = makeApi();
    vi.spyOn(utils, "validateAuthEntries").mockReturnValue(null);
    vi.spyOn(utils, "getSignedAddressesFromAuthEntries").mockReturnValue({
      signedAddresses: ["G-PAYER"],
      unsignedAddresses: [],
    });
    vi.spyOn(utils, "validateAuthEntryExpirations").mockResolvedValue({
      isValid: true,
      currentLedger: 1000,
    });
    vi.spyOn(utils, "validateSimulationEvents").mockReturnValue({
      isValid: true,
      transferEvents: [],
    });

    const result = await verify(
      { paymentPayload: payload, paymentRequirements: reqs } as any,
      api,
      networkConfig,
    );

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe("G-PAYER");
  });
});
