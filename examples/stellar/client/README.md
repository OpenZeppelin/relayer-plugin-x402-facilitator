# x402 Client Example

Concurrent x402 payment client that fires multiple paid requests in parallel against the server example, using Stellar testnet.

## Prerequisites

- Node.js >= 22.18.0
- pnpm
- The [server example](../server/) running locally
- A funded Stellar testnet account (secret key)
  - Create and fund one at the [Stellar Laboratory](https://lab.stellar.org/)

## Setup

```bash
pnpm install
cp .env-local .env
```

Edit `.env` with your values:

| Variable              | Description                          | Default                               |
| --------------------- | ------------------------------------ | ------------------------------------- |
| `STELLAR_PRIVATE_KEY` | Stellar secret key (starts with `S`) | _(required)_                          |
| `SERVER_URL`          | URL of the x402 server example       | `http://localhost:4021`               |
| `CONCURRENT_REQUESTS` | Number of parallel requests to fire  | `5`                                   |
| `STELLAR_RPC_URL`     | Soroban RPC used to build payments   | `https://soroban-testnet.stellar.org` |

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env-local .env
# Edit .env with your STELLAR_PRIVATE_KEY

# 3. Make sure the server example is running first, then start the client
pnpm start
```

## Expected Output

```
Sending 5 concurrent x402 requests to http://localhost:4021

[#1 Weather ($0.001)] 200 (11102ms) tx_hash: <hash>
[#2 Premium ($0.001)] 200 (10727ms) tx_hash: <hash>
[#3 Weather ($0.001)] 200 (16332ms) tx_hash: <hash>
[#4 Premium ($0.001)] 200 (11045ms) tx_hash: <hash>
[#5 Weather ($0.001)] 200 (10975ms) tx_hash: <hash>

--- Summary ---
Total:     5 requests in 16331ms
Fulfilled: 5
Rejected:  0
```

Each request takes around 10 to 15 seconds because the server waits for the payment to settle on chain before responding. A request counts as fulfilled only when it returns `200`.
