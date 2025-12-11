/**
 * X402 Facilitator plugin
 *
 * This plugin implements the X402 Facilitator API.
 *
 * Example API calls:
 * - POST /api/v1/plugins/{plugin_id}/call          -> Default handler (route = "")
 * - POST /api/v1/plugins/{plugin_id}/call/verify   -> Verify endpoint (route = "/verify")
 * - POST /api/v1/plugins/{plugin_id}/call/settle   -> Settle endpoint (route = "/settle")
 * - POST /api/v1/plugins/{plugin_id}/call/supported   -> Supported endpoint (route = "/supported")
 */

import {
  JsonRpcRequestNetworkRpcRequest,
  PluginAPI,
  PluginError,
} from "@openzeppelin/relayer-sdk";
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
  const networkConfig = getNetworkConfigByNetwork(
    config,
    params.paymentRequirements.network,
  );

  if (!networkConfig) {
    throw new Error(
      `Network config not found for network: ${params.paymentRequirements.network}`,
    );
  }

  switch (networkConfig.type) {
    case "stellar":
      return handleVerifyStellar(params, api, networkConfig);
    default:
      throw new Error(`Unsupported network type: ${networkConfig.type}`);
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
  const networkConfig = getNetworkConfigByNetwork(
    config,
    params.paymentRequirements.network,
  );
  if (!networkConfig) {
    throw new Error(
      `Network config not found for network: ${params.paymentRequirements.network}`,
    );
  }

  switch (networkConfig.type) {
    case "stellar":
      return handleSettleStellar(params, api, networkConfig);
    default:
      throw new Error(`Unsupported network type: ${networkConfig.type}`);
  }
}

/**
 * Gets the latest ledger number from the Stellar network
 */
async function getLatestLedger(
  api: PluginAPI,
  relayerId: string,
): Promise<number> {
  const relayer = api.useRelayer(relayerId);

  const response = await relayer.rpc({
    method: "getLatestLedger",
    id: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
    jsonrpc: "2.0",
  } as JsonRpcRequestNetworkRpcRequest);

  if (response.error) {
    throw new Error(`Failed to get latest ledger: ${response.error.message}`);
  }

  return response.result.sequence;
}

/**
 * Supported endpoint handler
 * Returns supported payment kinds with current max ledger for each network
 */
async function handleSupported(
  api: PluginAPI,
  config: X402PluginConfig,
): Promise<SupportedPaymentKindsResponse> {
  // Fetch latest ledger for each Stellar network in parallel
  const kindsPromises = config.networks.map(
    async (networkConfig: NetworkConfig) => {
      let maxLedger: string | undefined;

      // For Stellar networks, get the current ledger and add buffer
      if (networkConfig.type === "stellar") {
        try {
          const latestLedger = await getLatestLedger(
            api,
            networkConfig.relayer_id,
          );
          // Add 12 ledgers as buffer (approximately 1 minute on Stellar)
          maxLedger = (latestLedger + 12).toString();
        } catch (error) {
          console.error(
            `Failed to get latest ledger for ${networkConfig.network}:`,
            error,
          );
          // Fallback: don't include maxLedger if we can't fetch it
        }
      }

      return {
        x402Version: 1 as const,
        scheme: "exact" as const,
        network: networkConfig.network,
        extra: maxLedger ? { maxLedger } : {},
      };
    },
  );

  const kinds = await Promise.all(kindsPromises);

  return { kinds };
}
