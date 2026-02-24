import { StrKey } from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";
import type { Network } from "@x402/core/types";
import {
  STELLAR_TESTNET_CAIP2,
  STELLAR_PUBNET_CAIP2,
  STELLAR_NETWORK_TO_PASSPHRASE,
  STELLAR_ASSET_ADDRESS_REGEX,
} from "./constants";

const DEFAULT_TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
const DEFAULT_ESTIMATED_LEDGER_SECONDS = 5;
const RPC_LEDGERS_SAMPLE_SIZE = 10;

export interface RpcConfig {
  url?: string;
}

/**
 * Checks if a network identifier is a known Stellar network.
 */
export function isStellarNetwork(network: string): boolean {
  return STELLAR_NETWORK_TO_PASSPHRASE.has(network);
}

/**
 * Gets the network passphrase for a given Stellar network.
 *
 * @param network - The CAIP-2 network identifier
 * @returns The network passphrase string
 * @throws {Error} If the network is not a known Stellar network
 */
export function getNetworkPassphrase(network: Network): string {
  const networkPassphrase = STELLAR_NETWORK_TO_PASSPHRASE.get(network);
  if (!networkPassphrase) {
    throw new Error(`Unknown Stellar network: ${network}`);
  }
  return networkPassphrase;
}

/**
 * Gets the RPC URL for a given Stellar network.
 *
 * @param network - The CAIP-2 network identifier
 * @param rpcConfig - Optional RPC configuration with custom URL
 * @returns The RPC URL string
 * @throws {Error} If the network is unknown or mainnet RPC URL is not provided
 */
export function getRpcUrl(network: Network, rpcConfig?: RpcConfig): string {
  const customRpcUrl = rpcConfig?.url;
  switch (network) {
    case STELLAR_TESTNET_CAIP2:
      return customRpcUrl || DEFAULT_TESTNET_RPC_URL;
    case STELLAR_PUBNET_CAIP2:
      if (!customRpcUrl) {
        throw new Error(
          "Stellar mainnet requires a non-empty rpcUrl. For a list of RPC providers, see https://developers.stellar.org/docs/data/apis/rpc/providers#publicly-accessible-apis",
        );
      }
      return customRpcUrl;
    default:
      throw new Error(`Unknown Stellar network: ${network}`);
  }
}

/**
 * Creates a Soroban RPC client for the given network.
 *
 * @param network - The CAIP-2 network identifier
 * @param rpcConfig - Optional RPC configuration with custom URL
 * @returns A configured Soroban RPC Server instance
 * @throws {Error} If the network is not a valid Stellar network
 */
export function getRpcClient(network: Network, rpcConfig?: RpcConfig): Server {
  const rpcUrl = getRpcUrl(network, rpcConfig);
  return new Server(rpcUrl, {
    allowHttp: network === STELLAR_TESTNET_CAIP2,
  });
}

/**
 * Fetches the estimated ledger close time (seconds per ledger) from RPC getLedgers.
 *
 * @param server - The Soroban RPC Server instance
 * @returns Estimated seconds per ledger, or DEFAULT_ESTIMATED_LEDGER_SECONDS (5) on error
 */
export async function getEstimatedLedgerCloseTimeSeconds(server: Server): Promise<number> {
  try {
    const latestLedger = await server.getLatestLedger();
    const startLedger = latestLedger.sequence;
    const { ledgers } = await server.getLedgers({
      startLedger,
      pagination: { limit: RPC_LEDGERS_SAMPLE_SIZE },
    });
    if (!ledgers || ledgers.length < 2) return DEFAULT_ESTIMATED_LEDGER_SECONDS;

    const oldestTs = parseInt(ledgers[0].ledgerCloseTime);
    const newestTs = parseInt(ledgers[ledgers.length - 1].ledgerCloseTime);
    const intervals = ledgers.length - 1;
    return Math.ceil((newestTs - oldestTs) / intervals);
  } catch {
    return DEFAULT_ESTIMATED_LEDGER_SECONDS;
  }
}

/**
 * Validates a Stellar destination address (G-account or C-account).
 */
export function validateStellarDestinationAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address);
}

/**
 * Validates a Stellar asset contract address (C-account).
 */
export function validateStellarAssetAddress(asset: string): boolean {
  return STELLAR_ASSET_ADDRESS_REGEX.test(asset);
}
