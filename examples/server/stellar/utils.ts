import type { Network } from "@x402/core/types";
import {
  STELLAR_PUBNET_CAIP2,
  STELLAR_TESTNET_CAIP2,
  USDC_PUBNET_ADDRESS,
  USDC_TESTNET_ADDRESS,
  DEFAULT_TOKEN_DECIMALS,
} from "./constants";

/**
 * Converts a decimal amount string to token smallest-unit amount.
 *
 * @param decimalAmount - The decimal amount (e.g., "0.001")
 * @param decimals - Number of decimal places for the token (default: 7 for USDC on Stellar)
 * @returns The amount in smallest units as a string
 */
export function convertToTokenAmount(
  decimalAmount: string,
  decimals: number = DEFAULT_TOKEN_DECIMALS,
): string {
  const amount = parseFloat(decimalAmount);
  if (isNaN(amount)) {
    throw new Error(`Invalid amount: ${decimalAmount}`);
  }

  if (decimals < 0 || decimals > 20) {
    throw new Error(`Decimals must be between 0 and 20, got ${decimals}`);
  }

  // Normalize scientific notation to fixed decimal string
  const normalizedDecimal = /[eE]/.test(decimalAmount)
    ? amount.toFixed(Math.max(decimals, 20))
    : decimalAmount;

  const [intPart, decPart = ""] = normalizedDecimal.split(".");
  const paddedDec = decPart.padEnd(decimals, "0").slice(0, decimals);

  return (intPart + paddedDec).replace(/^0+/, "") || "0";
}

/**
 * Gets the default USDC contract address for a network.
 *
 * @param network - The CAIP-2 network identifier
 * @returns The USDC contract address for the network
 * @throws {Error} If the network doesn't have a configured USDC address
 */
export function getUsdcAddress(network: Network): string {
  switch (network) {
    case STELLAR_PUBNET_CAIP2:
      return USDC_PUBNET_ADDRESS;
    case STELLAR_TESTNET_CAIP2:
      return USDC_TESTNET_ADDRESS;
    default:
      throw new Error(`No USDC address configured for network: ${network}`);
  }
}
