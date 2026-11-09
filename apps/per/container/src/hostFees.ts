// Table hosting fees (program: pay_host_fee / agent_pay_host_fee in instructions/agent.rs). When a Quick Play or an
// Agent needs the keeper to host a table, the wallet asking pays the table's rent first, from its game balance and with
// its play key (no wallet prompt), or its Agent pays within its stake. The program moves the fee to the keeper's game
// balance and counts it in the wallet's HostTab; this service counts what it has used of that, so a fee paid for a
// table that failed to open stays as credit for the next one.
import { PublicKey } from "@solana/web3.js";
import { CONFIG_PDA, PROGRAM_ID, coder, l1 } from "./chain";
import { config } from "./config";
import { pool } from "./db";

export const HOST_FEE_MIGRATIONS = [
  `create table if not exists host_credits (
     wallet text primary key,
     used bigint not null default 0,
     updated_at timestamptz not null default now()
   )`,
];

/** What hosting costs the keeper, net (measured 17 Oct 2026 over 46 hosted tables: 0.03004 SOL to create and
 *  delegate, 0.01324 SOL back on reclaim). HOST_FEE_LAMPORTS changes it; the program caps it (config.max_host_fee). */
const DEFAULT_HOST_FEE = 17_000_000n;

export type HostFees = { on: boolean; fee: bigint; hostWallet: PublicKey };
let cache: { at: number; v: HostFees } | null = null;

/** Hosting fees are on when the program's config names this keeper as the hosting wallet and allows a fee. */
export async function hostFees(): Promise<HostFees> {
  if (cache && Date.now() - cache.at < 60_000) return cache.v;
  const info = await l1.getAccountInfo(CONFIG_PDA, "confirmed");
  if (!info) throw new Error("the program's config isn't readable");
  const c: any = coder.decode("config", info.data);
  const hostWallet: PublicKey = c.hostWallet ?? PublicKey.default;
  const max = BigInt((c.maxHostFee ?? 0).toString());
  const want = BigInt(process.env.HOST_FEE_LAMPORTS ?? DEFAULT_HOST_FEE.toString());
  const fee = want < max ? want : max;
  const v = { on: hostWallet.equals(config.keeper.publicKey) && fee > 0n, fee, hostWallet };
  cache = { at: Date.now(), v };
  return v;
}

export const hostTabOf = (wallet: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("host-tab"), wallet.toBuffer()], PROGRAM_ID)[0];

/** HostTab: discriminator, wallet (32), paid (u64). None = 0. */
export function decodeHostTab(d: Buffer | null | undefined): bigint {
  return d && d.length >= 8 + 32 + 8 ? d.readBigUInt64LE(40) : 0n;
}

/** Takes `fee` from the wallet's credit (what it paid on chain minus what was used). False if it hasn't enough. */
export async function reserveHostFee(wallet: string, fee: bigint, paid: bigint): Promise<boolean> {
  await pool.query("insert into host_credits (wallet) values ($1) on conflict do nothing", [wallet]);
  const r = await pool.query(
    "update host_credits set used = used + $2, updated_at = now() where wallet = $1 and used + $2 <= $3 returning used", [wallet, fee.toString(), paid.toString()]);
  return (r.rowCount ?? 0) > 0;
}

/** Gives a reserved fee back as credit (the table didn't open). */
export async function refundHostFee(wallet: string, fee: bigint) {
  await pool.query("update host_credits set used = greatest(used - $2, 0), updated_at = now() where wallet = $1", [wallet, fee.toString()]);
}

export async function creditOf(wallet: string, paid: bigint): Promise<bigint> {
  const r = (await pool.query("select used from host_credits where wallet = $1", [wallet])).rows[0];
  const used = r ? BigInt(r.used) : 0n;
  return paid > used ? paid - used : 0n;
}
