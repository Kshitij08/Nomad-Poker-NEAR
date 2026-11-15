// Shared helpers for the proof scripts (attack report, soak test). Node on Windows, keys from the WSL keychain.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Account, JsonRpcProvider, actions, teraToGas } from "../feeder/src/chain.mjs";

export const env = process.env;
export const TABLE = env.TABLE ?? "table.nomad-poker.testnet";
export const RPC = env.RPC ?? "https://test.rpc.fastnear.com";
export const CREDS = env.NEAR_CREDENTIALS_DIR ?? "\\\\wsl.localhost\\Ubuntu\\home\\kshit\\.near-credentials\\testnet";
/** The feeder's own credentials folder: only its function-call key. */
export const FEEDER_CREDS = env.FEEDER_CREDENTIALS_DIR ?? "\\\\wsl.localhost\\Ubuntu\\home\\kshit\\.near-credentials\\feeder";
export const EXPLORER = "https://testnet.nearblocks.io/txns/";

export const provider = new JsonRpcProvider({ url: RPC });

export async function keyOf(accountId, dir = CREDS) {
  const f = JSON.parse(await readFile(join(dir, `${accountId}.json`), "utf8"));
  return f.private_key;
}

export async function account(accountId, dir = CREDS) {
  return new Account(accountId, provider, await keyOf(accountId, dir));
}

export const view = (method, args = {}) => provider.callFunction({ contractId: TABLE, method, args });

/** The panic message (or other failure) out of a transaction result, or null when it succeeded. */
export function failureOf(res) {
  const all = [res.status, ...(res.receipts_outcome ?? []).map((r) => r.outcome.status)];
  for (const st of all) {
    if (st && st.Failure) {
      const text = JSON.stringify(st.Failure);
      const m = text.match(/Smart contract panicked: ((?:[^"\\]|\\.)*)/);
      return m ? JSON.parse(`"${m[1]}"`) : text;
    }
  }
  return null;
}

export function returnOf(res) {
  const v = res.status?.SuccessValue;
  if (!v) return null;
  try {
    return JSON.parse(Buffer.from(v, "base64").toString());
  } catch {
    return null;
  }
}

/**
 * Sends one function call on the table and reports what happened, without throwing.
 * @returns {{ tx: string|null, failure: string|null, value: any, stage: "chain"|"submission" }}
 */
export async function attempt(acct, method, args, { deposit = 0n, gas = "100" } = {}) {
  for (let tries = 0; ; tries++) {
    try {
      const res = await acct.signAndSendTransaction({
        receiverId: TABLE,
        actions: [actions.functionCall(method, args, teraToGas(gas), deposit)],
        throwOnFailure: false,
        waitUntil: "FINAL",
      });
      return { tx: res.transaction?.hash ?? res.transaction_outcome?.id ?? null, failure: failureOf(res), value: returnOf(res), stage: "chain" };
    } catch (e) {
      const msg = String(e?.message ?? e).split("\n")[0];
      // A transport problem (rate limit, timeout) is not a refusal: retry, and never report it as one.
      if (/-429|rate|Too Many|timeout|ECONNRESET|fetch failed|503|502|504/i.test(msg)) {
        if (tries >= 6) throw new Error(`RPC kept failing for ${method}: ${msg}`);
        await sleep(3000 * (tries + 1));
        continue;
      }
      // Refused before it became a transaction (for example a method the access key does not allow).
      return { tx: null, failure: msg, value: null, stage: "submission" };
    }
  }
}

export const near = (yocto) => (Number(BigInt(yocto) / 10n ** 15n) / 1e9).toFixed(9);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
