---
"@openzeppelin/relayer-plugin-x402-facilitator": patch
---

fix: check the fee ceiling against the simulated settlement fee, not the client's fee bid

- `maxTransactionFeeStroops` now caps the fee derived from the verify-time simulation (`minResourceFee` plus the 100 stroop base fee). Previously it capped the client's fee bid, which the facilitator never pays: settle submits only the invocation and auth entries, and the relayer or channel service rebuilds the transaction and pays its own fee. Payments with an inflated client bid were rejected with `invalid_exact_stellar_payload_fee_exceeds_maximum` although settling them would have cost far less.
- The check that rejected a client fee bid below the simulated resource fee (`invalid_exact_stellar_payload_fee_below_minimum`) is removed, since that bid is not used. It caused spurious rejections when resource fees rose between the client's simulation and verify.
- The rejection log now shows the simulated settlement fee, the resource fee, the ceiling and the client's bid.
- When `maxTransactionFeeStroops` is set and the simulation returns no valid `minResourceFee`, verify now rejects with `invalid_exact_stellar_payload_simulation_failed` instead of skipping the fee check.
