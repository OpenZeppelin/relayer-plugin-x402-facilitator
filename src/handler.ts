/**
 * X402 Facilitator plugin
 *
 * This plugin implements the X402 Facilitator API.
 *
 * Example API calls:
 * - POST /api/v1/plugins/{plugin_id}/call          -> Default handler (route = "")
 * - POST /api/v1/plugins/{plugin_id}/call/verify   -> Verify endpoint (route = "/verify")
 * - POST /api/v1/plugins/{plugin_id}/call/settle   -> Settle endpoint (route = "/settle")
 * - POST /api/v1/plugins/{plugin_id}/call/supported   -> Supported endpoint (route = "/supported", GET also works with allow_get_invocation)
 */

import { PluginAPI, PluginError } from "@openzeppelin/relayer-sdk";
import type {
  NetworkConfig,
  PluginContext,
  SettleRequest,
  SettleResponse,
  SupportedPaymentKindsResponse,
  VerifyRequest,
  VerifyResponse,
  X402PluginConfig,
} from "./types";
import {
  settle as handleSettleStellar,
  verify as handleVerifyStellar,
} from "./stellar";

import { getNetworkConfigByNetwork } from "./utils";
import { validateVerifyRequest, validateSettleRequest } from "./stellar/utils";

export async function handler(context: PluginContext) {
  const { route, params, api, config } = context;

  if (!config) {
    throw new Error("X402 plugin config not found");
  }

  const x402PluginConfig = config as X402PluginConfig;

  // Route based on the route
  switch (route) {
    case "":
    case "/":
      return handleDefault();

    case "/verify":
      return handleVerify(params, api, x402PluginConfig);

    case "/settle":
      return handleSettle(params, api, x402PluginConfig);

    case "/supported":
      return handleSupported(api, x402PluginConfig);

    default: {
      // Return 404 for unknown routes
      const error: PluginError = new Error(`Unknown route: ${route}`);
      error.status = 404;
      error.code = "NOT_FOUND";
      throw error;
    }
  }
}

/**
 * Default endpoint handler
 */
function handleDefault() {
  return {
    message: "OpenZeppelin Relayer X402 Facilitator Plugin",
    availableEndpoints: [
      "/verify - Verify a transaction",
      "/settle - Settle a transaction",
      "/supported - Get supported tokens",
    ],
  };
}

/**
 * Verify endpoint handler
 */
async function handleVerify(
  params: VerifyRequest,
  api: PluginAPI,
  config: X402PluginConfig,
): Promise<VerifyResponse> {
  if (!validateVerifyRequest(params)) {
    return { isValid: false, invalidReason: "invalid_exact_payload_malformed" };
  }

  const networkConfig = getNetworkConfigByNetwork(
    config,
    params.paymentRequirements.network,
  );

  if (!networkConfig) {
    return { isValid: false, invalidReason: "unsupported_network" };
  }

  switch (networkConfig.type) {
    case "stellar":
      return handleVerifyStellar(params, api, networkConfig);
    default:
      return { isValid: false, invalidReason: "unsupported_network" };
  }
}

/**
 * Settle endpoint handler
 */
async function handleSettle(
  params: SettleRequest,
  api: PluginAPI,
  config: X402PluginConfig,
): Promise<SettleResponse> {
  if (!validateSettleRequest(params)) {
    return {
      success: false,
      errorReason: "invalid_exact_payload_malformed",
      transaction: "",
      network: "",
    };
  }

  const networkConfig = getNetworkConfigByNetwork(
    config,
    params.paymentRequirements.network,
  );
  if (!networkConfig) {
    return {
      success: false,
      errorReason: "unsupported_network",
      transaction: "",
      network: "",
    };
  }

  switch (networkConfig.type) {
    case "stellar":
      return handleSettleStellar(params, api, networkConfig);
    default:
      return {
        success: false,
        errorReason: "unsupported_network",
        transaction: "",
        network: "",
      };
  }
}

/**
 * Supported endpoint handler
 * Returns supported payment kinds in v2 format with version-grouped kinds, signers, and extensions
 */
async function handleSupported(
  api: PluginAPI,
  config: X402PluginConfig,
): Promise<SupportedPaymentKindsResponse> {
  // Fetch relayer info for each network in parallel
  const networkPromises = config.networks.map(
    async (networkConfig: NetworkConfig) => {
      let relayerAddress: string | undefined =
        networkConfig.channel_service_fund_relayer_address;

      if (!relayerAddress) {
        try {
          const relayer = api.useRelayer(networkConfig.relayer_id);
          const relayerInfo = await relayer.getRelayer();
          relayerAddress = relayerInfo.address;
        } catch (error) {
          console.error(
            `Failed to get relayer info for ${networkConfig.network}:`,
            error,
          );
        }
      }

      const extra = { areFeesSponsored: true };

      return {
        networkConfig,
        kind: {
          x402Version: 2 as const,
          scheme: "exact" as const,
          network: networkConfig.network,
          extra,
        },
        relayerAddress,
      };
    },
  );

  const networkResults = await Promise.all(networkPromises);

  // Build kinds array with version included in each kind
  const kinds = networkResults.map((result) => result.kind);

  // Build signers map: group by network pattern
  // For now, we'll use exact network matches, but could support wildcards like "stellar:*"
  const signers: { [networkPattern: string]: string[] } = {};
  for (const result of networkResults) {
    if (result.relayerAddress) {
      const networkPattern = result.networkConfig.network;
      if (!signers[networkPattern]) {
        signers[networkPattern] = [];
      }
      if (!signers[networkPattern].includes(result.relayerAddress)) {
        signers[networkPattern].push(result.relayerAddress);
      }
    }
  }

  // Extensions supported by this facilitator
  // Currently empty, but can be extended in the future (e.g., ["discovery"])
  const extensions: string[] = [];

  return {
    kinds,
    signers: Object.keys(signers).length > 0 ? signers : undefined,
    extensions: extensions.length > 0 ? extensions : undefined,
  };
}
