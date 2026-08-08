import { Router } from "express";
import { PublicKey } from "@solana/web3.js";
import type { Pool } from "pg";
import {
  beginRound,
  cashOutPlayer,
  closeTable,
  createTable,
  settleRound,
} from "./services/settlement.js";
import {
  deriveSeatPda,
  fetchTableByIdString,
  isValidTableIdString,
} from "./services/tableRead.js";
import { isValidSolanaPubkey } from "./auth/siws.js";
import { programId } from "./config/solana.js";
import { requireTableHost, type HostAuthedRequest } from "./middleware/hostAuth.js";
import type { AuthedRequest } from "./middleware/playerAuth.js";

const LAMPORTS_PER_CHIP = 100_000;
/** Mirrors MAX_DELTAS in the on-chain program. */
const MAX_DELTAS = 9;

type HostDelta = { player: string; chipDelta: number };

/**
 * Host-authorized game routes. Unlike /internal/* (ops, shared API key), these are
 * guarded by the caller's player JWT: the game host drives its own table's lifecycle
 * and never holds the internal key. PDAs, nonce, and chipsInPlay are derived
 * server-side so the client only ever supplies tableId + chip deltas.
 */
export function createHostRouter(pool: Pool): Router {
  const router = Router();
  const hostOnly = requireTableHost(pool);

  router.post("/tables", async (req: AuthedRequest, res) => {
    try {
      const tableId = String(req.body?.tableId ?? "").trim();
      const buyInLamports = Number(req.body?.buyInLamports);
      const smallBlindChips = Number(req.body?.smallBlindChips);
      const bigBlindChips = Number(req.body?.bigBlindChips);
      const maxSeats = Number(req.body?.maxSeats);

      if (!isValidTableIdString(tableId)) {
        res.status(400).json({ error: "Invalid tableId (1-32 printable ascii chars)" });
        return;
      }
      if (
        !Number.isSafeInteger(buyInLamports) ||
        buyInLamports <= 0 ||
        buyInLamports % LAMPORTS_PER_CHIP !== 0
      ) {
        res.status(400).json({ error: `buyInLamports must be a positive multiple of ${LAMPORTS_PER_CHIP}` });
        return;
      }
      if (
        !Number.isSafeInteger(smallBlindChips) || smallBlindChips <= 0 ||
        !Number.isSafeInteger(bigBlindChips) || bigBlindChips < smallBlindChips
      ) {
        res.status(400).json({ error: "Invalid blinds" });
        return;
      }
      if (!Number.isInteger(maxSeats) || maxSeats < 2 || maxSeats > MAX_DELTAS) {
        res.status(400).json({ error: `maxSeats must be 2..${MAX_DELTAS}` });
        return;
      }

      const result = await createTable({
        tableId,
        hostPubkey: req.playerPubkey!,
        buyInLamports,
        smallBlindChips,
        bigBlindChips,
        maxSeats,
      });
      res.json({ ...result, tableId });
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? String(err) });
    }
  });

  router.post("/tables/:tableId/hand/start", hostOnly, async (req: HostAuthedRequest, res) => {
    try {
      const resolved = await fetchTableByIdString(req.tableIdStr!);
      if (!resolved) {
        res.status(404).json({ error: "Table not found on chain" });
        return;
      }

      // Idempotent: a retried request whose predecessor actually landed just
      // reports the already-active round instead of failing with RoundInProgress.
      if (resolved.table.roundActive) {
        res.json({ alreadyActive: true, roundNonce: resolved.table.roundNonce.toNumber() });
        return;
      }

      const sig = await beginRound({
        tableId: [...resolved.tableIdBuf],
        tablePda: resolved.tablePda.toBase58(),
      });
      res.json({
        signature: sig,
        alreadyActive: false,
        roundNonce: resolved.table.roundNonce.toNumber(),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? String(err) });
    }
  });

  router.post("/tables/:tableId/hand/end", hostOnly, async (req: HostAuthedRequest, res) => {
    try {
      // Empty deltas are legal: a tied hand can move zero chips, and the round still
      // has to settle on chain or buy-ins/cash-outs stay blocked.
      const rawDeltas = req.body?.deltas;
      if (!Array.isArray(rawDeltas) || rawDeltas.length > MAX_DELTAS) {
        res.status(400).json({ error: `deltas must be an array of at most ${MAX_DELTAS} entries` });
        return;
      }
      const deltas: HostDelta[] = rawDeltas.map((d: any) => ({
        player: String(d?.player ?? "").trim(),
        chipDelta: Number(d?.chipDelta),
      }));
      for (const d of deltas) {
        if (!isValidSolanaPubkey(d.player) || !Number.isSafeInteger(d.chipDelta)) {
          res.status(400).json({ error: "Each delta needs a valid player pubkey and integer chipDelta" });
          return;
        }
      }
      if (new Set(deltas.map((d) => d.player)).size !== deltas.length) {
        res.status(400).json({ error: "Duplicate player in deltas" });
        return;
      }
      if (deltas.reduce((acc, d) => acc + d.chipDelta, 0) !== 0) {
        res.status(400).json({ error: "Settlement deltas must sum to zero" });
        return;
      }

      const resolved = await fetchTableByIdString(req.tableIdStr!);
      if (!resolved) {
        res.status(404).json({ error: "Table not found on chain" });
        return;
      }

      const tableIdHex = resolved.tableIdBuf.toString("hex");
      const chainNonce = resolved.table.roundNonce.toNumber();

      // Idempotent replay: if the round already settled (a lost response),
      // return the recorded signature for the previous nonce.
      if (!resolved.table.roundActive) {
        const { rows } = await pool.query<{ settle_sig: string; round_nonce: number }>(
          `SELECT settle_sig, round_nonce FROM rounds
           WHERE table_id = $1 AND round_nonce = $2 LIMIT 1`,
          [tableIdHex, chainNonce - 1]
        );
        if (rows[0]?.settle_sig) {
          res.json({ signature: rows[0].settle_sig, roundNonce: chainNonce, replayed: true });
          return;
        }
        res.status(409).json({ error: "No round in progress" });
        return;
      }

      const pid = programId()!;
      const potChips = req.body?.potChips != null ? Number(req.body.potChips) : undefined;

      const sig = await settleRound({
        tableId: [...resolved.tableIdBuf],
        tablePda: resolved.tablePda.toBase58(),
        vaultPda: resolved.vaultPda.toBase58(),
        nonce: chainNonce,
        potChips: Number.isSafeInteger(potChips!) ? potChips : undefined,
        chipsInPlay: resolved.table.chipsInPlay.toNumber(),
        deltas: deltas.map((d) => ({
          player: d.player,
          chipDelta: d.chipDelta,
          seatPda: deriveSeatPda(pid, resolved.tableIdBuf, new PublicKey(d.player)).toBase58(),
        })),
      });
      res.json({ signature: sig, roundNonce: chainNonce + 1, replayed: false });
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? String(err) });
    }
  });

  // Cash-out is intentionally NOT host-only: the seat owner may cash themself out
  // (e.g. after the host vanished and the round went stale). The chain enforces the
  // between-rounds / stale-round gate either way; the settlement authority signs.
  router.post("/tables/:tableId/cash-out", async (req: AuthedRequest, res) => {
    try {
      const tableIdStr = String(req.params.tableId ?? "").trim();
      if (!isValidTableIdString(tableIdStr)) {
        res.status(400).json({ error: "Invalid tableId" });
        return;
      }
      const playerPubkey = String(req.body?.playerPubkey ?? "").trim();
      if (!isValidSolanaPubkey(playerPubkey)) {
        res.status(400).json({ error: "Invalid playerPubkey" });
        return;
      }

      const resolved = await fetchTableByIdString(tableIdStr);
      if (!resolved) {
        res.status(404).json({ error: "Table not found on chain" });
        return;
      }

      const caller = req.playerPubkey!;
      const isHost = resolved.table.host.toBase58() === caller;
      if (!isHost && caller !== playerPubkey) {
        res.status(403).json({ error: "Forbidden — only the host or the player themself may cash out" });
        return;
      }

      const seatPda = deriveSeatPda(programId()!, resolved.tableIdBuf, new PublicKey(playerPubkey));
      const sig = await cashOutPlayer({
        tableId: tableIdStr,
        tablePda: resolved.tablePda.toBase58(),
        vaultPda: resolved.vaultPda.toBase58(),
        seatPda: seatPda.toBase58(),
        playerWallet: playerPubkey,
      });
      res.json({ signature: sig });
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? String(err) });
    }
  });

  router.post("/tables/:tableId/close", hostOnly, async (req: HostAuthedRequest, res) => {
    try {
      const resolved = await fetchTableByIdString(req.tableIdStr!);
      if (!resolved) {
        res.status(404).json({ error: "Table not found on chain" });
        return;
      }
      const sig = await closeTable({
        tableId: req.tableIdStr!,
        tablePda: resolved.tablePda.toBase58(),
        vaultPda: resolved.vaultPda.toBase58(),
      });
      res.json({ signature: sig });
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? String(err) });
    }
  });

  return router;
}
