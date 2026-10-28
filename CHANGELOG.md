# @openzeppelin/relayer-plugin-x402-facilitator

## 0.5.1

### Patch Changes

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
