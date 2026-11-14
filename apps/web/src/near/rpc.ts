/**
 * Read-only NEAR contract calls straight to an RPC node (no near-api-js): the `query` / `call_function` JSON-RPC.
 * Shared by the backing (table contract) and escrow readers.
 */
export const NEAR_RPC = (import.meta.env?.VITE_NEAR_RPC as string | undefined) ?? 'https://test.rpc.fastnear.com';

/** Calls view method `method` on `contract` with JSON `args` and parses the JSON it returns. */
export async function viewContract<T>(contract: string, method: string, args: Record<string, unknown> = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await fetchImpl(NEAR_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'nomad', method: 'query',
      params: { request_type: 'call_function', finality: 'optimistic', account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) },
    }),
  });
  const j = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { message?: string; data?: unknown } };
  if (j.error || !j.result?.result) {
    // The node's `data` says what went wrong ("account x does not exist while viewing"); `message` is just "Server error".
    const detail = typeof j.error?.data === 'string' ? j.error.data : null;
    throw new Error(j.result?.error ?? detail ?? j.error?.message ?? `NEAR RPC error (${res.status})`);
  }
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(j.result.result))) as T;
}
