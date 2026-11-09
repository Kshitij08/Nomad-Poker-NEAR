// Background withdrawals (new test program): finishes "Withdraw all" without the wallet. After the wallet approves
// vault_exit, MagicBlock's shuttle lands the SOL on the wallet's vault PDA on Solana; the keeper then sends
// vault_payout_to_owner (it signs and pays the fee; the program sends the SOL only to the vault's own wallet).
// The game registers the withdrawal (POST /vault/payout, signed by its play key) and asks again while it waits; this
// job also pays out registered withdrawals while the game is closed.
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { PROGRAM_ID, l1 } from "./chain";
import { config } from "./config";
import { event, pool } from "./db";
import idl from "./shared/poker_per.json";

export const PAYOUT_MIGRATIONS = [
  `create table if not exists vault_payouts (
     wallet text primary key,
     expected bigint not null,
     paid bigint not null default 0,
     landed bigint not null default 0,
     registered_at timestamptz not null default now(),
     landed_changed_at timestamptz not null default now(),
     last_paid_at timestamptz,
     done boolean not null default false
   )`,
  `alter table vault_payouts add column if not exists last_checked_at timestamptz`,
];

/** As the game (PerWithdrawal.cs): when only part arrived and nothing more for a while, that part is paid out. */
const PARTIAL_QUIET_MS = 60_000, PARTIAL_MIN_MS = 90_000;
/** A registered withdrawal nothing arrives for is dropped after this long. */
const GIVE_UP_MS = 60 * 60_000;
/** After a partial payout, the rest is watched this long after the last activity (as PerWithdrawal.cs), then the row
 *  finishes: less can land than the game expected (fees on the way), and an open row must not wait forever. */
const PAID_QUIET_MS = 15 * 60_000;

const pda = (...s: Buffer[]) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];

/** The wallet's current vault PDA (its wallet state's seed; none = the first vault). */
async function vaultOf(wallet: PublicKey): Promise<{ vault: PublicKey; walletState: PublicKey }> {
  const walletState = pda(Buffer.from("wallet"), wallet.toBuffer());
  const ws = await l1.getAccountInfo(walletState, "confirmed");
  const seed = ws && ws.data.length >= 52 ? Buffer.from(ws.data.subarray(44, 52)) : Buffer.alloc(8);
  const vault = seed.every((b) => b === 0) ? pda(Buffer.from("vault"), wallet.toBuffer()) : pda(Buffer.from("vault"), wallet.toBuffer(), seed);
  return { vault, walletState };
}

/** SOL waiting at the wallet's vault on Solana. */
export async function landedOf(wallet: PublicKey): Promise<bigint> {
  return BigInt(await l1.getBalance((await vaultOf(wallet)).vault, "confirmed"));
}

/** Sends vault_payout_to_owner (the keeper signs and pays the fee). Returns what the wallet received. */
async function payOut(wallet: PublicKey): Promise<bigint> {
  const { vault, walletState } = await vaultOf(wallet);
  const before = BigInt(await l1.getBalance(vault, "confirmed"));
  if (before === 0n) return 0n;
  const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(l1, new anchor.Wallet(config.keeper), { commitment: "confirmed" }));
  const ix = await program.methods.vaultPayoutToOwner().accountsPartial({ payer: config.keeper.publicKey, wallet, walletState, vault, systemProgram: SystemProgram.programId } as any).instruction();
  await anchor.web3.sendAndConfirmTransaction(l1, new Transaction().add(ix), [config.keeper], { commitment: "confirmed" });
  await event(null, "vault payout", true, `${wallet.toBase58().slice(0, 6)}… received ${before}`);
  return before;
}

type Row = { wallet: string; expected: string; paid: string; landed: string; registered_at: Date; landed_changed_at: Date; last_paid_at: Date | null; done: boolean };

