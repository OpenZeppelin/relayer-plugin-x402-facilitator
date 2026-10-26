---
"@openzeppelin/relayer-plugin-x402-facilitator": minor
---

feat: return failure details in `invalidMessage` and `errorMessage`

- Verify responses can carry `invalidMessage` with the detail behind `invalidReason`: the simulation error (for example a missing trustline), the balance change that failed validation, which auth entries are unsigned, or why the transaction could not be parsed.
- Settle responses can carry `errorMessage`: the verify message when re-verification fails, the channel service's status code and error code, the failed status and error of a channel service transaction, the Relayer's status reason for a failed transaction, or the status a transaction was still in at the deadline.
- Messages are capped at 1000 characters. Unexpected errors and network failures are not returned, since they may carry internal details; they stay in the log. Both fields are optional and omitted when there is nothing to add.
