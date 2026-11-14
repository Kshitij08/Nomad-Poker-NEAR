// Reads go straight to a NEAR RPC node; writes go through the user's wallet (NEAR Connect).
import { NearConnector } from "@hot-labs/near-connect";
import { JsonRpcProvider } from "near-api-js";
import { CONTRACT, NETWORK, RPC, TGAS } from "./config";

const provider = new JsonRpcProvider({ url: RPC });

export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId: CONTRACT, method, args })) as T;
}

export type Agent = { id: string; owner: string; tight: number; aggro: number; sessions: number; hands: number; net_chips: number };
export type Pool = { shares: string; value: string; price: string; hwm_price: string; at_table: string; max_buy_in_bps: number; sessions: number; pending_in: string };
export type AgentCard = { agent: Agent; pool: Pool | null };
export type Holding = { shares: string; value: string; pending_in: string; pending_out_shares: string };
export type Position = { balance: string; at_table: string; net: string; deposited: string; sessions: number };
export type SessionSummary = { session_id: string; settled_at: string; hands: number; agents: string[]; end_stacks: number[] };
export type Payout = { backer: string | null; agent: string; pro: string; buy_in: string; cash_out: string; pro_fee: string; platform_fee: string; to_backer: string };
export type SessionRecord = {
  session_id: string;
  settled_at: string;
  stacks: number[];
  button: number;
  sb: number;
  bb: number;
  hands: number;
  alpha: string;
  signature_hex: string;
  actions: string;
  end_stacks: number[];
  payouts: { seats: Payout[] } | null;
};

export const listAgents = () => view<AgentCard[]>("list_agents", { limit: 100 });
export const recentSessions = (limit = 10) => view<SessionSummary[]>("recent_sessions", { limit });
export const sessionRecord = (session_id: string) => view<SessionRecord | null>("get_session_record", { session_id });
export const holding = (account: string, agent_id: string) => view<Holding>("get_holding", { account, agent_id });
export const position = (backer: string, agent_id: string) => view<Position | null>("get_position", { backer, agent_id });
export const earnings = (account: string) => view<string>("get_earnings", { account });

// ------------------------------------------------------------------------------------------------ wallet

const connector = new NearConnector({ network: NETWORK, autoConnect: true, providers: { testnet: [RPC] } });
type Listener = (account: string | null) => void;
const listeners = new Set<Listener>();
let account: string | null = null;

function setAccount(a: string | null) {
  account = a;
  listeners.forEach((l) => l(a));
}

connector.on("wallet:signIn", (p) => setAccount(p.accounts[0]?.accountId ?? null));
connector.on("wallet:signOut", () => setAccount(null));

export const currentAccount = () => account;
export function onAccount(l: Listener) {
  listeners.add(l);
  l(account);
}

export async function restoreWallet() {
  try {
    const w = await connector.wallet();
    const accounts = await w.getAccounts();
    setAccount(accounts[0]?.accountId ?? null);
  } catch {
    setAccount(null);
  }
}

export async function signIn() {
  const w = await connector.connect();
  const accounts = await w.getAccounts();
  setAccount(accounts[0]?.accountId ?? null);
}

export async function signOut() {
  const w = await connector.wallet().catch(() => null);
  if (w) await connector.disconnect(w);
  setAccount(null);
}

/** Calls a contract method through the user's wallet. `deposit` is in yoctoNEAR. */
export async function call(methodName: string, args: Record<string, unknown>, deposit = 0n, tgas = 50n) {
  const w = await connector.wallet();
  return w.signAndSendTransaction({
    receiverId: CONTRACT,
    actions: [{ type: "FunctionCall", params: { methodName, args, gas: String(tgas * TGAS), deposit: String(deposit) } }],
  });
}
