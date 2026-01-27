import { describe, expect, test } from "vitest";

import type { X402PluginConfig } from "../src/types";
import { getNetworkConfigByNetwork } from "../src/utils";

describe("utils", () => {
  const config: X402PluginConfig = {
    networks: [
      {
        network: "stellar:testnet",
        type: "stellar",
        relayer_id: "relayer-1",
        assets: ["ASSET1"],
      },
      {
        network: "stellar",
        type: "stellar",
        relayer_id: "relayer-2",
        assets: ["ASSET2"],
      },
    ],
  };

  describe("getNetworkConfigByNetwork", () => {
    test("returns network config when found", () => {
      const result = getNetworkConfigByNetwork(config, "stellar:testnet");
      expect(result).toBeDefined();
      expect(result?.network).toBe("stellar:testnet");
      expect(result?.relayer_id).toBe("relayer-1");
    });

    test("returns undefined when network not found", () => {
      const result = getNetworkConfigByNetwork(config, "unknown-network");
      expect(result).toBeUndefined();
    });

    test("handles empty networks array", () => {
      const emptyConfig: X402PluginConfig = { networks: [] };
      const result = getNetworkConfigByNetwork(emptyConfig, "stellar:testnet");
      expect(result).toBeUndefined();
    });

    test("returns first match when multiple networks have same name", () => {
      const duplicateConfig: X402PluginConfig = {
        networks: [
          {
            network: "stellar:testnet",
            type: "stellar",
            relayer_id: "relayer-1",
            assets: ["ASSET1"],
          },
          {
            network: "stellar:testnet",
            type: "stellar",
            relayer_id: "relayer-2",
            assets: ["ASSET2"],
          },
        ],
      };
      const result = getNetworkConfigByNetwork(
        duplicateConfig,
        "stellar:testnet",
      );
      expect(result?.relayer_id).toBe("relayer-1");
    });
  });
});
