import type { NextFunction, Response } from "express";
import type { Pool } from "pg";
import type { AuthedRequest } from "./playerAuth.js";
import { tableIdFromString } from "../utils/tableId.js";
import { fetchTableByIdString, isValidTableIdString } from "../services/tableRead.js";

export type HostAuthedRequest = AuthedRequest & { tableIdStr?: string };

/**
 * Guards /host/tables/:tableId/* routes: the authenticated player (requirePlayerJwt
 * must have run first) has to be the recorded host of the table. host_pubkey is read
 * from the DB (populated at create), falling back to the on-chain table account.
 */
export function requireTableHost(pool: Pool) {
  return async (req: HostAuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    const caller = req.playerPubkey;
    if (!caller) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const tableIdStr = String(req.params.tableId ?? "").trim();
    if (!isValidTableIdString(tableIdStr)) {
      res.status(400).json({ error: "Invalid tableId" });
      return;
    }

    try {
      const tableIdHex = tableIdFromString(tableIdStr).toString("hex");
      let hostPubkey: string | null = null;

      const { rows } = await pool.query<{ host_pubkey: string }>(
        `SELECT host_pubkey FROM tables WHERE table_id = $1 LIMIT 1`,
        [tableIdHex]
      );
      hostPubkey = rows[0]?.host_pubkey ?? null;

      if (!hostPubkey) {
        const resolved = await fetchTableByIdString(tableIdStr);
        hostPubkey = resolved?.table.host.toBase58() ?? null;
      }

      if (!hostPubkey) {
        res.status(404).json({ error: "Table not found" });
        return;
      }

      if (hostPubkey !== caller) {
        res.status(403).json({ error: "Forbidden — caller is not the table host" });
        return;
      }

      req.tableIdStr = tableIdStr;
      next();
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? String(err) });
    }
  };
}
