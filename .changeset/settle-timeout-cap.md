---
"@openzeppelin/relayer-plugin-x402-facilitator": minor
---

feat: cap the settle wait with `max_settle_timeout_seconds` and report a reused nonce with its own reason

- New optional plugin config field `max_settle_timeout_seconds` bounds how long `/settle` waits for a settlement, whatever `maxTimeoutSeconds` the request carries. The request value comes from the resource server and can exceed the plugin `timeout`, the Relayer's `REQUEST_TIMEOUT_SECONDS` or a gateway timeout. When one of those cut the call off, the resource server got a timeout and no settle response while the payment still landed. With the cap below them, settle answers first, with `settle_exact_stellar_transaction_not_final` and the hash when the settlement is still pending. When unset, behavior is unchanged.
- A `max_settle_timeout_seconds` that is not a positive number makes every route fail with `500` and code `INVALID_CONFIG`, and the reason is logged.
- The cap applies to the submission and the wait for its result. `maxTimeoutSeconds` still bounds the expiration of the payer's signature at verify.
- A payment whose signed authorization carries a nonce that was already used on chain (typically a replayed settle or verify) is now rejected with the new reason `invalid_exact_stellar_payload_nonce_reused` and a short message, instead of `invalid_exact_stellar_payload_simulation_failed` carrying the raw host error and event log. The reason means the nonce is spent, not that this payment settled: a payer can spend a nonce in another transaction.
- README: the example config sets `timeout: 25` and `max_settle_timeout_seconds: 20`, and a new "Settle timeout" section explains how to order the cap, the plugin `timeout`, `REQUEST_TIMEOUT_SECONDS` and a gateway timeout.
