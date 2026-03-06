import {
  PluginAPI,
  PluginHeaders,
  PluginKVStore,
} from "@openzeppelin/relayer-sdk";

// Core enums/unions
export const schemes = ["exact"] as const;
export type Scheme = (typeof schemes)[number];

export const x402Versions = [2] as const;
export type X402Version = (typeof x402Versions)[number];

export type Network = string;

// Payload subtypes
export type ExactEvmPayloadAuthorization = {
  from: string;
  to: string;
  value: string; // integer string
  validAfter: string; // integer string
  validBefore: string; // integer string
  nonce: string; // hex string
};

export type ExactEvmPayload = {
  signature: string; // hex signature
  authorization: ExactEvmPayloadAuthorization;
};

export type ExactSvmPayload = {
  transaction: string; // base64 transaction
};

export type ExactStellarPayloadV2 = {
  transaction: string; // base64 transaction
};

// Payment payload v2 (v1 is not supported - use previous version for v1)
export type PaymentPayload = {
  x402Version: 2;
  accepted: PaymentRequirements;
  payload: ExactEvmPayload | ExactSvmPayload | ExactStellarPayloadV2;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extensions?: Record<string, any>;
};

export type UnsignedPaymentPayload = Omit<PaymentPayload, "payload"> & {
  payload: Omit<ExactEvmPayload, "signature"> & { signature: undefined };
};

// Payment requirements (v2 format - resource, description, mimeType moved to PaymentRequired)
export type PaymentRequirements = {
  scheme: Scheme;
  network: Network;
  amount: string; // integer string
  payTo: string; // account address or constant (e.g., "merchant")
  maxTimeoutSeconds: number;
  asset: string; // account or asset address, or ISO 4217 currency code
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra: { areFeesSponsored: boolean } & Record<string, any>;
};

// PaymentRequired (top-level response in v2)
export type PaymentRequired = {
  x402Version: X402Version;
  error?: string;
  resource: {
    url: string;
    description: string;
    website?: string;
    mimeType: string;
  };
  accepts: PaymentRequirements[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extensions?: Record<string, any>;
};

// Requests
export type SettleRequest = {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
};

export type VerifyRequest = {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
};

// Responses
export type VerifyResponse = {
  isValid: boolean;
  invalidReason?: string;
  payer?: string; // account address
};

export type SettleResponse = {
  success: boolean;
  errorReason?: string;
  payer?: string; // account address
  transaction: string; // tx id/address
  network: Network;
};

// Supported payment kinds (v1 format)
export type SupportedPaymentKind = {
  x402Version: X402Version;
  scheme: Scheme;
  network: Network;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra?: Record<string, any>;
};

// Supported payment kind without version (used in v2 grouped format)
export type SupportedPaymentKindV2 = {
  scheme: Scheme;
  network: Network;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra?: Record<string, any>;
};

// Supported payment kinds response
export type SupportedPaymentKindsResponse = {
  kinds: SupportedPaymentKind[];
  extensions?: string[];
  signers?: {
    [networkPattern: string]: string[];
  };
};

export type NetworkConfig = {
  network: Network;
  type: ConfigNetwork;
  relayer_id: string;
  assets: string[];
  channel_service_api_url?: string;
  channel_service_api_key?: string;
  channel_service_fund_relayer_id?: string;
  channel_service_fund_relayer_address?: string;
  maxTransactionFeeStroops?: string;
};

export type ConfigNetwork = "stellar" | "evm" | "solana";

export type X402PluginConfig = {
  networks: NetworkConfig[];
};

export interface PluginContext {
  api: PluginAPI;
  kv: PluginKVStore;
  headers: PluginHeaders;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any;
  route: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: Record<string, any>;
  method: string;
  query: Record<string, string[]>;
}
