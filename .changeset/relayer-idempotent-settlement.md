---
"@openzeppelin/relayer-plugin-x402-facilitator": minor
---

feat: send settlements to the Relayer with an idempotency key

- Settlements submitted through the Relayer pass an `idempotencyKey` unique to the settle call: a hash of the network, the contract invocation (asset, payer, recipient, amount) and the signed auth entries, plus a random id per call. Requires Relayer 1.9.0 or later.
- When the Relayer's reply is lost (plugin socket timeout, socket closed, or socket unavailable), the verified request is resent with the same key within the settlement deadline, so the Relayer returns the transaction it already created instead of a second one. When another settle of the same payment is still creating its transaction, the Relayer's in-progress conflict is retried the same way.
- Each send to the Relayer is bounded by the settlement deadline, so settle no longer waits out the runtime's 30 second socket timeout.
- Relayer transaction status is polled with `getTransaction`. A failed status request counts as a missed poll, each request is bounded by the remaining deadline, `mined` is not treated as final, and when the deadline passes the last status and hash are returned.
- Channels submits carry the same key in an `Idempotency-Key` header, which `@openzeppelin/relayer-plugin-channels` uses to deduplicate submissions once it supports the header; older versions ignore it. Status requests do not send it.
- Because the key is unique to each settle call, a second settle of the same payment, whether concurrent or later, never shares the first one's transaction. It fails on the used nonce, so resource servers keep their replay protection.
- Bumps `@openzeppelin/relayer-sdk` to ^1.10.0 and `@stellar/stellar-sdk` to ^17.4.0.
