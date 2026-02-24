# x402 Server Example

Express server with payment-protected endpoints using the x402 protocol on Stellar testnet.

## Prerequisites

- Node.js >= 22.18.0
- pnpm
- A running [OpenZeppelin Relayer](https://github.com/OpenZeppelin/openzeppelin-relayer) with the x402 facilitator plugin configured (see the [main README](../../README.md))
- A Stellar testnet account (public key)

## Setup

```bash
pnpm install
cp .env-local .env
```

Edit `.env` with your values:

| Variable          | Description                | Default                                          |
| ----------------- | -------------------------- | ------------------------------------------------ |
| `STELLAR_ADDRESS` | Stellar public key (payee) | _(required)_                                     |
| `FACILITATOR_URL` | Relayer plugin endpoint    | `http://localhost:8080/api/v1/plugins/x402/call` |
| `RELAYER_API_KEY` | Auth key for the relayer   | _(required)_                                     |
| `PORT`            | Server port                | `4021`                                           |

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env-local .env
# Edit .env with your STELLAR_ADDRESS, FACILITATOR_URL, and RELAYER_API_KEY

# 3. Start the server (start this before the client)
pnpm start
```

## Endpoints

| Method | Path       | Price  | Description     |
| ------ | ---------- | ------ | --------------- |
| GET    | `/health`  | Free   | Health check    |
| GET    | `/weather` | $0.001 | Weather data    |
| GET    | `/premium` | $0.01  | Premium content |

## Verify

```bash
# Should return {"status":"ok"}
curl http://localhost:4021/health

# Should return 402 Payment Required
curl http://localhost:4021/weather
```
