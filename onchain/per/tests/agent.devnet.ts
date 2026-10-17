// Agents v2 devnet suite: copy-strategy fees on SOL tables (instructions/agent.rs). A copier's play key sets an Agent
// with a strategy's fee terms; the Agent plays real hands; each agent_cash_out pays the creator's and Nomad's shares of
// new profit above the high-water mark into their game balances, and nothing on losses. Also covers the terms checks
// (one creator share for every strategy), the locked terms while seated, the fee accounts, the player taking the seat
// back (only through agent_cash_out, which charges the same share; the plain cash-out refuses an Agent's seat), table
// hosting fees (pay_host_fee, agent_pay_host_fee), stopping and closing. Run it against the new test program only: it
// sets the config's fees for the run (admin = deployer) and puts the old values back at the end. The first test refuses to go on if the TEE still runs an older build (memory: tee-program-reload).
// Runs with the backend's keeper on (it may begin a dealt hand or time out a slow player; steps accept either).
// Writes results/agent-<ts>.json.   Run: npx tsx tests/agent.devnet.ts
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { randomBytes } from "crypto";
import { CONFIG_PDA, PROGRAM_ID, connection, loadKey, programFor, programOn, randomTableId, teeConnection } from "../scripts/lib";
import { BN, KIND, Suite, errName, handOf, rawRead, rollup, sendL1, sleep, tableApi, tokenOf, connUrl } from "./helpers";
import { depositToVaultIxs, openVaultAccounts, playKeyMessage, proofIx, vaultOf, vaultTokenOf, walletStateOf } from "../client-web/vault";

const S = new Suite("agent");
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const HAND_IDLE = 0, HAND_PLAYING = 3;
const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const agentStateOf = (w: PublicKey) => pda(Buffer.from("agent2"), w.toBuffer());
const SPONSOR = pda(Buffer.from("agent-sponsor"));
const NONE = PublicKey.default;

/** The v2 record at the offsets the program's record_layout test pins. */
function decodeAgent(d: Buffer | null | undefined) {
  if (!d || d.length < 254) return null;
  const key = (o: number) => new PublicKey(d.subarray(o, o + 32));
  return {
    agent: key(40), stake: d.readBigUInt64LE(84), committed: d.readBigUInt64LE(92), table: key(100), seat: d[132], reader: key(133),
    creator: key(166), creatorFeeBps: d.readUInt16LE(198), platformFeeBps: d.readUInt16LE(200),
    seatIn: d.readBigUInt64LE(202), netIn: d.readBigUInt64LE(210), netOut: d.readBigUInt64LE(218), highWater: d.readBigInt64LE(226),
  };
}

/** AgentState::settle, for checking what a cash-out paid. */
function expectedFees(r: { creatorFeeBps: number; platformFeeBps: number; netIn: bigint; netOut: bigint; highWater: bigint }, buyIn: bigint, stack: bigint) {
  const net = r.netOut + stack - (r.netIn + buyIn);
  if (net <= r.highWater) return { profit: 0n, creator: 0n, platform: 0n };
  let profit = net - r.highWater;
  if (profit > stack) profit = stack;
  return { profit, creator: (profit * BigInt(r.creatorFeeBps)) / 10_000n, platform: (profit * BigInt(r.platformFeeBps)) / 10_000n };
}

async function newPlayer(deployer: Keypair, sol: number) {
  const wallet = Keypair.generate(), key = Keypair.generate();
  await sendL1(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: wallet.publicKey, lamports: Math.round(sol * LAMPORTS_PER_SOL) })), [deployer]);
  return { wallet, key, exp: now() + DAY, er: programOn(await teeConnection(key), key) };
}
type Player = Awaited<ReturnType<typeof newPlayer>>;
const W = (p: { wallet: Keypair }) => p.wallet.publicKey;
const proof = (p: Player) => { const m = playKeyMessage(p.key.publicKey, p.exp); return proofIx(W(p), m, nacl.sign.detached(m, p.wallet.secretKey)); };

