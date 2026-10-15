# Testing an x402 Facilitator on Stellar

This guide walks through an end to end test of an x402 facilitator (this plugin running on an OpenZeppelin Relayer, or a hosted endpoint such as OpenZeppelin Channels) using the two examples in this folder:

- [`server/`](./server/): an Express resource server with paid endpoints. It asks the facilitator to verify and settle payments.
- [`client/`](./client/): a client that pays for those endpoints concurrently, signing the USDC transfer with a Stellar key.

A successful run proves that the facilitator advertises the right payment kinds, verifies signed payments, and settles them on chain while sponsoring the fees.

## How a payment flows

1. The server starts and calls `GET {FACILITATOR_URL}/supported` to learn which networks and schemes the facilitator handles.
2. The client requests `/weather` and receives `402 Payment Required` with the price, asset and payee.
3. The client builds a Soroban `transfer` call on the USDC contract, simulates it against Stellar RPC, and signs the authorization entry with its key. It does not sign or pay for the transaction itself.
4. The server sends the payment to the facilitator's `/verify` and `/settle` endpoints.
5. The facilitator submits the transaction, wrapped in a fee bump so the facilitator pays the network fee, and returns the transaction hash.
6. The server responds `200` with a `PAYMENT-RESPONSE` header containing the hash.

## Prerequisites

### Tools

- Node.js >= 22.18.0
- pnpm

### Facilitator

You need a facilitator URL and an API key for it:

| Setup                                | `FACILITATOR_URL`                                       |
| ------------------------------------ | ------------------------------------------------------- |
| Self-hosted Relayer with this plugin | `http://localhost:8080/api/v1/plugins/<plugin_id>/call` |
| OpenZeppelin Channels (testnet)      | `https://channels.openzeppelin.com/x402/testnet`        |

For a self-hosted Relayer, the plugin entry must set `"allow_get_invocation": true`. The x402 server calls `/supported` with `GET`, and without that flag the call is rejected and the server cannot initialize. See the [main README](../../README.md) for plugin configuration.

### Stellar accounts

The test uses two accounts. They can be the same account, but then the USDC balance does not change and the transaction hashes are your only evidence of settlement, so a separate payee is recommended.

| Requirement                                                    | Payer (client key)                       | Payee (`STELLAR_ADDRESS`)      |
| -------------------------------------------------------------- | ---------------------------------------- | ------------------------------ |
| Account exists on chain (funded with XLM for the base reserve) | Yes                                      | Yes, if it is a `G...` address |
| USDC trustline                                                 | Yes                                      | Yes, if it is a `G...` address |
| USDC balance                                                   | At least the total price of the requests | No                             |
| XLM for transaction fees                                       | No, the facilitator sponsors fees        | No                             |

A contract address (`C...`) can also be used as the payee. It needs no trustline.

The examples price endpoints in USD, which `@x402/stellar` maps to USDC. On testnet that is Circle's USDC:

```
Asset code: USDC
Issuer:     GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
```

### Preparing testnet accounts

