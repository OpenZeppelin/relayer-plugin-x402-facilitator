---
"@openzeppelin/relayer-plugin-x402-facilitator": patch
---

fix: stop Channels settlements from failing when a status request is dropped

- After the channel service accepts a transaction, a failed status request (dropped connection, timeout, 408, 429 or 5xx response) is now logged and polling continues until the deadline. A permanent 4xx response, such as a rejected API key, still ends polling right away. Previously one failed poll ended settle with `settle_channel_service_failed` while the transaction still landed.
- Each channel service status request now times out after 10 seconds or at the settlement deadline, whichever is first, so a connection that never answers can no longer hang polling. Submits run until the settlement deadline, since a submit aborted after the channel service accepted it cannot be found again.
- A `mined` status no longer ends polling as a failure; polling continues until the transaction is confirmed or fails.
- A submit rejected by the Relayer rate limiter (429) is now retried with backoff, like `POOL_CAPACITY`. The Relayer rejects it before the plugin runs, so nothing was submitted. The Channels `FEE_LIMIT_EXCEEDED` 429 is still not retried.
- Submit retries and status polls now wait at least as long as the `retry-after` header asks, instead of a fixed interval.
- When polling times out, the response now includes the last transaction hash the channel service reported, so a transaction that landed after the deadline can be reconciled.