async function main() {
  const deployer = loadKey("deployer");
  const l1 = programFor(deployer);
  const coder = l1.coder.accounts as any;
  const cfg: any = await (l1.account as any).config.fetch(CONFIG_PDA);
  const treasury: PublicKey = cfg.devWallet;
  const platformBps = Number(cfg.agentFeeBps ?? 0) || 200;
  const creatorBps = Number(cfg.creatorFeeBps ?? 0) || 800;
  const setFees = (f: { platformFeeBps: number; creatorFeeBps: number; hostWallet: PublicKey; maxHostFee: bigint }, admin = deployer) =>
    programFor(admin).methods.setFees({ ...f, maxHostFee: BN(f.maxHostFee) }).accountsPartial({ admin: admin.publicKey, config: CONFIG_PDA }).rpc();
  const savedFees = { platformFeeBps: Number(cfg.agentFeeBps ?? 0), creatorFeeBps: Number(cfg.creatorFeeBps ?? 0), hostWallet: cfg.hostWallet as PublicKey, maxHostFee: BigInt((cfg.maxHostFee ?? 0).toString()) };

  const C = await newPlayer(deployer, 0.09); // the copier
  const K = await newPlayer(deployer, 0.02); // the strategy's creator
  const O = await newPlayer(deployer, 0.09); // an opponent
  const G = Keypair.generate(); // the Agent key (the runner's)
  const gEr = programOn(await teeConnection(G), G);
  const openVault = async (w: Keypair) => sendL1(new Transaction().add(await programFor(w).methods.openVault().accountsPartial(openVaultAccounts(w.publicKey)).instruction()), [w]);
  await S.ok("copier, creator and opponent open their game balances; the copier and opponent deposit 0.06 SOL", async () => {
    await openVault(C.wallet); await openVault(K.wallet); await openVault(O.wallet);
    await sendL1(new Transaction().add(...depositToVaultIxs(W(C), 60_000_000n)), [C.wallet]);
    return sendL1(new Transaction().add(...depositToVaultIxs(W(O), 60_000_000n)), [O.wallet]);
  });
  // Nomad's share goes to config.dev_wallet's game balance. The suite can open it only when it holds that key.
  const treasuryOpen = treasury.equals(deployer.publicKey);
  if (treasuryOpen) await S.ok("the treasury (config.dev_wallet = deployer) has a game balance", () => openVault(deployer));

  // Balances, read with each wallet's play key (vault_balance, simulated).
  const balance = async (p: Player) => {
    const tx = await p.er.methods.vaultBalance(BN(p.exp)).accountsPartial({ playKey: p.key.publicKey, wallet: W(p), vault: vaultOf(W(p)), vaultToken: vaultTokenOf(W(p)), instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
      .preInstructions([proof(p)]).transaction();
    const conn = p.er.provider.connection;
    tx.feePayer = p.key.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(p.key);
    const v = (await conn.simulateTransaction(tx)).value as any;
    if (v.err) throw new Error(JSON.stringify(v.err));
    return Buffer.from(v.returnData.data[0], "base64").readBigUInt64LE(0);
  };
  const D: Player = { wallet: deployer, key: Keypair.generate(), exp: now() + DAY, er: null as any };
  D.er = programOn(await teeConnection(D.key), D.key);
  const treasuryBalance = async () => (treasuryOpen ? balance(D) : 0n);
  let bc = 0n;
  for (let i = 0; i < 15 && bc !== 60_000_000n; i++) { await sleep(4000); bc = await balance(C).catch(() => -1n); }
  S.check("the deposits reached the rollup", bc === 60_000_000n, { copier: bc.toString() });

  // ---- agent_set with fee terms (the copier's play key signs: its consent)
  const terms = (creator: PublicKey, creatorFeeBps: number, platformFeeBps: number) => ({ creator, creatorFeeBps, platformFeeBps });
  const TERMS = terms(W(K), creatorBps, platformBps);
  const setIx = (p: Player, agent: PublicKey, until: number, stake: bigint, t = terms(NONE, 0, 0)) => p.er.methods.agentSet(BN(p.exp), agent, BN(until), BN(stake), t).accountsPartial({
    playKey: p.key.publicKey, wallet: W(p), walletState: walletStateOf(W(p)), instructions: SYSVAR_INSTRUCTIONS_PUBKEY, agentState: agentStateOf(W(p)),
    agentPermission: permissionPdaFromAccount(agentStateOf(W(p))), sponsor: SPONSOR, vault: vaultOf(W(p)), vaultToken: vaultTokenOf(W(p)), config: CONFIG_PDA, rollup,
  }).preInstructions([proof(p)]);
  const set = (p: Player, agent: PublicKey, stake: bigint, t?: ReturnType<typeof terms>) => setIx(p, agent, now() + 3600, stake, t).rpc();
  const STAKE = 40_000_000n;

  // The TEE must run this build (it once kept an old one through 7 upgrades). An old build can't even parse the args.
  const probe = await set(C, G.publicKey, STAKE, terms(W(K), 800, 0)).then(() => "accepted", (e) => errName(e));
  S.check("the TEE runs the Agents v2 build (bad terms refused with BadFeeTerms, not a parse error)", probe.includes("BadFeeTerms"), { probe });
  if (!probe.includes("BadFeeTerms")) { S.finish({ aborted: "the TEE doesn't run the new build yet" }); return; }

  {
    const tx = await setIx(C, G.publicKey, now() + 3600, STAKE, TERMS).transaction();
    const conn = C.er.provider.connection;
    tx.feePayer = C.key.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(C.key);
    const size = tx.serialize().length;
    S.check("agent_set with fee terms and the wallet's signature check fits Solana's 1,232 bytes", size <= 1232, { bytes: size });
  }
  await S.err("terms without Nomad's share: refused", "BadFeeTerms", () => set(C, G.publicKey, STAKE, terms(W(K), creatorBps, 0)));
  await S.err("Nomad's share other than the config's: refused", "BadFeeTerms", () => set(C, G.publicKey, STAKE, terms(W(K), creatorBps, platformBps + 1)));
  await S.err("copying yourself: refused", "BadFeeTerms", () => set(C, G.publicKey, STAKE, terms(W(C), creatorBps, platformBps)));
  await S.err("a creator share other than the config's (one share for every strategy): refused", "BadFeeTerms", () => set(C, G.publicKey, STAKE, terms(W(K), creatorBps + 100, platformBps)));
  await S.err("a lower creator share: refused too", "BadFeeTerms", () => set(C, G.publicKey, STAKE, terms(W(K), creatorBps - 100, platformBps)));
  await S.err("shares without a creator: refused", "BadFeeTerms", () => set(C, G.publicKey, STAKE, terms(NONE, creatorBps, platformBps)));
  await S.ok("the copier sets the Agent with the strategy's terms (8% creator, Nomad's share)", () => set(C, G.publicKey, STAKE, TERMS));
  const readRecord = async (conn = gEr.provider.connection) => decodeAgent((await conn.getAccountInfo(agentStateOf(W(C)), "processed"))?.data);
  const r0 = await readRecord();
  S.check("the record carries the terms; counts start at zero", !!r0 && r0.creator.equals(W(K)) && r0.creatorFeeBps === creatorBps && r0.platformFeeBps === platformBps && r0.netIn === 0n && r0.highWater === 0n, r0);

  // ---- a table: blinds 0.001/0.002, buy-ins 0.01..0.04
  const T = tableApi(deployer, randomTableId());
  const erD = programOn(await teeConnection(deployer), deployer);
  await S.ok("create, delegate and open a table", async () => {
    await T.create({ smallBlind: BN(1_000_000), bigBlind: BN(2_000_000), minBuyIn: BN(10_000_000), maxBuyIn: BN(40_000_000), maxSeats: 6, inviteOnly: false });
    await T.delegate(); await sleep(4000);
    return T.open(erD, deployer.publicKey);
  });
  const AG = 0, OPP = 1, BUY = 10_000_000n;
  const oReader = Keypair.generate();
  const oEr = programOn(await teeConnection(oReader), oReader);
  await S.ok("the opponent sits down from its game balance (play key)", () => {
    const hand = handOf(T.table, OPP);
    return O.er.methods.vaultBuyIn(OPP, BN(30_000_000n), oReader.publicKey, BN(O.exp)).accountsPartial({
      playKey: O.key.publicKey, wallet: W(O), vault: vaultOf(W(O)), vaultToken: vaultTokenOf(W(O)), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      config: CONFIG_PDA, table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), hand, handPermission: permissionPdaFromAccount(hand),
      invites: null, escrow: T.escrow, rollup,
    }).preInstructions([proof(O)]).rpc();
  });

  const agentBuyIn = (reader: PublicKey) => {
    const hand = handOf(T.table, AG);
    return gEr.methods.agentBuyIn(AG, BN(BUY), reader).accountsPartial({
      agentKey: G.publicKey, wallet: W(C), agentState: agentStateOf(W(C)), vault: vaultOf(W(C)), walletState: walletStateOf(W(C)), vaultToken: vaultTokenOf(W(C)),
      config: CONFIG_PDA, table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), hand, handPermission: permissionPdaFromAccount(hand),
      invites: null, escrow: T.escrow, rollup,
    }).rpc();
  };
  const feeAccounts = { creatorWalletState: walletStateOf(W(K)), creatorVaultToken: vaultTokenOf(W(K)), treasuryWalletState: walletStateOf(treasury), treasuryVaultToken: vaultTokenOf(treasury) };
  // Signed by the seat's table key (`prog` is logged in as it), as the runner does; or by the copier's play key
  // (`player`: with its signed message), the player taking the seat back.
  const agentCashOut = (prog: any, fees: any = feeAccounts, player = false) => {
    const hand = handOf(T.table, AG);
    const m = (player ? C.er : prog).methods.agentCashOut(AG, BN(player ? C.exp : 0)).accountsPartial({
      signer: player ? C.key.publicKey : prog.provider.publicKey, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, wallet: W(C), agentState: agentStateOf(W(C)), vault: vaultOf(W(C)), walletState: walletStateOf(W(C)), vaultToken: vaultTokenOf(W(C)),
      table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), hand, handPermission: permissionPdaFromAccount(hand), escrow: T.escrow,
      config: CONFIG_PDA, ...fees, rollup,
    });
    return (player ? m.preInstructions([proof(C)]) : m).rpc();
  };

  // Plays one heads-up hand. `agentWins`: the opponent folds at its every turn and the Agent checks or calls; else the
  // Agent folds at its turn and the opponent checks or calls. Returns when the hand is over.
  const readTable = async () => coder.decode("table", (await erD.provider.connection.getAccountInfo(T.table, "processed"))!.data);
  const playHand = async (agentReader: Keypair, aEr: any, agentWins: boolean) => {
    const t0 = await readTable();
    const hand = Number(t0.handNo) + 1;
    await T.commitSeed(aEr, agentReader.publicKey, AG, randomBytes(32));
    await T.commitSeed(oEr, oReader.publicKey, OPP, randomBytes(32));
    if (Number(t0.startRequestedFor) === 0) await T.requestStart(oEr, oReader.publicKey).catch(() => {});
    await T.startHand(oEr, oReader.publicKey);
    const start = Date.now();
    while (Date.now() - start < 90_000) {
      const t = await readTable();
      if (Number(t.handNo) === hand && t.handState === HAND_IDLE) return;
      if (Number(t.handNo) === hand && t.handState === 2) { await T.beginHand(oEr, oReader.publicKey).catch(() => {}); continue; } // dealt: begin (or the keeper does)
      if (Number(t.handNo) === hand && t.handState === HAND_PLAYING) {
        const g = coder.decode("ledger", (await rawRead(connUrl(oEr.provider.connection), T.ledger)).data!).game;
        const toAct = g.toAct;
        const mine = toAct === AG;
        const folds = mine !== agentWins; // the loser folds
        const seatBet = BigInt(g.seats[toAct].currentBet.toString()), high = BigInt(g.highBet.toString());
        const kind = folds ? KIND.fold : seatBet >= high ? KIND.check : KIND.call;
        await (mine ? T.act(aEr, agentReader.publicKey, AG, kind) : T.act(oEr, oReader.publicKey, OPP, kind)).catch(() => {});
      }
      await sleep(400);
    }
    throw new Error(`hand ${hand} didn't finish in 90 s`);
  };
  const agentStack = async (aEr: any) => BigInt(coder.decode("ledger", (await rawRead(connUrl(aEr.provider.connection), T.ledger)).data!).seats[AG].stack.toString());

  // One Agent session: buy in, play, cash out with the fee accounts; checks every balance against the rule.
  const session = async (name: string, agentWins: boolean, byPlayer = false) => {
    const reader = Keypair.generate();
    const aEr = programOn(await teeConnection(reader), reader);
    await S.ok(`${name}: the Agent buys in 0.01 SOL from the copier's balance`, () => agentBuyIn(reader.publicKey));
    if (name === "session 1") {
      await S.err("while seated, the terms can't change (FeeTermsLocked)", "FeeTermsLocked", () => set(C, G.publicKey, STAKE, terms(NONE, 0, 0)));
      await S.ok("while seated, setting the same terms again works (renewing the Agent)", () => set(C, G.publicKey, STAKE, TERMS));
    }
    await S.ok(`${name}: a hand where the ${agentWins ? "opponent" : "Agent"} folds`, async () => { await playHand(reader, aEr, agentWins); return "played"; });
    const stack = await agentStack(aEr);
    const before = await readRecord();
    const [c0, k0, t0] = [await balance(C), await balance(K), await treasuryBalance()];
    if (name === "session 1") {
      await S.err("cash-out of a copying Agent without the fee accounts: refused (BadFeeAccount)", "BadFeeAccount",
        () => agentCashOut(aEr, { creatorWalletState: null, creatorVaultToken: null, treasuryWalletState: null, treasuryVaultToken: null }));
      await S.err("cash-out with someone else's balance as the creator's: refused (BadFeeAccount)", "BadFeeAccount",
        () => agentCashOut(aEr, { ...feeAccounts, creatorVaultToken: vaultTokenOf(W(O)) }));
      await S.err("cash-out with the copier's own balance as Nomad's: refused (BadFeeAccount)", "BadFeeAccount",
        () => agentCashOut(aEr, { ...feeAccounts, treasuryVaultToken: vaultTokenOf(W(C)) }));
    }
    if (byPlayer) {
      await S.err(`${name}: the plain cash-out refuses the Agent's seat, even with the copier's play key (AgentSeat)`, "AgentSeat", () => {
        const hand = handOf(T.table, AG);
        return C.er.methods.vaultCashOut(AG, BN(C.exp)).accountsPartial({
          signer: C.key.publicKey, wallet: W(C), vault: vaultOf(W(C)), walletState: walletStateOf(W(C)), vaultToken: vaultTokenOf(W(C)), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), hand, handPermission: permissionPdaFromAccount(hand), escrow: T.escrow, rollup,
        }).preInstructions([proof(C)]).rpc();
      });
      await S.err(`${name}: another wallet's play key can't take the Agent's seat`, "NotAgent", () => {
        const hand = handOf(T.table, AG);
        return O.er.methods.agentCashOut(AG, BN(O.exp)).accountsPartial({
          signer: O.key.publicKey, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, wallet: W(C), agentState: agentStateOf(W(C)), vault: vaultOf(W(C)), walletState: walletStateOf(W(C)), vaultToken: vaultTokenOf(W(C)),
          table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), hand, handPermission: permissionPdaFromAccount(hand), escrow: T.escrow, config: CONFIG_PDA, ...feeAccounts, rollup,
        }).preInstructions([proof(O)]).rpc();
      });
    }
    await S.ok(byPlayer ? `${name}: the copier takes the seat back with their play key (agent_cash_out: the share applies)`
      : `${name}: the seat's table key cashes the Agent out (fees to the creator and Nomad)`, () => agentCashOut(aEr, feeAccounts, byPlayer));
    const [c1, k1, t1] = [await balance(C), await balance(K), await treasuryBalance()];
    const want = expectedFees(before!, BUY, stack);
    const after = await readRecord();
    S.check(`${name}: the creator got ${want.creator} (8% of new profit ${want.profit})`, k1 - k0 === want.creator, { stack, profit: want.profit, creatorGot: k1 - k0 });
    if (treasuryOpen) S.check(`${name}: Nomad got ${want.platform} (${platformBps / 100}% of new profit)`, t1 - t0 === want.platform, { nomadGot: t1 - t0 });
    S.check(`${name}: the copier got the stack minus the fees`, c1 - c0 === stack - want.creator - (treasuryOpen ? want.platform : 0n), { copierGot: c1 - c0, stack });
    S.check(`${name}: the record counts the seat and moves the high-water mark only up`, !!after && after.netIn === before!.netIn + BUY && after.netOut === before!.netOut + stack
      && after.seatIn === 0n && after.highWater >= before!.highWater && after.table.equals(NONE), { before, after });
    return want;
  };

  const s1 = await session("session 1", true);
  S.check("session 1 made a profit, so fees were paid", s1.profit > 0n, s1);
  const s2 = await session("session 2", false);
  S.check("session 2 lost: no fee on a loss", s2.profit === 0n && s2.creator === 0n, s2);
  const s3 = await session("session 3", true);
  S.check("session 3: fees only on what's above the earlier peak (the rule's own result, checked above)", true, s3);

  // ---- the player takes the Agent's seat back after a win: no dodge, the same share applies
  const s4 = await session("session 4", true, true);
  S.check("session 4 (taken back by the player): fees follow the same rule as any cash-out", true, s4);
  await S.err("releasing a record whose seat agent_cash_out already freed: refused (NotAgentSeat)", "NotAgentSeat",
    () => gEr.methods.agentRelease().accountsPartial({ wallet: W(C), agentState: agentStateOf(W(C)), table: T.table, ledger: T.ledger }).rpc());

  // ---- table hosting fees: the requester pays the rent from the game balance (play key, or the Agent within its stake)
  {
    const tab = pda(Buffer.from("host-tab"), W(C).toBuffer());
    const hostPay = (who: "player" | "agent", amount: bigint) => {
      const pay = {
        wallet: W(C), walletState: walletStateOf(W(C)), vault: vaultOf(W(C)), vaultToken: vaultTokenOf(W(C)), config: CONFIG_PDA,
        hostWalletState: walletStateOf(deployer.publicKey), hostVaultToken: vaultTokenOf(deployer.publicKey),
        hostTab: tab, hostTabPermission: permissionPdaFromAccount(tab), sponsor: SPONSOR, rollup,
      } as any; // a nested accounts struct (HostFeeAccounts)
      return who === "player"
        ? C.er.methods.payHostFee(BN(C.exp), BN(amount)).accountsPartial({ playKey: C.key.publicKey, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, pay }).preInstructions([proof(C)]).rpc()
        : gEr.methods.agentPayHostFee(BN(amount)).accountsPartial({ agentKey: G.publicKey, pay, agentState: agentStateOf(W(C)) }).rpc();
    };
    await S.ok("admin: hosting fees on for the run (host wallet = deployer, at most 0.02 SOL)",
      () => setFees({ platformFeeBps: savedFees.platformFeeBps, creatorFeeBps: savedFees.creatorFeeBps, hostWallet: deployer.publicKey, maxHostFee: 20_000_000n }));
    await sleep(8000); // the rollup's copy of the config catches up
    await S.err("a hosting fee above the cap: refused (BadHostFee)", "BadHostFee", () => hostPay("player", 20_000_001n));
    await S.err("a zero hosting fee: refused (BadHostFee)", "BadHostFee", () => hostPay("player", 0n));
    const [c0, h0] = [await balance(C), await treasuryBalance()];
    await S.ok("the copier's play key pays a 0.017 SOL hosting fee (no wallet prompt)", () => hostPay("player", 17_000_000n));
    const [c1, h1] = [await balance(C), await treasuryBalance()];
    S.check("it moved from the copier's game balance to the host's", c0 - c1 === 17_000_000n && (!treasuryOpen || h1 - h0 === 17_000_000n), { copier: c0 - c1, host: h1 - h0 });
    const tabData = (await erD.provider.connection.getAccountInfo(tab, "processed"))?.data;
    S.check("the copier's HostTab says 0.017 SOL paid (read by the host wallet)", !!tabData && tabData.readBigUInt64LE(40) === 17_000_000n, { paid: tabData?.readBigUInt64LE(40) });
    const outsiderView = await rawRead(connUrl(O.er.provider.connection), tab);
    S.check("another wallet can't read it", !outsiderView.visible || !outsiderView.data?.length, outsiderView);
    const rb = await readRecord();
    await S.ok("the Agent pays a hosting fee within its stake (agent_pay_host_fee)", () => hostPay("agent", 5_000_000n));
    const ra = await readRecord();
    S.check("...it counts toward the stake and as a cost of the next seat", !!ra && ra.committed === rb!.committed + 5_000_000n && ra.seatIn === rb!.seatIn + 5_000_000n, { before: rb, after: ra });
    await S.err("an Agent hosting fee beyond its stake: refused (AgentStakeExceeded)", "AgentStakeExceeded", () => hostPay("agent", STAKE));
    await S.ok("admin: the config's fees back as they were", () => setFees(savedFees));
  }

  // ---- stop, close, the admin's share setting
  await S.ok("the copier stops the Agent (terms passed as none are ignored)", () => set(C, NONE, 0n, terms(NONE, 0, 0)));
  const stopped = await readRecord(C.er.provider.connection);
  S.check("a stopped record keeps its terms and counts (only the play key reads it now)", !!stopped && stopped.agent.equals(NONE) && stopped.creator.equals(W(K)), stopped);
  await S.ok("the copier sets the Agent with no terms: its own strategy, counts start afresh", () => set(C, G.publicKey, STAKE));
  const own = await readRecord();
  S.check("no terms, zero counts", !!own && own.creator.equals(NONE) && own.netIn === 0n && own.highWater === 0n, own);
  await S.ok("the copier closes the record", () => C.er.methods.agentClose(BN(C.exp)).accountsPartial({
    playKey: C.key.publicKey, wallet: W(C), walletState: walletStateOf(W(C)), instructions: SYSVAR_INSTRUCTIONS_PUBKEY, agentState: agentStateOf(W(C)),
    agentPermission: permissionPdaFromAccount(agentStateOf(W(C))), sponsor: SPONSOR, rollup,
  }).preInstructions([proof(C)]).rpc());
  await S.err("Nomad's share above 5%: refused (admin)", "BadFeeTerms", () => setFees({ ...savedFees, platformFeeBps: 501 }));
  await S.err("a creator share above 20%: refused (admin)", "BadFeeTerms", () => setFees({ ...savedFees, creatorFeeBps: 2001 }));
  await S.err("a hosting-fee cap above 0.05 SOL: refused (admin)", "BadFeeTerms", () => setFees({ ...savedFees, maxHostFee: 50_000_001n }));
  await S.err("an outsider can't set the fees", "NotAdmin", () => setFees(savedFees, O.wallet));
  await S.ok("the opponent leaves; collect rake and close the table", async () => {
    const hand = handOf(T.table, OPP);
    await oEr.methods.vaultCashOut(OPP, BN(0)).accountsPartial({
      signer: oReader.publicKey, wallet: W(O), vault: vaultOf(W(O)), walletState: walletStateOf(W(O)), vaultToken: vaultTokenOf(W(O)), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger), hand, handPermission: permissionPdaFromAccount(hand), escrow: T.escrow, rollup,
    }).rpc();
    await T.collectRake(erD, tokenOf(deployer.publicKey));
    return T.close(erD, deployer.publicKey);
  });

  S.finish({ table: T.table.toBase58(), copier: W(C).toBase58(), creator: W(K).toBase58(), treasury: treasury.toBase58(), treasuryChecked: treasuryOpen, platformBps, creatorBps });
}
main().catch((e) => { console.error(e); process.exit(1); });