1. **Create a key pair** in [Stellar Lab](https://lab.stellar.org/account/create) or with a wallet such as Freighter. Keep the secret key (starts with `S`) for the client.
2. **Fund it with testnet XLM** using Friendbot:
   ```bash
   curl "https://friendbot.stellar.org?addr=<G_ADDRESS>"
   ```
3. **Add a USDC trustline** for the issuer above. In Stellar Lab, build and submit a `Change Trust` operation signed by the account, or add the asset in your wallet.
4. **Get testnet USDC** from the [Circle faucet](https://faucet.circle.com/) by selecting Stellar testnet. The payer only needs a small amount: each example request costs 0.001 USDC.
5. Repeat steps 1 to 3 for the payee if you use a separate account.

Check an account before running the test:

```bash
curl -s "https://horizon-testnet.stellar.org/accounts/<G_ADDRESS>" | grep -E '"(asset_code|balance)"'
```

You should see a `USDC` entry with a balance alongside the native XLM balance. A `404` means the account does not exist yet.

## Step 1: Check the facilitator

Before starting anything locally, confirm the facilitator is reachable and your API key works:

```bash
curl -H "Authorization: Bearer <API_KEY>" "<FACILITATOR_URL>/supported"
```

Expected response:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "stellar:testnet",
      "extra": { "areFeesSponsored": true }
    }
  ],
  "signers": { "stellar:testnet": ["G..."] }
}
```

Check that:

- `kinds` contains `scheme: "exact"` for the network you will test (`stellar:testnet` or `stellar:pubnet`).
- `signers` lists the facilitator account for that network. This should be the account that pays settlement fees. When settling through Channels, it is the value of `channel_service_fund_relayer_address` in the plugin config.

## Step 2: Configure the examples

```bash
cp server/.env-local server/.env
cp client/.env-local client/.env
```

`server/.env`:

| Variable          | Value                                           |
| ----------------- | ----------------------------------------------- |
| `STELLAR_ADDRESS` | Payee public key (`G...` or `C...`)             |
| `FACILITATOR_URL` | Facilitator URL from the prerequisites          |
| `RELAYER_API_KEY` | Facilitator API key                             |
| `STELLAR_NETWORK` | `stellar:testnet` (default) or `stellar:pubnet` |
| `PORT`            | Optional, defaults to `4021`                    |

`client/.env`:

| Variable              | Value                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STELLAR_PRIVATE_KEY` | Payer secret key (`S...`)                                                                                                                           |
| `SERVER_URL`          | `http://localhost:4021`                                                                                                                             |
| `CONCURRENT_REQUESTS` | Optional, defaults to `5`                                                                                                                           |
| `STELLAR_RPC_URL`     | Optional on testnet. Required on mainnet, see [RPC providers](https://developers.stellar.org/docs/data/apis/rpc/providers#publicly-accessible-apis) |

## Step 3: Start the server

```bash
cd server
pnpm install
pnpm start
```

Expected output:

```
x402 server listening at http://localhost:4021 (stellar:testnet)
  GET /health   - free
  GET /weather  - $0.001
  GET /premium  - $0.001
```

If the log also shows `Failed to fetch supported kinds from facilitator`, stop here and see [Troubleshooting](#troubleshooting).

From another shell:

```bash
curl http://localhost:4021/health      # {"status":"ok"}
curl -i http://localhost:4021/weather  # HTTP/1.1 402 Payment Required
```

## Step 4: Run the client

```bash
cd client
pnpm install
pnpm start
```

Expected output:

```
Sending 5 concurrent x402 requests to http://localhost:4021

[#1 Weather ($0.001)] 200 (11102ms) tx_hash: f63b8d48...
[#2 Premium ($0.001)] 200 (10727ms) tx_hash: e922eb98...
...

--- Summary ---
Total:     5 requests in 16331ms
Fulfilled: 5
Rejected:  0
```

Every line should show `200` and a `tx_hash`. Any other status, or a thrown error, is counted as rejected in the summary.

Each request takes around 10 to 15 seconds because settlement waits for on chain confirmation before the server responds.

## Step 5: Verify on chain

Open a transaction in the explorer:

```
https://stellar.expert/explorer/testnet/tx/<tx_hash>
```

A correctly settled payment looks like this:

| Field                    | Expected value                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| Status                   | Successful                                                                                       |
| Type                     | Fee bump transaction                                                                             |
| Fee account              | The facilitator's fee paying account                                                             |
| Inner transaction source | A facilitator owned account (with Channels, a channel account that changes between transactions) |
| Operation                | `invoke_host_function` calling `transfer` on the USDC contract                                   |
| Transfer                 | `from` = payer, `to` = payee, amount = price (0.001 USDC)                                        |

Your payer account pays no XLM. Its only change is the USDC sent to the payee.

You can also check from the command line:

```bash
curl -s "https://horizon-testnet.stellar.org/transactions/<tx_hash>" | grep -E '"(successful|source_account|fee_account|fee_charged)"'
```

> **Note:** the fee account on chain should match the signer that `/supported` advertises. If they differ, the facilitator's `channel_service_fund_relayer_address` (or relayer address) is misconfigured: clients are told the wrong fee payer, and the verify check that stops the fee payer from being used as a transfer source protects the wrong account.

## Troubleshooting

| Symptom                                                                                     | Likely cause                                                                                                  |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Server logs `Failed to fetch supported kinds from facilitator` and paid routes return `500` | Wrong `FACILITATOR_URL`, invalid API key, or (self-hosted) `allow_get_invocation` not enabled. Re-run Step 1. |
| Server starts but paid routes return `500`                                                  | `STELLAR_NETWORK` does not match a network listed in `/supported`.                                            |
| Client requests fail or keep returning `402`                                                | Payer account missing, no USDC trustline, or not enough USDC. Check the account with Horizon.                 |
| Settlement fails for a `G...` payee                                                         | Payee account does not exist or has no USDC trustline.                                                        |
| Client fails while building the payment                                                     | `STELLAR_RPC_URL` unreachable, or not set on mainnet.                                                         |

## Mainnet

The same steps apply on mainnet with these changes:

- `STELLAR_NETWORK=stellar:pubnet` on the server and a mainnet `FACILITATOR_URL`.
- `STELLAR_RPC_URL` set on the client.
- Accounts funded with real XLM and holding mainnet USDC (issuer `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`).
- Explorer links under `https://stellar.expert/explorer/public/`.
