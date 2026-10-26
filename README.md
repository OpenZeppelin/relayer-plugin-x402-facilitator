# x402 Facilitator Relayer Plugin

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/OpenZeppelin/relayer-plugin-x402-facilitator)

OpenZeppelin Relayer plugin that implements the x402 facilitator API so you can serve x402 payments directly from a Relayer instance. Works with the Coinbase x402 ecosystem (e.g., `@x402/express`) and exposes the expected `/verify`, `/settle`, and `/supported` endpoints under the Relayer plugin router.

**This plugin implements the x402 v2 specification.** Every published release on npm is x402 v2 only. Earlier x402 v1 code exists only in the git history before the x402 v2 merge (`60027e4`) and was never released.

## What you get

- x402 facilitator API implemented as a Relayer plugin (Stellar support today)
- Uses your Relayer accounts/signers to verify and settle payments, sponsoring network fees for payers
- Supports multiple networks via config, including allowed assets per network
- Optional channel service integration for Stellar throughput

## Quick start

The fastest way to get a working setup is the ready-made example in the Relayer repository: [`examples/x402-facilitator-plugin`](https://github.com/OpenZeppelin/openzeppelin-relayer/tree/main/examples/x402-facilitator-plugin). It includes a Docker Compose file, a Relayer `config.json` with a Stellar testnet relayer and this plugin already wired in, and step by step instructions for creating keys, generating an API key, and funding the relayer account.

The rest of this README explains each piece so you can add the plugin to your own Relayer.

## Prerequisites

- Node.js 22.18+
- pnpm 10+
- An [OpenZeppelin Relayer](https://docs.openzeppelin.com/relayer) instance, version 1.9.0 or later. Settlements send an idempotency key so a resend after a lost Relayer reply returns the same transaction; older Relayers ignore the key, and that resend can create a second transaction, which fails on chain and costs a fee.
- For each network you plan to serve, a Relayer account (relayer + signer) on that network. Unless you settle through the [Channels service](#using-with-stellar-channels-service), this account is the fee payer for every settlement, so it must be funded with XLM.

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

### 1. Create a plugin wrapper

Create a file that re-exports the plugin handler, for example `plugins/x402/index.ts`:

```ts
export { handler } from "@openzeppelin/relayer-plugin-x402-facilitator";
```

### 2. Configure the Relayer

Add a Stellar relayer, its signer, and the plugin entry to your Relayer `config.json`. Set the plugin `path` to the wrapper from step 1.

```json
{
  "relayers": [
    {
      "id": "stellar-example",
      "name": "Stellar Example",
      "network": "testnet",
      "paused": false,
      "network_type": "stellar",
      "signer_id": "local-signer",
      "policies": {
        "fee_payment_strategy": "relayer",
        "min_balance": 0
      }
    }
  ],
  "signers": [
    {
      "id": "local-signer",
      "type": "local",
      "config": {
        "path": "config/keys/local-signer.json",
        "passphrase": { "type": "env", "value": "KEYSTORE_PASSPHRASE" }
      }
    }
  ],
  "networks": "./config/networks",
  "plugins": [
    {
      "id": "x402",
      "path": "plugins/x402/index.ts",
      "emit_logs": false,
      "emit_traces": false,
      "raw_response": true,
      "forward_logs": true,
      "allow_get_invocation": true,
      "timeout": 30,
      "config": {
        "networks": [
          {
            "network": "stellar:testnet",
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

Notes on the plugin entry:

- `allow_get_invocation` must be `true`. The x402 resource server packages (`@x402/core` and everything built on it) call `GET /supported` on startup, and without this flag the call is rejected and the resource server cannot initialize.
- `raw_response` must be `true` so the plugin's response is returned as-is, in the shape x402 clients expect.
- The plugin `id` becomes part of the URL: with `"id": "x402"`, the facilitator URL is `http://<relayer-host>/api/v1/plugins/x402/call`.

For signer types other than a local keystore (AWS KMS, GCP KMS, Turnkey, and others) and for creating keys and API keys, see the [Relayer documentation](https://docs.openzeppelin.com/relayer).

### 3. Fund the relayer account

Start the Relayer, look up the relayer address, and fund it with XLM:

```bash
curl -H "Authorization: Bearer <RELAYER_API_KEY>" \
  http://localhost:8080/api/v1/relayers/stellar-example

# testnet only
curl "https://friendbot.stellar.org?addr=<RELAYER_ADDRESS>"
```

### Network config reference

Each object in `config.networks`:

| Field                                  | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network`                              | Yes      | x402 network identifier: `stellar:testnet` or `stellar:pubnet`                                                                                                                                                                                                                                                                                                                                                                           |
| `type`                                 | Yes      | `"stellar"` (current support)                                                                                                                                                                                                                                                                                                                                                                                                            |
| `relayer_id`                           | Yes      | ID of the Relayer relayer used for this network. Without Channels it signs and pays fees for settlements, and its address is reported in `/supported`                                                                                                                                                                                                                                                                                    |
| `assets`                               | Yes      | Allowed token contract addresses (`C...`). Payments for any other asset are rejected at verify. For USDC, use its Stellar Asset Contract address: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` on testnet, `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` on mainnet                                                                                                                                           |
| `maxTransactionFeeStroops`             | No       | Safety ceiling, in stroops, on the settlement fee derived from the verify-time simulation (resource fee plus the 100 stroop base fee). Payments above it are rejected at verify, and so are simulations that return no resource fee while a ceiling is set. The client's fee bid is not checked, since the relayer rebuilds the transaction and pays its own fee. When unset, no fee ceiling is applied. See [Fee ceiling](#fee-ceiling) |
| `channel_service_api_url`              | No       | Channels service URL. Together with `channel_service_api_key`, routes settlement through Channels. See [Using with Stellar Channels Service](#using-with-stellar-channels-service)                                                                                                                                                                                                                                                       |
| `channel_service_api_key`              | No       | Channels service API key                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `channel_service_fund_relayer_id`      | No       | ID of the Channels fund relayer that should fee-bump settlements. Passed to Channels on each submission                                                                                                                                                                                                                                                                                                                                  |
| `channel_service_fund_relayer_address` | No       | On-chain address of that fund relayer. Reported in `/supported` instead of the `relayer_id` address, and protected by verify from being used as a transfer source                                                                                                                                                                                                                                                                        |

### Fee ceiling

`maxTransactionFeeStroops` bounds the cost the payer's transaction can impose: its simulated resource fee plus the 100 stroop base inclusion fee. This matches the fee the Relayer pays when it submits the settlement directly.

With the [Channels service](#using-with-stellar-channels-service), the fund relayer's fee bump bids a higher inclusion fee on top of the resource fee (by default `resourceFee + 203`, and more with dynamic fees under surge pricing), so the fee actually paid can exceed the ceiling by that inclusion fee. The client cannot influence this part. Leave headroom for it, and use the Channels per-API-key fee limit to bound total spend. The upstream x402 Stellar facilitator has the same property when it wraps settlements in a fee bump.

### Exposed routes

Routes are called through the Relayer plugin call endpoint: `POST /api/v1/plugins/{plugin_id}/call{route}`.

- `/` or ``: info
- `/verify`: x402 v2 verify
- `/settle`: x402 v2 settle
- `/supported`: discovery of supported payment kinds (returns v2 format). Also available via `GET` when `allow_get_invocation` is enabled

All routes use standard Relayer auth: send `Authorization: Bearer <RELAYER_API_KEY>`.

### x402 v2 Specification

This plugin implements the x402 v2 specification, which includes:

- **PaymentPayload v2**: Uses `accepted` field instead of top-level `scheme` and `network`
- **PaymentRequirements v2**: Uses `amount` instead of `maxAmountRequired`, removed `resource`/`description`/`mimeType` (moved to top-level `PaymentRequired`)
- **Supported endpoint v2**: Returns version-grouped `kinds`, `signers`, and `extensions` fields

The `/supported` endpoint returns data in the following v2 format:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "stellar:testnet",
      "extra": {
        "areFeesSponsored": true
      }
    }
  ],
  "signers": {
    "stellar:testnet": ["G-RELAYER-ADDRESS"]
  },
  "extensions": []
}
```

The address in `signers` is the account that pays settlement fees: the `relayer_id` address, or `channel_service_fund_relayer_address` when set.

## Using with x402 packages (e.g., x402-express)

Point the facilitator to your Relayer plugin URL and pass the Relayer API key via `createAuthHeaders`.

```text
STELLAR_ADDRESS=
FACILITATOR_URL=http://localhost:8080/api/v1/plugins/x402/call
RELAYER_API_KEY=
```

```typescript
import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
config();

const stellarAddress = process.env.STELLAR_ADDRESS;
const facilitatorUrl = process.env.FACILITATOR_URL;
const relayerApiKey = process.env.RELAYER_API_KEY;

if (!stellarAddress || !facilitatorUrl || !relayerApiKey) {
  console.error(
    "STELLAR_ADDRESS, FACILITATOR_URL and RELAYER_API_KEY are required",
  );
  process.exit(1);
}

const facilitatorClient = new HTTPFacilitatorClient({
  url: facilitatorUrl,
  createAuthHeaders: async () => ({
    verify: { Authorization: `Bearer ${relayerApiKey}` },
    settle: { Authorization: `Bearer ${relayerApiKey}` },
    supported: { Authorization: `Bearer ${relayerApiKey}` },
  }),
});

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: "stellar:testnet",
            payTo: stellarAddress,
          },
        ],
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient).register(
      "stellar:testnet",
      new ExactStellarScheme(),
    ),
  ),
);

