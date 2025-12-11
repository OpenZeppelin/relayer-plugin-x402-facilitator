# x402 Facilitator Relayer Plugin

OpenZeppelin Relayer plugin that implements the x402 facilitator API so you can serve x402 payments directly from a Relayer instance. Works with the Coinbase x402 ecosystem (e.g., `x402-express`) and exposes the expected `/verify`, `/settle`, and `/supported` endpoints under the Relayer plugin router.

## What you get

- x402 facilitator API implemented as a Relayer plugin (Stellar support today)
- Uses your Relayer accounts/signers to verify and settle payments
- Supports multiple networks via config, including allowed assets per network
- Optional channel service integration for Stellar throughput

## Prerequisites

- Node.js 18+
- pnpm 10+
- An OpenZeppelin Relayer with at least one configured relayer account for each network you plan to serve

## Install

```bash
# inside your relayer repo
pnpm add @openzeppelin/relayer-plugin-x402-facilitator
```

For local development of the plugin itself:

```bash
pnpm install
pnpm build
```

## Wire it into the Relayer

1. Create a plugin wrapper (example path).

```
plugins/x402/index.ts
```

```ts
export { handler } from "@openzeppelin/relayer-plugin-x402-facilitator";
```

2. Add the plugin entry to your Relayer `config.json` (adjust `path` to your wrapper location or to the provided example file if you copied it, e.g., `examples/x402-facilitator/handler.ts`):

```json
{
  "plugins": [
    {
      "id": "x402",
      "path": "plugins/x402/index.ts",
      "emit_logs": false,
      "emit_traces": false,
      "raw_response": true,
      "allow_get_invocation": true,
      "timeout": 30,
      "config": {
        "networks": [
          {
            "network": "stellar-testnet",
            "type": "stellar",
            "relayer_id": "stellar-example",
            "assets": [
              "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
            ]
          }
        ]
      }
    }
  ]
}
```

### Network config reference

Each object in `config.networks`:

- `network`: x402 network identifier (e.g., `stellar-testnet`)
- `type`: `"stellar"` (current support)
- `relayer_id`: ID of the Relayer account to use for this network
- `assets`: list of allowed assets (issuer addresses for Stellar)
- `channel_service_api_url` / `channel_service_api_key` (optional): enable channel service acceleration for Stellar

### Exposed routes

All routes hang off the Relayer plugin call endpoint: `POST /api/v1/plugins/{plugin_id}/call{route}`.

- `/` or ``: info
- `/verify`: x402 verify
- `/settle`: x402 settle
- `/supported`: discovery of supported payment kinds

## Using with x402 packages (e.g., x402-express)

Point the facilitator to your Relayer plugin URL and pass the Relayer API key via `createAuthHeaders`.

```ts
import { paymentMiddleware } from "x402-express";

const facilitatorUrl = "https://your-relayer-host/api/v1/plugins/x402/call";
const network = "stellar-testnet";
const payTo = "G..."; // Payment receiver G address

app.use(
  paymentMiddleware(
    payTo,
    {
      "GET /weather": {
        // USDC amount in dollars
        price: "$0.001",
        network,
      },
      "/premium/*": {
        // Define atomic amounts in any EIP-3009 token
        price: {
          amount: "0.1",
          asset: {
            address: "0xabc",
            decimals: 18,
            // omit eip712 for Solana
            eip712: {
              name: "WETH",
              version: "1",
            },
          },
        },
        network,
      },
    },
    {
      url: facilitatorUrl,
      createAuthHeaders: async () => ({
        // Use your Relayer API key for the plugin
        verify: { Authorization: "Bearer RELAYER_API_KEY" },
        settle: { Authorization: "Bearer RELAYER_API_KEY" },
        supported: { Authorization: "Bearer RELAYER_API_KEY" },
      }),
    },
  ),
);
```

## Calls and auth

- **Auth:** The plugin uses standard Relayer auth. Send `Authorization: Bearer <RELAYER_API_KEY>` to each endpoint.
- **Verify:** `POST /api/v1/plugins/x402/call/verify`
- **Settle:** `POST /api/v1/plugins/x402/call/settle`
- **Supported:** `POST /api/v1/plugins/x402/call/supported`

## Development & testing

```bash
pnpm test
pnpm lint
pnpm build
```

## License

AGPL-3.0
