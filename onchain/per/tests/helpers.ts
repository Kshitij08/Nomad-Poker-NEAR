// Shared helpers for the devnet suites: outcome recording, error naming, and the poker-per account
// layout (table, ledger, hands, deck, invites, escrow) for building instructions.
import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { connection, CONFIG_PDA, PROGRAM_ID, idl, programFor, tablePda, TEE_VALIDATOR } from "../scripts/lib";

export type Outcome = { name: string; status: "PASS" | "FAIL" | "KNOWN"; detail: any };
export const BN = (n: number | bigint) => new anchor.BN(n.toString());
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const ESPL = new PublicKey("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2");
export const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
export const dlpPda = (tag: string, acct: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from(tag), acct.toBuffer()], DLP)[0];
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

export const ledgerOf = (t: PublicKey) => pda([Buffer.from("ledger"), t.toBuffer()]);
export const deckOf = (t: PublicKey) => pda([Buffer.from("deck"), t.toBuffer()]);
export const handOf = (t: PublicKey, seat: number) => pda([Buffer.from("hand"), t.toBuffer(), Buffer.from([seat])]);
export const invitesOf = (t: PublicKey) => pda([Buffer.from("invites"), t.toBuffer()]);
export const recordOf = (t: PublicKey) => pda([Buffer.from("record"), t.toBuffer()]);
export const logOf = (t: PublicKey) => pda([Buffer.from("log"), t.toBuffer()]);
/** Engine action kinds (engine.rs; same order as the C# ActionType). */
export const KIND = { fold: 0, check: 1, call: 2, bet: 3, raise: 4, allIn: 5 } as const;
/** act/timeout may run a showdown (every remaining hand evaluated), so they get a large budget. */
export const PLAY_CU = 1_400_000;
export const EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
export const escapePayerOf = (t: PublicKey) => pda([Buffer.from("escape-payer"), t.toBuffer()]);
export const escrowOf = (t: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, t, true);
export const tokenOf = (k: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, k);
export const inviteHash = (t: PublicKey, wallet: PublicKey) => Array.from(createHash("sha256").update(t.toBuffer()).update(wallet.toBuffer()).digest());
export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
export const rollup = { magicProgram: MAGIC_PROGRAM_ID, vault: EPHEMERAL_VAULT, permissionProgram: PERMISSION_PROGRAM_ID };
// Each wallet's reader key for this run (one per wallet, reused across this run's tables, which is
// fine for tests). A real client must make a fresh reader per table and seat, so a reader key never
// links two tables.
const RUN_SALT = Keypair.generate().publicKey.toBuffer();
export const readerFor = (player: PublicKey) => Keypair.fromSeed(createHash("sha256").update(RUN_SALT).update(player.toBuffer()).digest());

// The TEE rollup hides transaction logs, so Anchor can't build an AnchorError there and throws a
// ProgramError with only a numeric code. Map codes back to names from our IDL and Anchor's own list.
const codeNames = new Map<number, string>([
  ...(idl.errors ?? []).map((x: any) => [x.code, x.name] as [number, string]),
  ...Object.entries(anchor.LangErrorCode).map(([n, c]) => [c as number, n] as [number, string]),
]);
export function errName(e: any): string {
  const code = e?.error?.errorCode?.code;
  if (code) return `${code} (${e.error.errorCode.number})`;
  if (typeof e?.code === "number") return `${codeNames.get(e.code) ?? "Unknown"} (${e.code})`;
  const logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
  const hit = logs.find((l) => /Error Code|custom program error|insufficient|failed|already/i.test(l));
  return hit ?? String(e?.message ?? e).slice(0, 300);
}

