# @openzeppelin/relayer-plugin-x402-facilitator

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
