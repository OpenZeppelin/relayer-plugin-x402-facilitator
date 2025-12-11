import { NetworkConfig, X402PluginConfig } from "./types";

export function getNetworkConfigByNetwork(
  config: X402PluginConfig,
  network: string,
): NetworkConfig | undefined {
  return (
    config.networks.find(
      (networkConfig: NetworkConfig) => networkConfig.network === network,
    ) ?? undefined
  );
}
