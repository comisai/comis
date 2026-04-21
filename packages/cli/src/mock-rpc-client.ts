// SPDX-License-Identifier: Apache-2.0
/**
 * Mock RPC client builder for CLI command tests.
 *
 * Provides a configurable mock that implements the RpcClient interface from
 * the real WebSocket client. Supports four response modes: success, error,
 * timeout, and disconnect. Eliminates the need for a running daemon in tests.
 *
 * @module
 */

import type { RpcClient } from "./client/rpc-client.js";

/**
 * Builder interface for configuring mock RPC client responses.
 *
 * Methods are chainable so tests can configure multiple behaviors inline:
 * ```ts
 * createMockRpcClient()
 *   .onCall('config.get', { agents: {} })
 *   .onError('agent.delete', 'Permission denied')
 *   .build();
 * ```
 */
export interface MockRpcClientBuilder {
  /** Configure a successful response for a method. */
  onCall(method: string, response: unknown): MockRpcClientBuilder;
  /** Configure an error response for a method. */
  onError(method: string, errorMessage: string): MockRpcClientBuilder;
  /** Configure a timeout for a method (rejects after delayMs). */
  onTimeout(method: string, delayMs: number): MockRpcClientBuilder;
  /** Configure disconnect mode (all calls reject with connection error). */
  onDisconnect(): MockRpcClientBuilder;
  /** Build the mock client implementing RpcClient. */
  build(): RpcClient;
}

/**
 * Create a new MockRpcClientBuilder for configuring test responses.
 *
 * @returns A builder for fluently configuring mock RPC behavior
 *
 * @example
 * ```ts
 * const client = createMockRpcClient()
 *   .onCall('agent.list', [{ name: 'test-agent' }])
 *   .build();
 *
 * const result = await client.call('agent.list');
 * // result === [{ name: 'test-agent' }]
 * ```
 */
export function createMockRpcClient(): MockRpcClientBuilder {
  const responses = new Map<string, unknown>();
  const errors = new Map<string, string>();
  const timeouts = new Map<string, number>();
  let disconnected = false;

  const builder: MockRpcClientBuilder = {
    onCall(method: string, response: unknown): MockRpcClientBuilder {
      responses.set(method, response);
      return builder;
    },

    onError(method: string, errorMessage: string): MockRpcClientBuilder {
      errors.set(method, errorMessage);
      return builder;
    },

    onTimeout(method: string, delayMs: number): MockRpcClientBuilder {
      timeouts.set(method, delayMs);
      return builder;
    },

    onDisconnect(): MockRpcClientBuilder {
      disconnected = true;
      return builder;
    },

    build(): RpcClient {
      return {
        call(method: string, _params?: unknown): Promise<unknown> {  
          if (disconnected) {
            return Promise.reject(
              new Error("Connection closed unexpectedly"),
            );
          }

          if (timeouts.has(method)) {
            const delayMs = timeouts.get(method)!;
            return new Promise((_resolve, reject) => {
              setTimeout(() => {
                reject(
                  new Error(
                    `Connection to daemon timed out after ${delayMs}ms. Is the daemon running?`,
                  ),
                );
              }, delayMs);
            });
          }

          if (errors.has(method)) {
            return Promise.reject(new Error(errors.get(method)));
          }

          if (responses.has(method)) {
            return Promise.resolve(responses.get(method));
          }

          return Promise.reject(
            new Error(`Unexpected RPC call: ${method}`),
          );
        },

        close(): void {
          // No-op for mock client
        },

        onNotification(): void {
          // No-op for mock client
        },
      };
    },
  };

  return builder;
}

/**
 * Convenience wrapper that creates a mock client and passes it to a function.
 *
 * Drop-in replacement for the real `withClient` function in tests. Configure
 * the builder, then use withMockClient to get a function matching withClient's
 * signature.
 *
 * @param builder - A configured MockRpcClientBuilder
 * @returns An async function that passes the built client to the given callback
 *
 * @example
 * ```ts
 * const mock = createMockRpcClient().onCall('config.get', { agents: {} });
 * const run = withMockClient(mock);
 * const result = await run(async (client) => {
 *   return await client.call('config.get');
 * });
 * ```
 */
export function withMockClient(
  builder: MockRpcClientBuilder,
): <T>(fn: (client: RpcClient) => Promise<T>) => Promise<T> {
  const client = builder.build();
  return async <T>(fn: (client: RpcClient) => Promise<T>): Promise<T> => {
    return fn(client);
  };
}
