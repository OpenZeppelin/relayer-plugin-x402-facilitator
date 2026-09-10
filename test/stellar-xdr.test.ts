/**
 * Tests that exercise the real @stellar/stellar-sdk v17 XDR objects (no mocks).
 *
 * These cover the Protocol 27/28 credential variants (CAP-71) that older SDKs
 * could not decode, and the v17 XDR API shape (property access, `type`
 * discriminants, Uint8Array bytes) used throughout src/stellar/utils.ts.
 */
import { describe, expect, test } from "vitest";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  getAddressCredentials,
  getAllAddressesFromAuthEntries,
  getExpirationLedgersFromAuthEntries,
  getSignedAddressesFromAuthEntries,
  isSignaturePresent,
  parseTransferEventsFromSimulation,
  scValToJsonArg,
  validateAuthEntries,
} from "../src/stellar/utils";

const PAYER = Keypair.fromRawEd25519Seed(
  new Uint8Array(32).fill(1),
).publicKey();
const PAYEE = Keypair.fromRawEd25519Seed(
  new Uint8Array(32).fill(2),
).publicKey();
const FACILITATOR = Keypair.fromRawEd25519Seed(
  new Uint8Array(32).fill(3),
).publicKey();
const TOKEN_CONTRACT_ID = new Uint8Array(32).fill(7);
const TOKEN_CONTRACT = StrKey.encodeContract(TOKEN_CONTRACT_ID);

type CredentialVariant = "address" | "addressV2" | "addressWithDelegates";

/** How the `signature` field of address credentials is populated. */
type SignatureShape = "void" | "emptyVec" | "nullVec" | "signed";

const SIGNATURES: Record<SignatureShape, () => xdr.ScVal> = {
  void: () => xdr.ScVal.scvVoid(),
  // Placeholder written by stellar-sdk `authorizeInvocation` before signing
  emptyVec: () => xdr.ScVal.scvVec([]),
  nullVec: () => xdr.ScVal.scvVec(null),
  signed: () =>
    xdr.ScVal.scvVec([xdr.ScVal.scvBytes(new Uint8Array(64).fill(9))]),
};

interface CredentialOpts {
  signed?: boolean;
  signature?: SignatureShape;
  expirationLedger?: number;
}

function addressCredentials(
  account: string,
  opts: CredentialOpts = {},
): xdr.SorobanAddressCredentials {
  const shape: SignatureShape =
    opts.signature ?? (opts.signed ? "signed" : "void");
  return new xdr.SorobanAddressCredentials({
    address: new Address(account).toScAddress(),
    nonce: 42n,
    signatureExpirationLedger: opts.expirationLedger ?? 1000,
    signature: SIGNATURES[shape](),
  });
}

function credentials(
  variant: CredentialVariant | "sourceAccount",
  account: string,
  opts: CredentialOpts = {},
): xdr.SorobanCredentials {
  switch (variant) {
    case "address":
      return xdr.SorobanCredentials.sorobanCredentialsAddress(
        addressCredentials(account, opts),
      );
    case "addressV2":
      return xdr.SorobanCredentials.sorobanCredentialsAddressV2(
        addressCredentials(account, opts),
      );
    case "addressWithDelegates":
      return xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
        new xdr.SorobanAddressCredentialsWithDelegates({
          addressCredentials: addressCredentials(account, opts),
          delegates: [],
        }),
      );
    case "sourceAccount":
      return xdr.SorobanCredentials.sorobanCredentialsSourceAccount();
  }
}

function transferInvocation(
  subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function:
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(TOKEN_CONTRACT).toScAddress(),
          functionName: "transfer",
          args: [
            new Address(PAYER).toScVal(),
            new Address(PAYEE).toScVal(),
            nativeToScVal(100n, { type: "i128" }),
          ],
        }),
      ),
    subInvocations,
  });
}

function authEntry(
  variant: CredentialVariant | "sourceAccount",
  account: string = PAYER,
  opts: CredentialOpts & {
    subInvocations?: xdr.SorobanAuthorizedInvocation[];
  } = {},
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: credentials(variant, account, opts),
    rootInvocation: transferInvocation(opts.subInvocations),
  });
}

