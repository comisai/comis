/** Handler function signature for RPC methods. */
export type RpcHandler = (params: Record<string, unknown>) => Promise<unknown>;