/** Updates a registered withdrawal from its vault and pays out when it's ready (or when `ready`, the game's own call). */
async function step(row: Row, ready = false): Promise<Row> {
  const wallet = new PublicKey(row.wallet);
  const landed = await landedOf(wallet);
  const now = Date.now();
  if (landed !== BigInt(row.landed)) {
    row = (await pool.query("update vault_payouts set landed = $2, landed_changed_at = now() where wallet = $1 returning *", [row.wallet, landed.toString()])).rows[0];
  }
  const expected = BigInt(row.expected), paid = BigInt(row.paid);
  const due = landed > 0n && (ready || paid + landed >= expected
    || (now - new Date(row.landed_changed_at).getTime() >= PARTIAL_QUIET_MS && now - new Date(row.registered_at).getTime() >= PARTIAL_MIN_MS));
  if (due) {
    const got = await payOut(wallet);
    const total = paid + got;
    row = (await pool.query("update vault_payouts set paid = $2, landed = 0, last_paid_at = now(), done = $3 where wallet = $1 returning *",
      [row.wallet, total.toString(), total >= expected])).rows[0];
  } else {
    // Review H6: a row with a partial payout used to stay open for good (only paid = 0 ever gave up), and 20 such rows
    // stopped background withdrawals for everyone. Any row finishes once nothing has happened for a while.
    const last = Math.max(new Date(row.registered_at).getTime(), new Date(row.landed_changed_at).getTime(),
      row.last_paid_at ? new Date(row.last_paid_at).getTime() : 0);
    if (now - last > (paid > 0n ? PAID_QUIET_MS : GIVE_UP_MS))
      row = (await pool.query("update vault_payouts set done = true where wallet = $1 returning *", [row.wallet])).rows[0];
  }
  return row;
}

/** POST /vault/payout (signed by the wallet's play key): `expected` (lamports) registers a new withdrawal; `ready`
 *  asks to pay out what has arrived now. Returns what was paid so far and whether it's done. */
export async function payoutRoute(wallet: PublicKey, data: any) {
  const w = wallet.toBase58();
  if (data?.expected !== undefined) {
    const expected = BigInt(String(data.expected));
    if (expected <= 0n || expected > 100_000_000_000n) throw new Error("bad expected amount");
    // A new withdrawal replaces a finished one; one in progress keeps counting (the game asked again).
    await pool.query(
      `insert into vault_payouts (wallet, expected) values ($1, $2)
       on conflict (wallet) do update set expected = $2, paid = 0, landed = 0, registered_at = now(), landed_changed_at = now(), last_paid_at = null, done = false
       where vault_payouts.done
          or greatest(vault_payouts.registered_at, vault_payouts.landed_changed_at, coalesce(vault_payouts.last_paid_at, vault_payouts.registered_at)) < now() - interval '15 minutes'`,
      [w, expected.toString()]);
  }
  let row: Row | undefined = (await pool.query("select * from vault_payouts where wallet = $1", [w])).rows[0];
  if (!row) return { registered: false, paid: "0", done: true, landed: (await landedOf(wallet)).toString() };
  if (!row.done) row = await step(row, data?.ready === true);
  return { registered: true, paid: row.paid, expected: row.expected, done: row.done, landed: row.landed };
}

let lastRun = 0;
/** Pays out registered withdrawals (at most every 10 s; run by the instance that runs the Agents). */
export async function stepPayouts() {
  if (Date.now() - lastRun < 10_000) return;
  lastRun = Date.now();
  // Round-robin: the rows checked longest ago first, so a few slow rows can't starve the rest.
  const rows: Row[] = (await pool.query(
    "update vault_payouts set last_checked_at = now() where wallet in (select wallet from vault_payouts where not done order by last_checked_at nulls first limit 20) returning *")).rows;
  for (const r of rows) {
    try { await step(r); } catch (e: any) { await event(null, "vault payout", false, `${r.wallet.slice(0, 6)}…: ${String(e?.message ?? e).slice(0, 200)}`); }
  }
}