export class Suite {
  outcomes: Outcome[] = [];
  constructor(private name: string) {}
  async ok(name: string, fn: () => Promise<string>, check?: () => Promise<string | null>) {
    try {
      const sig = await fn();
      const problem = check ? await check() : null;
      this.outcomes.push({ name, status: problem ? "FAIL" : "PASS", detail: { sig, problem } });
      return sig;
    } catch (e: any) { this.outcomes.push({ name, status: "FAIL", detail: { unexpectedError: errName(e) } }); return ""; }
  }
  async err(name: string, expected: string, fn: () => Promise<string>) {
    try { const sig = await fn(); this.outcomes.push({ name, status: "FAIL", detail: { expected, butSucceeded: sig } }); }
    catch (e: any) { const got = errName(e); this.outcomes.push({ name, status: got.includes(expected) ? "PASS" : "FAIL", detail: { expected, got } }); }
  }
  check(name: string, pass: boolean, detail: any) { this.outcomes.push({ name, status: pass ? "PASS" : "FAIL", detail }); }
  /** A platform issue we can't fix ourselves: KNOWN while it still reproduces (doesn't fail the run), PASS once it's fixed. */
  known(name: string, stillThere: boolean, detail: any) { this.outcomes.push({ name, status: stillThere ? "KNOWN" : "PASS", detail }); }
  finish(extra: any) {
    const failed = this.outcomes.filter((o) => o.status === "FAIL").length;
    const known = this.outcomes.filter((o) => o.status === "KNOWN").length;
    const summary = { suite: this.name, program: PROGRAM_ID.toBase58(), ranAt: new Date().toISOString(), pass: this.outcomes.length - failed - known, fail: failed, knownPlatformIssues: known, ...extra, outcomes: this.outcomes };
    const out = path.join(__dirname, "../results", `${this.name}-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(summary, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    for (const o of this.outcomes) console.log(`${o.status.padEnd(5)} ${o.name}${o.status === "FAIL" ? "  " + JSON.stringify(o.detail) : ""}`);
    console.log(`\n${summary.pass} passed, ${failed} failed${known ? `, ${known} known platform issues` : ""} -> ${path.relative(process.cwd(), out)}`);
    process.exit(failed ? 1 : 0);
  }
}

export const sendL1 = (tx: Transaction, signers: Keypair[]) => anchor.web3.sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });

export const CREATE_TABLE_CU = 400_000;

/** Instruction builders for one table. */
export function tableApi(creator: Keypair, tableId: bigint) {
  const table = tablePda(creator.publicKey, tableId);
  const escrow = escrowOf(table);
  const [escrowEata] = PublicKey.findProgramAddressSync([table.toBuffer(), NATIVE_MINT.toBuffer()], ESPL);
  const ledger = ledgerOf(table), deck = deckOf(table), record = recordOf(table), log = logOf(table);
  const play = (signer: PublicKey) => ({ signer, table, ledger, deck, record, log });
  return {
    table, escrow, escrowEata, ledger, deck, record, log,
    // create_table uses 124k-202k compute units depending on the id (PDA bump searches), so it always
    // gets an explicit limit above the 200k default. Measured by scripts/cu-create-table.ts.
    create: (params: any, signer = creator, mint = NATIVE_MINT) => programFor(signer).methods.createTable(BN(tableId), params)
      .accountsPartial({ creator: signer.publicKey, config: CONFIG_PDA, table, mint, escrow, escrowEata })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: CREATE_TABLE_CU })]).rpc(),
    createTx: (params: any, signer = creator, mint = NATIVE_MINT) => programFor(signer).methods.createTable(BN(tableId), params)
      .accountsPartial({ creator: signer.publicKey, config: CONFIG_PDA, table, mint, escrow, escrowEata }).transaction(),
    delegate: (payer: Keypair = creator, validator = TEE_VALIDATOR) => programFor(payer).methods.delegateTable(BN(tableId), creator.publicKey)
      .accountsPartial({ payer: payer.publicKey, table, escapePayer: escapePayerOf(table), validator }).rpc(),
    open: (prog: anchor.Program, payer: PublicKey) => prog.methods.openTable()
      .accountsPartial({ payer, table, ledger, ledgerPermission: permissionPdaFromAccount(ledger), deck, deckPermission: permissionPdaFromAccount(deck), record, log, logPermission: permissionPdaFromAccount(log), rollup }).rpc(),
    commitSeed: (prog: anchor.Program, player: PublicKey, seat: number, seed: Buffer) => prog.methods.commitSeed(seat, Array.from(seed))
      .accountsPartial({ player, table, deck, hand: handOf(table, seat) }).rpc(),
    startHand: (prog: anchor.Program, payer: PublicKey) => prog.methods.startHand()
      .accountsPartial({ payer, config: CONFIG_PDA, table, deck, ledger, oracleQueue: EPHEMERAL_QUEUE }).rpc(),
    abortHand: (prog: anchor.Program, signer: PublicKey) => prog.methods.abortHand().accountsPartial({ signer, table }).rpc(),
    beginHand: (prog: anchor.Program, signer: PublicKey) => prog.methods.beginHand()
      .accountsPartial({ play: play(signer), logPermission: permissionPdaFromAccount(log), rollup } as any)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: PLAY_CU })]).rpc(),
    act: (prog: anchor.Program, signer: PublicKey, seat: number, kind: number, amount: bigint | number = 0) => prog.methods.act(seat, kind, BN(amount))
      .accountsPartial(play(signer)).preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: PLAY_CU })]).rpc(),
    actTx: (prog: anchor.Program, signer: PublicKey, seat: number, kind: number, amount: bigint | number = 0, units = PLAY_CU) => prog.methods.act(seat, kind, BN(amount))
      .accountsPartial(play(signer)).preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units })]).transaction(),
    timeout: (prog: anchor.Program, signer: PublicKey) => prog.methods.timeout()
      .accountsPartial(play(signer)).preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: PLAY_CU })]).rpc(),
    buyIn: (prog: anchor.Program, player: PublicKey, seat: number, amount: bigint, overrides: any = {}) => {
      const hand = handOf(table, seat);
      const { reader = readerFor(player).publicKey, ...accounts } = overrides;
      return prog.methods.buyIn(seat, BN(amount), reader).accountsPartial({
        player, config: CONFIG_PDA, table, ledger, ledgerPermission: permissionPdaFromAccount(ledger), hand, handPermission: permissionPdaFromAccount(hand),
        invites: null, playerToken: tokenOf(player), escrow, rollup, ...accounts,
      }).rpc();
    },
    cashOut: (prog: anchor.Program, player: PublicKey, seat: number, overrides: any = {}) => {
      const hand = handOf(table, seat);
      return prog.methods.cashOut(seat).accountsPartial({
        player, table, ledger, ledgerPermission: permissionPdaFromAccount(ledger), hand, handPermission: permissionPdaFromAccount(hand),
        playerToken: tokenOf(player), escrow, rollup, ...overrides,
      }).rpc();
    },
    collectRake: (prog: anchor.Program, devToken: PublicKey) => prog.methods.collectRake()
      .accountsPartial({ config: CONFIG_PDA, table, ledger, escrow, devToken, magicProgram: MAGIC_PROGRAM_ID }).rpc(),
    commit: (prog: anchor.Program, payer: PublicKey) => prog.methods.commitTable().accountsPartial({ payer, table }).rpc(),
    close: (prog: anchor.Program, signer: PublicKey) => prog.methods.closeTable().accountsPartial({
      creator: signer, table, ledger, ledgerPermission: permissionPdaFromAccount(ledger), deck, deckPermission: permissionPdaFromAccount(deck), record, log, logPermission: permissionPdaFromAccount(log),
      vault: EPHEMERAL_VAULT, permissionProgram: PERMISSION_PROGRAM_ID,
    }).rpc(),
    request: (signer: Keypair) => programFor(signer).methods.requestTableUndelegation(BN(tableId), creator.publicKey).accountsPartial({
      requester: signer.publicKey, config: CONFIG_PDA, table, escapePayer: escapePayerOf(table), ownerProgram: PROGRAM_ID,
      undelegationRequest: dlpPda("undelegation-request", table), delegationRecord: dlpPda("delegation", table), delegationMetadata: dlpPda("delegation-metadata", table), delegationProgram: DLP,
    }).rpc(),
    setInvites: (hashes: number[][]) => programFor(creator).methods.setInvites(BN(tableId), hashes)
      .accountsPartial({ creator: creator.publicKey, table, invites: invitesOf(table) }).rpc(),
  };
}

/** Raw getAccountInfo, so a result shows exactly what the RPC returned. */
export async function rawRead(url: string, account: PublicKey): Promise<{ visible: boolean; dataLen?: number; data?: Buffer }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [account.toBase58(), { encoding: "base64", commitment: "confirmed" }] }) });
  const j: any = await res.json();
  const v = j.result?.value;
  if (!v) return { visible: false };
  const data = Buffer.from(v.data[0], "base64");
  return { visible: true, dataLen: data.length, data };
}

export const connUrl = (c: Connection) => (c as any)._rpcEndpoint as string;
