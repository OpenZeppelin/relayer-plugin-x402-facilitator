/**
 * Stellar plugin
 *
 * This plugin implements the Stellar payment processing.
 *
 * Example API calls:
 * - POST /api/v1/plugins/{plugin_id}/call/verify   -> Verify endpoint (route = "/verify")
 * - POST /api/v1/plugins/{plugin_id}/call/settle   -> Settle endpoint (route = "/settle")
 * - POST /api/v1/plugins/{plugin_id}/call/supported   -> Supported endpoint (route = "/supported", GET also works with allow_get_invocation)
 */
export * from "./verify";
export * from "./settle";
