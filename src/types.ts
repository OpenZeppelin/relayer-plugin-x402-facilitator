import {
  PluginAPI,
  PluginHeaders,
  PluginKVStore,
} from "@openzeppelin/relayer-sdk";

// Core enums/unions
export const schemes = ["exact"] as const;
export type Scheme = (typeof schemes)[number];

export const x402Versions = [1] as const;
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

export type ExactStellarPayload = {
  transaction: string; // base64 transaction
};

// Payment payload
export type PaymentPayload = {
  x402Version: X402Version;
  scheme: Scheme;
  network: Network;
  payload: ExactEvmPayload | ExactSvmPayload | ExactStellarPayload;
};

export type UnsignedPaymentPayload = Omit<PaymentPayload, "payload"> & {
  payload: Omit<ExactEvmPayload, "signature"> & { signature: undefined };
};

// Payment requirements
export type PaymentRequirements = {
  scheme: Scheme;
  network: Network;
  maxAmountRequired: string; // integer string
  resource: string; // URL
  description: string;
  mimeType: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outputSchema?: Record<string, any>;
  payTo: string; // account address
  maxTimeoutSeconds: number;
  asset: string; // account or asset address
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra?: Record<string, any>;
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

// Supported payment kinds
export type SupportedPaymentKind = {
  x402Version: X402Version;
  scheme: Scheme;
  network: Network;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra?: Record<string, any>;
};

export type SupportedPaymentKindsResponse = {
  kinds: SupportedPaymentKind[];
};

export type NetworkConfig = {
  network: Network;
  type: ConfigNetwork;
  relayer_id: string;
  assets: string[];
  channel_service_api_url?: string;
  channel_service_api_key?: string;
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