function transferEvent(
  opts: {
    contractId?: Uint8Array | null;
    type?: xdr.ContractEventType;
    topics?: xdr.ScVal[];
    data?: xdr.ScVal;
  } = {},
): xdr.DiagnosticEvent {
  const contractId =
    opts.contractId === null
      ? null
      : new xdr.ContractId(opts.contractId ?? TOKEN_CONTRACT_ID);
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(),
      contractId,
      type: opts.type ?? xdr.ContractEventType.contract,
      body: xdr.ContractEventBody.v0(
        new xdr.ContractEventV0({
          topics: opts.topics ?? [
            xdr.ScVal.scvSymbol("transfer"),
            new Address(PAYER).toScVal(),
            new Address(PAYEE).toScVal(),
          ],
          data: opts.data ?? nativeToScVal(250n, { type: "i128" }),
        }),
      ),
    }),
  });
}

describe("stellar xdr (real sdk v17 objects)", () => {
  describe("getAddressCredentials", () => {
    test.each<CredentialVariant>([
      "address",
      "addressV2",
      "addressWithDelegates",
    ])("extracts address credentials from %s", (variant) => {
      const creds = getAddressCredentials(credentials(variant, PAYER));
      expect(creds).not.toBeNull();
      expect(Address.fromScAddress(creds!.address).toString()).toBe(PAYER);
      expect(creds!.signatureExpirationLedger).toBe(1000);
      expect(creds!.nonce).toBe(42n);
    });

    test("returns null for source account credentials", () => {
      expect(
        getAddressCredentials(credentials("sourceAccount", PAYER)),
      ).toBeNull();
    });
  });

  describe("validateAuthEntries", () => {
    test("accepts legacy sorobanCredentialsAddress entries", () => {
      expect(
        validateAuthEntries([authEntry("address")], FACILITATOR),
      ).toBeNull();
    });

    test("accepts CAP-71 sorobanCredentialsAddressV2 entries", () => {
      expect(
        validateAuthEntries([authEntry("addressV2")], FACILITATOR),
      ).toBeNull();
    });

    test("rejects delegated credentials", () => {
      expect(
        validateAuthEntries([authEntry("addressWithDelegates")], FACILITATOR),
      ).toBe("invalid_exact_stellar_payload_unsupported_credential_type");
    });

    test("rejects source account credentials", () => {
      expect(
        validateAuthEntries([authEntry("sourceAccount")], FACILITATOR),
      ).toBe("invalid_exact_stellar_payload_unsupported_credential_type");
    });

    test("detects the facilitator address inside a V2 entry", () => {
      expect(
        validateAuthEntries([authEntry("addressV2", FACILITATOR)], FACILITATOR),
      ).toBe("invalid_exact_stellar_payload_facilitator_in_auth");
    });

    test("detects the facilitator address inside a delegated entry", () => {
      expect(
        validateAuthEntries(
          [authEntry("addressWithDelegates", FACILITATOR)],
          FACILITATOR,
        ),
      ).toBe("invalid_exact_stellar_payload_facilitator_in_auth");
    });

    test("rejects sub-invocations on V2 entries", () => {
      const entry = authEntry("addressV2", PAYER, {
        subInvocations: [transferInvocation()],
      });
      expect(validateAuthEntries([entry], FACILITATOR)).toBe(
        "invalid_exact_stellar_payload_has_subinvocations",
      );
    });

    test("validates a V2 entry after a base64 XDR round trip", () => {
      const encoded = authEntry("addressV2", PAYER, { signed: true }).toXdr(
        "base64",
      );
      const decoded = xdr.SorobanAuthorizationEntry.fromXdr(encoded, "base64");

      expect(decoded.credentials.type).toBe("sorobanCredentialsAddressV2");
      expect(validateAuthEntries([decoded], FACILITATOR)).toBeNull();
      expect(getSignedAddressesFromAuthEntries([decoded])).toEqual({
        signedAddresses: [PAYER],
        unsignedAddresses: [],
      });
    });
  });

  describe("getAllAddressesFromAuthEntries", () => {
    test("collects addresses across all address-bearing variants", () => {
      const entries = [
        authEntry("address", PAYER),
        authEntry("addressV2", PAYEE),
        authEntry("addressWithDelegates", FACILITATOR),
        authEntry("sourceAccount"),
      ];
      expect(getAllAddressesFromAuthEntries(entries)).toEqual([
        PAYER,
        PAYEE,
        FACILITATOR,
      ]);
    });
  });

  describe("isSignaturePresent", () => {
    test.each<[SignatureShape, boolean]>([
      ["void", false],
      ["emptyVec", false],
      ["nullVec", false],
      ["signed", true],
    ])("%s signature -> %s", (shape, expected) => {
      expect(isSignaturePresent(SIGNATURES[shape]())).toBe(expected);
    });

    test("treats non-vec, non-void values as signed", () => {
      expect(
        isSignaturePresent(xdr.ScVal.scvBytes(new Uint8Array(64).fill(1))),
      ).toBe(true);
    });
  });

  describe("getSignedAddressesFromAuthEntries", () => {
    test("splits signed and unsigned entries for V1 and V2", () => {
      const entries = [
        authEntry("address", PAYER, { signed: true }),
        authEntry("addressV2", PAYEE, { signed: false }),
        authEntry("sourceAccount"),
      ];
      expect(getSignedAddressesFromAuthEntries(entries)).toEqual({
        signedAddresses: [PAYER],
        unsignedAddresses: [PAYEE],
      });
    });

    test.each<CredentialVariant>(["address", "addressV2"])(
      "treats the empty scvVec placeholder as unsigned on %s",
      (variant) => {
        const entries = [
          authEntry(variant, PAYER, { signature: "emptyVec" }),
          authEntry(variant, PAYEE, { signature: "nullVec" }),
          authEntry(variant, FACILITATOR, { signature: "signed" }),
        ];
        expect(getSignedAddressesFromAuthEntries(entries)).toEqual({
          signedAddresses: [FACILITATOR],
          unsignedAddresses: [PAYER, PAYEE],
        });
      },
    );

    test("detects the empty-vec placeholder after an XDR round trip", () => {
      // stellar-sdk authorizeInvocation writes scvVec([]) before signing
      const placeholder = authEntry("addressV2", PAYER, {
        signature: "emptyVec",
      });
      const decoded = xdr.SorobanAuthorizationEntry.fromXdr(
        placeholder.toXdr("base64"),
        "base64",
      );
      expect(getSignedAddressesFromAuthEntries([decoded])).toEqual({
        signedAddresses: [],
        unsignedAddresses: [PAYER],
      });
    });
  });

  describe("getExpirationLedgersFromAuthEntries", () => {
    test("reads expiration ledgers from V1 and V2 entries", () => {
      const entries = [
        authEntry("address", PAYER, { expirationLedger: 111 }),
        authEntry("addressV2", PAYER, { expirationLedger: 222 }),
        authEntry("sourceAccount"),
      ];
      expect(getExpirationLedgersFromAuthEntries(entries)).toEqual([111, 222]);
    });
  });

  describe("scValToJsonArg", () => {
    test("converts every supported ScVal variant", () => {
      expect(scValToJsonArg(new Address(PAYER).toScVal())).toEqual({
        address: PAYER,
      });
      expect(
        scValToJsonArg(
          xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: -1n, lo: 5n })),
        ),
      ).toEqual({ i128: { hi: "-1", lo: "5" } });
      expect(
        scValToJsonArg(
          xdr.ScVal.scvU128(new xdr.Uint128Parts({ hi: 1n, lo: 2n })),
        ),
      ).toEqual({ u128: { hi: "1", lo: "2" } });
      expect(scValToJsonArg(xdr.ScVal.scvI64(-7n))).toEqual({ i64: "-7" });
      expect(scValToJsonArg(xdr.ScVal.scvU64(7n))).toEqual({ u64: "7" });
      expect(scValToJsonArg(xdr.ScVal.scvI32(-3))).toEqual({ i32: -3 });
      expect(scValToJsonArg(xdr.ScVal.scvU32(3))).toEqual({ u32: 3 });
      expect(scValToJsonArg(xdr.ScVal.scvBool(true))).toEqual({ bool: true });
      expect(scValToJsonArg(xdr.ScVal.scvString("hello"))).toEqual({
        string: "hello",
      });
      expect(scValToJsonArg(xdr.ScVal.scvSymbol("transfer"))).toEqual({
        symbol: "transfer",
      });
      expect(
        scValToJsonArg(xdr.ScVal.scvBytes(new Uint8Array([0, 1, 255]))),
      ).toEqual({ bytes: "0001ff" });
      expect(
        scValToJsonArg(
          xdr.ScVal.scvVec([xdr.ScVal.scvU32(1), xdr.ScVal.scvBool(false)]),
        ),
      ).toEqual({ vec: [{ u32: 1 }, { bool: false }] });
      expect(
        scValToJsonArg(
          xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol("k"),
              val: xdr.ScVal.scvU64(9n),
            }),
          ]),
        ),
      ).toEqual({ map: [{ key: { symbol: "k" }, val: { u64: "9" } }] });
    });

    test("matches nativeToScVal i128 encoding for transfer amounts", () => {
      expect(scValToJsonArg(nativeToScVal(100n, { type: "i128" }))).toEqual({
        i128: { hi: "0", lo: "100" },
      });
    });
  });

  describe("transaction envelope (verify/settle parsing path)", () => {
    test("parses a real invokeHostFunction envelope carrying a V2 auth entry", () => {
      const entry = authEntry("addressV2", PAYER, { signed: true });
      const built = new TransactionBuilder(new Account(PAYER, "0"), {
        fee: "100000",
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: TOKEN_CONTRACT,
            function: "transfer",
            args: [
              new Address(PAYER).toScVal(),
              new Address(PAYEE).toScVal(),
              nativeToScVal(100n, { type: "i128" }),
            ],
            auth: [entry],
          }),
        )
        .setTimeout(30)
        .build();

      // Same decode step verify() and settle() perform on the payload
      const transaction = new Transaction(built.toXdr(), Networks.TESTNET);

      expect(transaction.signatures).toHaveLength(0);
      expect(transaction.operations).toHaveLength(1);

      const operation = transaction
        .operations[0] as Operation.InvokeHostFunction;
      expect(operation.type).toBe("invokeHostFunction");

      const func = operation.func;
      expect(func.type).toBe("hostFunctionTypeInvokeContract");
      if (func.type !== "hostFunctionTypeInvokeContract") return;

      const invokeContractArgs = func.invokeContract;
      expect(
        Address.fromScAddress(invokeContractArgs.contractAddress).toString(),
      ).toBe(TOKEN_CONTRACT);
      expect(invokeContractArgs.functionName.toString()).toBe("transfer");
      expect(invokeContractArgs.args).toHaveLength(3);
      expect(scValToNative(invokeContractArgs.args[0])).toBe(PAYER);
      expect(scValToNative(invokeContractArgs.args[1])).toBe(PAYEE);
      expect(scValToNative(invokeContractArgs.args[2])).toBe(100n);

      const authEntries = operation.auth ?? [];
      expect(authEntries).toHaveLength(1);
      expect(authEntries[0].credentials.type).toBe(
        "sorobanCredentialsAddressV2",
      );
      expect(validateAuthEntries(authEntries, FACILITATOR)).toBeNull();
      expect(getSignedAddressesFromAuthEntries(authEntries)).toEqual({
        signedAddresses: [PAYER],
        unsignedAddresses: [],
      });
      expect(getExpirationLedgersFromAuthEntries(authEntries)).toEqual([1000]);
      expect(authEntries[0].toXdr("base64")).toBe(entry.toXdr("base64"));
      expect(typeof func.toXdr("base64")).toBe("string");
    });
  });

  describe("parseTransferEventsFromSimulation", () => {
    test("parses a SEP-41 transfer event from decoded and base64 forms", () => {
      const event = transferEvent();
      const expected = {
        transferEvents: [
          { contractId: TOKEN_CONTRACT, from: PAYER, to: PAYEE, amount: 250n },
        ],
        nonTransferContractEventDetected: false,
        missingContractIdDetected: false,
      };

      expect(parseTransferEventsFromSimulation([event])).toEqual(expected);
      expect(
        parseTransferEventsFromSimulation([event.toXdr("base64")]),
      ).toEqual(expected);
    });

    test("skips system and diagnostic events", () => {
      const result = parseTransferEventsFromSimulation([
        transferEvent({ type: xdr.ContractEventType.system, contractId: null }),
        transferEvent({ type: xdr.ContractEventType.diagnostic }),
      ]);
      expect(result.transferEvents).toEqual([]);
      expect(result.nonTransferContractEventDetected).toBe(false);
      expect(result.missingContractIdDetected).toBe(false);
    });

    test("flags contract events without a contract id", () => {
      const result = parseTransferEventsFromSimulation([
        transferEvent({ contractId: null }),
      ]);
      expect(result.transferEvents).toEqual([]);
      expect(result.missingContractIdDetected).toBe(true);
    });

    test("flags non-transfer contract events", () => {
      const result = parseTransferEventsFromSimulation([
        transferEvent({
          topics: [
            xdr.ScVal.scvSymbol("approve"),
            new Address(PAYER).toScVal(),
            new Address(PAYEE).toScVal(),
          ],
        }),
      ]);
      expect(result.transferEvents).toEqual([]);
      expect(result.nonTransferContractEventDetected).toBe(true);
    });
  });
});