app.get("/weather", (req, res) => {
  res.send({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:${4021}`);
});
```

A complete, runnable version of this server, plus a paying client, is in [`examples/stellar`](examples/stellar/).

## Testing your setup

There are two ways to test a running facilitator:

- **End to end with the examples:** the [testing guide](examples/stellar/README.md) runs the example server and client against your facilitator. It covers the account requirements (funding, USDC trustlines), checking `/supported`, running paid requests, and verifying the settled transactions on chain.
- **Smoke test script:** [`scripts/smoke.ts`](scripts/smoke.ts) calls the facilitator directly, without a resource server. It checks `/supported`, builds and signs a USDC transfer, runs `/verify` and `/settle`, and can confirm on chain which account fee-bumped the settlement. It uses a key from the `stellar` CLI (`stellar keys`), and that account needs a trustline and balance for the test asset.

  ```bash
  npx tsx scripts/smoke.ts \
    --api-key <API_KEY> \
    --base-url <FACILITATOR_URL> \
    --verify-fee-bump-source <EXPECTED_FEE_PAYER_ADDRESS>
  ```

  See the header of the script for all flags.

## Using with Stellar Channels Service

For high-throughput x402 payment settlement, you can connect the plugin with the [OpenZeppelin Stellar Channels Service](https://docs.openzeppelin.com/relayer/guides/stellar-channels-guide). The Channels service provides managed infrastructure for parallel transaction submission on Stellar, handling fee management and sequence number coordination automatically.

**Benefits:**

- **Parallel settlement**: Multiple x402 payments can be settled concurrently using a pool of channel accounts
- **Automatic fee management**: The Channels service pays transaction fees on your behalf
- **Zero infrastructure overhead**: No need to manage channel accounts or fund accounts yourself
- **Higher throughput**: Avoids sequence number conflicts that can occur when settling many payments through a single relayer account

Add the Channels fields to your network config:

```json
{
  "config": {
    "networks": [
      {
        "network": "stellar:testnet",
        "type": "stellar",
        "relayer_id": "stellar-example",
        "assets": ["CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"],
        "channel_service_api_url": "https://channels.openzeppelin.com/testnet",
        "channel_service_api_key": "YOUR_CHANNELS_API_KEY",
        "channel_service_fund_relayer_id": "YOUR_FUND_RELAYER_ID",
        "channel_service_fund_relayer_address": "G..."
      }
    ]
  }
}
```

**Key fields:**

- **`channel_service_api_url`**: The URL of the Channels service. Use `https://channels.openzeppelin.com/testnet` for testnet or the appropriate endpoint for your environment.
- **`channel_service_api_key`**: Your API key for the Channels service. For the hosted OpenZeppelin service, generate one at https://channels.openzeppelin.com/testnet/gen (testnet) or https://channels.openzeppelin.com/gen (mainnet).
- **`channel_service_fund_relayer_id`** (optional): The ID of an alternative Channels fund relayer that fee-bumps your settlements. The ID must be allowlisted in the Channels service (`ALLOWED_FUND_RELAYER_IDS`), otherwise requests are rejected. When omitted, Channels uses its primary fund relayer.
- **`channel_service_fund_relayer_address`** (optional): The on-chain address of that fund relayer. When set, the `/supported` endpoint reports this address instead of the `relayer_id` address, and verify security checks also protect this address from being used as a transfer source.

> **Important:** `channel_service_fund_relayer_id` and `channel_service_fund_relayer_address` must refer to the same account. The ID decides which account actually pays the fee; the address is what `/supported` advertises and what verify protects. The plugin does not check that they match. After a test settlement, confirm on chain that the fee bump's fee account equals the advertised address (the smoke test's `--verify-fee-bump-source` flag does this).

When `channel_service_api_url` and `channel_service_api_key` are present, the plugin routes settlement through the Channels service instead of submitting transactions directly via the relayer. The plugin sends the Soroban function XDR and authorization entries to the Channels service, which handles transaction building, simulation, and submission using its pool of channel accounts. The `relayer_id` relayer is still used for verification but no longer pays settlement fees.

## Adding Trustlines for Token Support

> **Note:** This is only needed if the relayer address needs to hold tokens like USDC. If the relayer is only used for transaction submission and does not receive or hold the asset, no trustline is required.

Before a Stellar account can hold or receive tokens like USDC, it must establish a **trustline** to the token's contract. You can create a trustline using [Stellar Laboratory](https://lab.stellar.org) to build a `Change Trust` transaction, then submit the XDR via the relayer:

```
POST /api/v1/relayers/{relayer-id}/transactions
```

```json
{
  "params": {
    "network": "testnet",
    "transaction_xdr": "<XDR_VALUE>"
  }
}
```

Alternatively, the Relayer SDK has a script that builds and submits this transaction: [`createTrustline.ts`](https://github.com/OpenZeppelin/openzeppelin-relayer-sdk/blob/main/examples/relayers/stellar/src/sponsored/createTrustline.ts). Set `USER_ACCOUNT` to the relayer's own address, since the relayer is the only signer.

## Development & testing

```bash
pnpm test
pnpm lint
pnpm build
```

## License

AGPL-3.0
