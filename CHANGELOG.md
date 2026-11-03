# @openzeppelin/relayer-plugin-x402-facilitator

## 0.6.0

### Minor Changes

- 5783d54: feat: return failure details in `invalidMessage` and `errorMessage`

  - Verify responses can carry `invalidMessage` with the detail behind `invalidReason`: the simulation error (for example a missing trustline), the balance change that failed validation, which auth entries are unsigned, or why the transaction could not be parsed.
  - Settle responses can carry `errorMessage`: the verify message when re-verification fails, the channel service's status code and error code, the failed status and error of a channel service transaction, the Relayer's reason for a transaction that failed on chain, or why a settlement is not final (the status it was still in at the deadline, a status request that failed after the transaction was accepted, or a send whose outcome is unknown).
  - Messages are capped at 1000 characters. Unexpected errors, network failures, and Relayer reasons other than an on-chain failure (submission, preparation and status monitoring errors) are not returned, since they may carry internal details; they stay in the log. Both fields are optional and omitted when there is nothing to add.

- 557e3a6: feat: send settlements to the Relayer with an idempotency key

  - Settlements submitted through the Relayer pass an `idempotencyKey` unique to the settle call: a hash of the network, the contract invocation (asset, payer, recipient, amount) and the signed auth entries, plus a random id per call. Requires Relayer 1.9.0 or later.
  - When the Relayer's reply is lost (plugin socket timeout, socket closed, or socket unavailable), the verified request is resent with the same key within the settlement deadline, so the Relayer returns the transaction it already created instead of a second one. When another settle of the same payment is still creating its transaction, the Relayer's in-progress conflict is retried the same way.
  - Each send to the Relayer is bounded by the settlement deadline, so settle no longer waits out the runtime's 30 second socket timeout.
  - Relayer transaction status is polled with `getTransaction`. A failed status request counts as a missed poll, each request is bounded by the remaining deadline, `mined` is not treated as final, and when the deadline passes the last status and hash are returned.
  - A settlement that is not final at the deadline now fails with the new reason `settle_exact_stellar_transaction_not_final` instead of `settle_exact_stellar_transaction_failed` or `settle_channel_service_failed`, with the last hash when one is known. The transaction may still land, so operators should reconcile it rather than treat it as failed on chain. This covers a Relayer status still pending at the deadline or none received before it, a Relayer send whose reply was lost and still unresolved when retries or time ran out, a Channels polling timeout or a permanent status request error (such as 401 or 404) after the submit was accepted, a Channels `confirmed` status without a hash, a Channels submit cut off by the deadline or still unresolved under `IDEMPOTENCY_KEY_SEND_FAILED` or `IDEMPOTENCY_KEY_IN_PROGRESS`, and Channels' `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN`. Once an attempt leaves the outcome unknown, a later resend failure (such as a rate limit or a Relayer error) keeps this reason, since the earlier transaction may still land. A `confirmed` Relayer status without a hash is reported the same way rather than as settled, and a Channels settlement falls back to the hash its submit returned when polling never reports one or fails. Errors the Relayer or Channels return for the request itself are still reported as failures.
  - Channels submits carry the same key in an `Idempotency-Key` header, which `@openzeppelin/relayer-plugin-channels` uses to deduplicate submissions once it supports the header; older versions ignore it. Status requests do not send it. Channels' `IDEMPOTENCY_KEY_SEND_FAILED` and `IDEMPOTENCY_KEY_IN_PROGRESS` responses are resent with the same key until the deadline.
  - A Channels submit response that carries a hash is only treated as a confirmed settlement when its status is `confirmed`, or absent for older services. Otherwise the transaction is polled until final.
  - Because the key is unique to each settle call, a second settle of the same payment, whether concurrent or later, never shares the first one's transaction. It fails on the used nonce, so resource servers keep their replay protection.
  - Bumps `@openzeppelin/relayer-sdk` to ^1.10.0 and `@stellar/stellar-sdk` to ^17.4.0.

### Patch Changes

- 431147b: fix: stop Channels settlements from failing when a status request is dropped

  - After the channel service accepts a transaction, a failed status request (dropped connection, timeout, 408, 429 or 5xx response) is now logged and polling continues until the deadline. A permanent 4xx response, such as a rejected API key, still ends polling right away. Previously one failed poll ended settle with `settle_channel_service_failed` while the transaction still landed.
  - Each channel service status request now times out after 10 seconds or at the settlement deadline, whichever is first, so a connection that never answers can no longer hang polling. Submits run until the settlement deadline, since a submit aborted after the channel service accepted it cannot be found again.
  - A `mined` status no longer ends polling as a failure; polling continues until the transaction is confirmed or fails.
  - A submit rejected by the Relayer rate limiter (429) is now retried with backoff, like `POOL_CAPACITY`. The Relayer rejects it before the plugin runs, so nothing was submitted. The Channels `FEE_LIMIT_EXCEEDED` 429 is still not retried.
  - Submit retries and status polls now wait at least as long as the `retry-after` header asks, instead of a fixed interval.
  - When polling times out, the response now includes the last transaction hash the channel service reported, so a transaction that landed after the deadline can be reconciled.

- 04f1178: fix: check the fee ceiling against the simulated settlement fee, not the client's fee bid

  - `maxTransactionFeeStroops` now caps the fee derived from the verify-time simulation (`minResourceFee` plus the 100 stroop base fee). Previously it capped the client's fee bid, which the facilitator never pays: settle submits only the invocation and auth entries, and the relayer or channel service rebuilds the transaction and pays its own fee. Payments with an inflated client bid were rejected with `invalid_exact_stellar_payload_fee_exceeds_maximum` although settling them would have cost far less.
  - The check that rejected a client fee bid below the simulated resource fee (`invalid_exact_stellar_payload_fee_below_minimum`) is removed, since that bid is not used. It caused spurious rejections when resource fees rose between the client's simulation and verify.
  - The rejection log now shows the simulated settlement fee, the resource fee, the ceiling and the client's bid.
  - When `maxTransactionFeeStroops` is set and the simulation returns no valid `minResourceFee`, verify now rejects with `invalid_exact_stellar_payload_simulation_failed` instead of skipping the fee check.

## 0.5.0

### Minor Changes

- 2e69c6a: feat: upgrade `@stellar/stellar-sdk` from v14 to v17 for Stellar Protocol 28
  - Decodes Protocol 27/28 XDR (CAP-71 auth credentials, CAP-85 external contract executables). Payments signed with current x402 Stellar clients that emit `SOROBAN_CREDENTIALS_ADDRESS_V2` auth entries are now verified instead of being rejected as malformed.
  - Accepts both `sorobanCredentialsAddress` and `sorobanCredentialsAddressV2` credential types. Delegated (`sorobanCredentialsAddressWithDelegates`) and source account credentials are still rejected.
  - Auth entries whose signature is the empty `scvVec` placeholder written by `authorizeInvocation` before signing are now treated as unsigned, matching the SDK's own rule.
  - Migrates to the v17 XDR API (property access, `type` discriminants, `Uint8Array` bytes).

## 0.4.0

### Minor Changes

- 19adb9c: feat: Adding x402 when send request to channels (#43)

## 0.3.0

### Minor Changes

- 8a7841e: feat: Add retries for channels pool capacity errors (#39)

## 0.2.0

### Minor Changes

- 0a0a7c0: Use channels pooling skipWait feature and getTransaction request

## 0.1.0

### Minor Changes

- 669d3ad: - feat: Plugin support for x402
