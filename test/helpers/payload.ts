export type TxBuildOptions = {
  payer?: string;
  payTo?: string;
  amount?: bigint | number | string;
  asset?: string;
  authEntries?: any[];
  signatures?: any[];
  source?: string;
  opSource?: string;
  fee?: string;
  funcOverrides?: Partial<{
    contractAddress: () => string;
    functionName: () => Buffer;
    args: () => any[];
  }>;
};

/**
 * Builds a minimal invokeHostFunction transaction encoded as base64 JSON.
 * This is consumed by the mocked Transaction constructor in tests.
 *
 * Note: We use a special marker to indicate this is a test transaction
 * and include the full operation object with functions intact.
 */
export function buildInvokeTxBase64(options: TxBuildOptions = {}): string {
  const {
    payer = "G-PAYER",
    payTo = "G-PAYEE",
    amount = 200n,
    asset = "ASSET_CONTRACT",
    authEntries = [{ toXDR: () => "AUTHXDR" }],
    signatures = [],
    source = "CLIENT_SOURCE",
    opSource,
    fee = "100000",
    funcOverrides,
  } = options;

  const amountStr = BigInt(amount).toString(); // avoid BigInt in JSON

  const invokeContractData = {
    contractAddress: () => asset,
    functionName: () => Buffer.from("transfer"),
    args: () => [{ value: payer }, { value: payTo }, { value: amountStr }],
    ...funcOverrides,
  };

  const func = {
    switch: () => ({ name: "hostFunctionTypeInvokeContract" }),
    invokeContract: () => invokeContractData,
    toXDR: () => "FUNCXDR",
  };

  const operation = {
    type: "invokeHostFunction",
    func,
    auth: authEntries,
    source: opSource,
  };

  const txData = {
    __testTransaction: true,
    operations: [operation],
    signatures,
    source,
    fee,
  };

  // Store in global for mock to access
  (global as any).__testTxData = txData;

  // Return a marker that the mock can recognize
  return Buffer.from(JSON.stringify({ __testTransaction: true })).toString(
    "base64",
  );
}

export function buildPaymentRequirements(
  overrides: Partial<{
    network: string;
    asset: string;
    payTo: string;
    maxAmountRequired: string;
  }> = {},
) {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    maxAmountRequired: "100",
    resource: "/resource",
    description: "test",
    mimeType: "application/json",
    payTo: "G-PAYEE",
    maxTimeoutSeconds: 30,
    asset: "ASSET_CONTRACT",
    ...overrides,
  };
}

export function buildPaymentPayload(
  txBase64: string,
  overrides: Partial<{ network: string }> = {},
) {
  return {
    x402Version: 1,
    scheme: "exact",
    network: "stellar:testnet",
    payload: {
      transaction: txBase64,
    },
    ...overrides,
  };
}

export function buildPaymentRequirementsV2(
  overrides: Partial<{
    scheme: string;
    network: string;
    asset: string;
    payTo: string;
    amount: string;
    maxTimeoutSeconds: number;
  }> = {},
) {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    amount: "100",
    payTo: "G-PAYEE",
    maxTimeoutSeconds: 30,
    asset: "ASSET_CONTRACT",
    extra: { areFeesSponsored: true },
    ...overrides,
  };
}

export function buildPaymentPayloadV2(
  txBase64: string,
  acceptedOverrides: Partial<{
    scheme: string;
    network: string;
    asset: string;
    payTo: string;
    amount: string;
  }> = {},
  payloadOverrides: Partial<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extensions?: Record<string, any>;
  }> = {},
) {
  const accepted = buildPaymentRequirementsV2(acceptedOverrides);
  return {
    x402Version: 2,
    accepted,
    payload: {
      transaction: txBase64,
    },
    ...payloadOverrides,
  };
}
