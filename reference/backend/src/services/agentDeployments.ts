import type { Pool, PoolClient } from "pg";

export type AgentPhase =
  | "queued"
  | "seated"
  | "playing"
  | "stop_requested"
  | "settling"
  | "completed"
  | "failed";

export interface EnqueueAgentInput {
  deploymentId: string;
  /** The backend took the bankroll from the owner's Coins (agentMoney.ts): it pays the stack back when it ends. */
  funded?: boolean;
  ownerId: string;
  agentName: string;
  profile: string;
  strategyVersion: string;
  strategyConfig: Record<string, unknown>;
  bankroll: number;
  maxHands: number;
  maxRuntimeSeconds: number;
  stopLoss: number;
  profitTarget: number;
  stake: number;
}

export interface AgentProgressInput {
  handsPlayed?: number;
  stack?: number;
  netPnl?: number;
  runtimeSeconds?: number;
  wins?: number;
  losses?: number;
  showdowns?: number;
  phase?: AgentPhase;
  assignedTable?: string;
}

export interface AgentHandInput {
  handNumber: number;
  startStack: number;
  endStack: number;
  netPnl: number;
  holeCards: unknown;
  boardCards: unknown;
  pot: number;
  result: string;
  showdown: boolean;
  publicActions: unknown;
  /** The hand's replay timeline (already parsed and size-checked: see agentReplay.ts). Null: none. */
  replay?: Record<string, unknown> | null;
  completedAt?: Date;
}

type AgentRow = Record<string, any>;

const ACTIVE_PHASES = new Set<AgentPhase>([
  "queued",
  "seated",
  "playing",
  "stop_requested",
  "settling",
]);

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function unix(value: unknown): number {
  if (!value) return 0;
  const millis = new Date(value as string | number | Date).getTime();
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : 0;
}

function config(row: AgentRow): Record<string, unknown> {
  return row.strategy_config && typeof row.strategy_config === "object"
    ? row.strategy_config
    : {};
}

/** Unity-compatible live deployment shape. */
export function toAgentPublic(row: AgentRow) {
  const strategy = config(row);
  const phase = String(row.phase) as AgentPhase;
  return {
    session: String(row.deployment_id),
    deploymentId: String(row.deployment_id),
    DeploymentId: String(row.deployment_id),
    ownerId: String(row.owner_id),
    OwnerPlayFabId: String(row.owner_id),
    agentName: String(row.agent_name),
    profile: String(row.profile),
    StrategyPreset: String(row.profile),
    strategyVersion: String(row.strategy_version),
    StrategyVersion: String(row.strategy_version),
    bankroll: integer(row.bankroll),
    maxHands: integer(row.max_hands),
    maxRuntime: integer(row.max_runtime_seconds),
    stopLoss: integer(row.stop_loss),
    profitTarget: integer(row.profit_target),
    stake: integer(row.stake),
    hasCustom: Boolean(strategy.hasCustom),
    foldBelow: number(strategy.foldBelow),
    raiseAbove: number(strategy.raiseAbove),
    aggression: number(strategy.aggression),
    bluffChance: number(strategy.bluffChance),
    raiseFractionOfPot: number(strategy.raiseFractionOfPot),
    positionWeight: number(strategy.positionWeight),
    brain: integer(strategy.brain),
    streets: Array.isArray(strategy.streets) ? strategy.streets : [],
    running: ACTIVE_PHASES.has(phase),
    stopRequested: Boolean(row.stop_requested),
    phase,
    HandsPlayed: integer(row.hands_played),
    MaxHands: integer(row.max_hands),
    StartingBankroll: integer(row.bankroll),
    Stack: integer(row.stack),
    EndingStack: integer(row.stack),
    NetPnl: integer(row.net_pnl),
    RuntimeSeconds: number(row.runtime_seconds),
    AssignedTable: row.assigned_table ? String(row.assigned_table) : "",
    Wins: integer(row.wins),
    Losses: integer(row.losses),
    Showdowns: integer(row.showdowns),
    CurrentHand: integer(row.hands_played) + 1,
    StopReason: row.stop_reason ? String(row.stop_reason) : "",
    SessionName: row.assigned_table ? String(row.assigned_table) : "",
    updatedUnix: unix(row.updated_at),
    createdUnix: unix(row.created_at),
    CompletedUnix: unix(row.completed_at),
    completedUnix: unix(row.completed_at),
  };
}

function cardsText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((card) => String(card ?? "").trim()).filter(Boolean).join(" ");
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Unity-compatible hand shape. The replay goes out as a JSON string (ReplayJson) because JsonUtility cannot read an
 * arbitrary object; HasReplay is false for hands recorded before replays existed. Lists polled every few seconds
 * (RecentHands on the live status) leave the replay text out.
 */
function toHandPublic(row: AgentRow, includeReplay = false) {
  const hasReplay = row.replay_json != null && typeof row.replay_json === "object";
  return {
    DeploymentId: String(row.deployment_id),
    HandNumber: integer(row.hand_number),
    StartStack: integer(row.start_stack),
    StartingStack: integer(row.start_stack),
    EndStack: integer(row.end_stack),
    EndingStack: integer(row.end_stack),
    NetPnl: integer(row.net_pnl),
    HoleCards: cardsText(row.hole_cards),
    BoardCards: cardsText(row.board_cards),
    Pot: integer(row.pot),
    Result: String(row.result ?? ""),
    Showdown: Boolean(row.showdown),
    PublicActionsJson: JSON.stringify(row.public_actions ?? []),
    HasReplay: hasReplay,
    ReplayJson: includeReplay && hasReplay ? JSON.stringify(row.replay_json) : "",
    CompletedUnix: unix(row.completed_at),
    completedUnix: unix(row.completed_at),
  };
}

export class AgentDeploymentService {
  constructor(private readonly pool: Pool) {}

  async enqueue(input: EnqueueAgentInput) {
    await this.pool.query(
      `INSERT INTO agent_deployments (
         deployment_id, owner_id, agent_name, profile, strategy_version,
         strategy_config, bankroll, max_hands, max_runtime_seconds,
         stop_loss, profit_target, stake, stack, funded
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$7,$13)
       ON CONFLICT (deployment_id) DO NOTHING`,
      [
        input.deploymentId,
        input.ownerId,
        input.agentName,
        input.profile,
        input.strategyVersion,
        JSON.stringify(input.strategyConfig),
        input.bankroll,
        input.maxHands,
        input.maxRuntimeSeconds,
        input.stopLoss,
        input.profitTarget,
        input.stake,
        input.funded === true,
      ]
    );
    const row = await this.requireDeployment(input.deploymentId);
    if (String(row.owner_id) !== input.ownerId) {
      throw Object.assign(new Error("Deployment ID belongs to another owner"), { status: 409 });
    }
    return toAgentPublic(row);
  }

  async claim(table: string, stake: number) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE agent_deployments
            SET phase = 'failed', stop_requested = FALSE, stop_reason = 'server_lost',
                result = jsonb_build_object(
                  'DeploymentId', deployment_id,
                  'OwnerPlayFabId', owner_id,
                  'StrategyPreset', profile,
                  'StrategyVersion', strategy_version,
                  'StopReason', 'server_lost',
                  'HandsPlayed', hands_played,
                  'StartingBankroll', bankroll,
                  'EndingStack', stack,
                  'NetPnl', net_pnl,
                  'RuntimeSeconds', runtime_seconds,
                  'SessionName', COALESCE(assigned_table, ''),
                  'CompletedUnix', FLOOR(EXTRACT(EPOCH FROM NOW())),
                  'Wins', wins,
                  'Losses', losses,
                  'Showdowns', showdowns
                ),
                assigned_table = NULL, completed_at = NOW(), updated_at = NOW()
          WHERE phase IN ('playing', 'stop_requested', 'settling')
            AND updated_at < NOW() - INTERVAL '2 minutes'`
      );
      await client.query(
        `UPDATE agent_deployments
            SET phase = 'queued', assigned_table = NULL,
                claimed_at = NULL, updated_at = NOW()
          WHERE phase = 'seated'
            AND hands_played = 0
            AND updated_at < NOW() - INTERVAL '2 minutes'`
      );
      const selected = await client.query(
        `SELECT *
           FROM agent_deployments
          WHERE phase = 'queued'
            AND (stake = $1 OR stake = 0)
          ORDER BY CASE WHEN stake = $1 THEN 0 ELSE 1 END, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [stake]
      );
      if (!selected.rows[0]) {
        // Help ops: stake mismatch is the usual reason a WebGL deploy stays "Queued" forever.
        const waiting = await client.query(
          `SELECT stake, COUNT(*)::int AS n
             FROM agent_deployments
            WHERE phase = 'queued'
            GROUP BY stake
            ORDER BY stake`
        );
        await client.query("COMMIT");
        if (waiting.rows.length > 0) {
          console.warn(
            `[agent] claim miss table=${table} stake=${stake}; queued=` +
              waiting.rows.map((r) => `${r.stake}x${r.n}`).join(",")
          );
        }
        return null;
      }
      const updated = await client.query(
        `UPDATE agent_deployments
            SET phase = 'seated', assigned_table = $2, claimed_at = NOW(),
                updated_at = NOW()
          WHERE deployment_id = $1
          RETURNING *`,
        [selected.rows[0].deployment_id, table]
      );
      await client.query("COMMIT");
      return toAgentPublic(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async get(deploymentId: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_deployments WHERE deployment_id = $1`,
      [deploymentId]
    );
    return rows[0] ? toAgentPublic(rows[0]) : null;
  }

  async getResult(deploymentId: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_deployments WHERE deployment_id = $1`,
      [deploymentId]
    );
    const row = rows[0];
    if (!row || (row.phase !== "completed" && row.phase !== "failed")) return null;
    return {
      ...toAgentPublic(row),
      ...(row.result && typeof row.result === "object" ? row.result : {}),
    };
  }

  async releaseClaim(deploymentId: string, table: string) {
    const { rows } = await this.pool.query(
      `UPDATE agent_deployments
          SET phase = 'queued', assigned_table = NULL, claimed_at = NULL, updated_at = NOW()
        WHERE deployment_id = $1
          AND assigned_table = $2
          AND phase = 'seated'
          AND hands_played = 0
        RETURNING *`,
      [deploymentId, table]
    );
    return rows[0] ? toAgentPublic(rows[0]) : null;
  }

  async assertOwner(deploymentId: string, ownerId?: string) {
    const row = await this.requireDeployment(deploymentId);
    if (ownerId && String(row.owner_id) !== ownerId) {
      throw Object.assign(new Error("Deployment does not belong to owner"), { status: 403 });
    }
    return row;
  }

  async updateProgress(deploymentId: string, input: AgentProgressInput) {
    const requestedPhase =
      input.phase && ACTIVE_PHASES.has(input.phase) ? input.phase : "playing";
    const { rows } = await this.pool.query(
      `UPDATE agent_deployments
          SET hands_played = GREATEST(hands_played, COALESCE($2, hands_played)),
              stack = CASE WHEN COALESCE($2, hands_played) >= hands_played
                           THEN COALESCE($3, stack) ELSE stack END,
              net_pnl = CASE WHEN COALESCE($2, hands_played) >= hands_played
                             THEN COALESCE($4, net_pnl) ELSE net_pnl END,
              runtime_seconds = GREATEST(runtime_seconds, COALESCE($5, runtime_seconds)),
              wins = GREATEST(wins, COALESCE($6, wins)),
              losses = GREATEST(losses, COALESCE($7, losses)),
              showdowns = GREATEST(showdowns, COALESCE($8, showdowns)),
              phase = CASE
                WHEN phase IN ('completed', 'failed') THEN phase
                WHEN $9 = 'settling' THEN 'settling'
                WHEN stop_requested THEN 'stop_requested'
                ELSE $9
              END,
              started_at = COALESCE(started_at, NOW()),
              updated_at = NOW()
        WHERE deployment_id = $1
          AND assigned_table = $10
          AND phase IN ('seated', 'playing', 'stop_requested', 'settling')
        RETURNING *`,
      [
        deploymentId,
        input.handsPlayed,
        input.stack,
        input.netPnl,
        input.runtimeSeconds,
        input.wins,
        input.losses,
        input.showdowns,
        requestedPhase,
        input.assignedTable || null,
      ]
    );
    if (!rows[0]) throw Object.assign(new Error("Stale agent table claim"), { status: 409 });
    return toAgentPublic(rows[0]);
  }

  async requestStop(deploymentId: string, ownerId?: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        `SELECT * FROM agent_deployments WHERE deployment_id = $1 FOR UPDATE`,
        [deploymentId]
      );
      const current = locked.rows[0];
      if (!current) throw this.notFound();
      if (ownerId && String(current.owner_id) !== ownerId) {
        throw Object.assign(new Error("Deployment does not belong to owner"), { status: 403 });
      }

      let updated;
      if (String(current.phase) === "queued") {
        const completedUnix = Math.floor(Date.now() / 1000);
        const summary = {
          DeploymentId: deploymentId,
          OwnerPlayFabId: String(current.owner_id),
          StrategyPreset: String(current.profile),
          StrategyVersion: String(current.strategy_version),
          StopReason: "owner_stop",
          HandsPlayed: 0,
          StartingBankroll: integer(current.bankroll),
          EndingStack: integer(current.bankroll),
          NetPnl: 0,
          RuntimeSeconds: 0,
          SessionName: "",
          CompletedUnix: completedUnix,
          Wins: 0,
          Losses: 0,
          Showdowns: 0,
        };
        updated = await client.query(
          `UPDATE agent_deployments
              SET phase = 'completed', stop_requested = FALSE,
                  stop_reason = 'owner_stop', result = $2::jsonb,
                  completed_at = NOW(), updated_at = NOW()
            WHERE deployment_id = $1
            RETURNING *`,
          [deploymentId, JSON.stringify(summary)]
        );
      } else {
        updated = await client.query(
          `UPDATE agent_deployments
              SET stop_requested = CASE
                    WHEN phase IN ('completed', 'failed') THEN stop_requested ELSE TRUE END,
                  phase = CASE
                    WHEN phase IN ('completed', 'failed') THEN phase ELSE 'stop_requested' END,
                  updated_at = NOW()
            WHERE deployment_id = $1
            RETURNING *`,
          [deploymentId]
        );
      }
      await client.query("COMMIT");
      return toAgentPublic(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async control(deploymentId: string, table?: string) {
    const row = await this.requireDeployment(deploymentId);
    const validClaim =
      Boolean(table) &&
      ACTIVE_PHASES.has(String(row.phase) as AgentPhase) &&
      String(row.assigned_table ?? "") === table;
    return {
      stopRequested: Boolean(row.stop_requested),
      validClaim,
      phase: String(row.phase),
      DeploymentId: String(row.deployment_id),
      updatedUnix: unix(row.updated_at),
    };
  }

  async upsertHand(deploymentId: string, hand: AgentHandInput, table?: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await this.lockDeployment(client, deploymentId);
      if (table && String(locked.assigned_table ?? "") !== table) {
        throw Object.assign(new Error("Stale agent table claim"), { status: 409 });
      }
      await client.query(
        `INSERT INTO agent_hands (
           deployment_id, hand_number, start_stack, end_stack, net_pnl,
           hole_cards, board_cards, pot, result, showdown, public_actions, completed_at, replay_json
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb,COALESCE($12,NOW()),$13::jsonb)
         ON CONFLICT (deployment_id, hand_number) DO UPDATE SET
           start_stack = EXCLUDED.start_stack,
           end_stack = EXCLUDED.end_stack,
           net_pnl = EXCLUDED.net_pnl,
           hole_cards = EXCLUDED.hole_cards,
           board_cards = EXCLUDED.board_cards,
           pot = EXCLUDED.pot,
           result = EXCLUDED.result,
           showdown = EXCLUDED.showdown,
           public_actions = EXCLUDED.public_actions,
           completed_at = EXCLUDED.completed_at,
           replay_json = COALESCE(EXCLUDED.replay_json, agent_hands.replay_json)`,
        [
          deploymentId,
          hand.handNumber,
          hand.startStack,
          hand.endStack,
          hand.netPnl,
          JSON.stringify(hand.holeCards ?? []),
          JSON.stringify(hand.boardCards ?? []),
          hand.pot,
          hand.result,
          hand.showdown,
          JSON.stringify(hand.publicActions ?? []),
          hand.completedAt ?? null,
          hand.replay ? JSON.stringify(hand.replay) : null,
        ]
      );
      const updated = await client.query(
        `UPDATE agent_deployments d
            SET hands_played = a.hands,
                wins = a.wins,
                losses = a.losses,
                showdowns = a.showdowns,
                stack = a.latest_stack,
                net_pnl = a.total_net,
                phase = CASE
                  WHEN d.phase IN ('completed', 'failed') THEN d.phase
                  WHEN d.stop_requested THEN 'stop_requested'
                  ELSE 'playing'
                END,
                started_at = COALESCE(d.started_at, NOW()),
                updated_at = NOW()
           FROM (
             SELECT COUNT(*)::int AS hands,
                    COUNT(*) FILTER (WHERE LOWER(result) IN ('win', 'won'))::int AS wins,
                    COUNT(*) FILTER (WHERE LOWER(result) IN ('loss', 'lost'))::int AS losses,
                    COUNT(*) FILTER (WHERE showdown)::int AS showdowns,
                    (ARRAY_AGG(end_stack ORDER BY hand_number DESC))[1] AS latest_stack,
                    COALESCE(SUM(net_pnl), 0) AS total_net
               FROM agent_hands
              WHERE deployment_id = $1
           ) a
          WHERE d.deployment_id = $1
          RETURNING d.*`,
        [deploymentId]
      );
      await client.query("COMMIT");
      return toAgentPublic(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(deploymentId: string, summary: Record<string, unknown>) {
    const failed = summary.phase === "failed" || summary.ok === false;
    const result = JSON.stringify(summary);
    const { rows } = await this.pool.query(
      `UPDATE agent_deployments
          SET phase = CASE
                WHEN phase IN ('completed', 'failed') THEN phase
                ELSE $2
              END,
              hands_played = CASE WHEN phase IN ('completed', 'failed') THEN hands_played
                ELSE COALESCE($3, hands_played) END,
              stack = CASE WHEN phase IN ('completed', 'failed') THEN stack
                ELSE COALESCE($4, stack) END,
              net_pnl = CASE WHEN phase IN ('completed', 'failed') THEN net_pnl
                ELSE COALESCE($5, net_pnl) END,
              runtime_seconds = CASE WHEN phase IN ('completed', 'failed') THEN runtime_seconds
                ELSE COALESCE($6, runtime_seconds) END,
              stop_reason = CASE WHEN phase IN ('completed', 'failed') THEN stop_reason
                ELSE COALESCE($7, stop_reason) END,
              result = COALESCE(result, $8::jsonb),
              stop_requested = FALSE,
              completed_at = COALESCE(completed_at, NOW()),
              updated_at = NOW()
        WHERE deployment_id = $1
          AND ($9::text IS NULL OR assigned_table = $9)
        RETURNING *`,
      [
        deploymentId,
        failed ? "failed" : "completed",
        summary.HandsPlayed ?? summary.handsPlayed,
        summary.EndingStack ?? summary.Stack ?? summary.stack,
        summary.NetPnl ?? summary.netPnl,
        summary.RuntimeSeconds ?? summary.runtimeSeconds,
        summary.StopReason ?? summary.stopReason,
        result,
        summary.SessionName ?? summary.sessionName ?? null,
      ]
    );
    if (!rows[0]) throw this.notFound();
    return {
      ...toAgentPublic(rows[0]),
      ...(rows[0].result && typeof rows[0].result === "object" ? rows[0].result : summary),
    };
  }

  async list(ownerId: string, limit: number, offset: number) {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_deployments
        WHERE owner_id = $1 AND phase IN ('completed', 'failed')
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [ownerId, limit, offset]
    );
    return rows.map(toAgentPublic);
  }

  async hands(ownerId: string, deploymentId: string, limit: number, offset: number, includeReplay = true) {
    await this.assertOwner(deploymentId, ownerId);
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_hands
        WHERE deployment_id = $1
        ORDER BY hand_number DESC
        LIMIT $2 OFFSET $3`,
      [deploymentId, limit, offset]
    );
    return rows.map((row) => toHandPublic(row, includeReplay));
  }

  /** One hand with its replay, or null. Owner-checked like the lists. */
  async hand(ownerId: string, deploymentId: string, handNumber: number) {
    await this.assertOwner(deploymentId, ownerId);
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_hands WHERE deployment_id = $1 AND hand_number = $2`,
      [deploymentId, handNumber]
    );
    return rows[0] ? toHandPublic(rows[0], true) : null;
  }

  async count(ownerId: string) {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM agent_deployments
        WHERE owner_id = $1 AND phase IN ('completed', 'failed')`,
      [ownerId]
    );
    return integer(rows[0]?.total);
  }

  async handCount(ownerId: string, deploymentId: string) {
    await this.assertOwner(deploymentId, ownerId);
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM agent_hands WHERE deployment_id = $1`,
      [deploymentId]
    );
    return integer(rows[0]?.total);
  }

  async recentHands(deploymentId: string, limit = 10) {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_hands
        WHERE deployment_id = $1
        ORDER BY hand_number DESC
        LIMIT $2`,
      [deploymentId, limit]
    );
    return rows.reverse().map((row) => toHandPublic(row));
  }

  private async requireDeployment(deploymentId: string): Promise<AgentRow> {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_deployments WHERE deployment_id = $1`,
      [deploymentId]
    );
    if (!rows[0]) throw this.notFound();
    return rows[0];
  }

  private async lockDeployment(client: PoolClient, deploymentId: string) {
    const { rows } = await client.query(
      `SELECT deployment_id, assigned_table FROM agent_deployments
        WHERE deployment_id = $1 FOR UPDATE`,
      [deploymentId]
    );
    if (!rows[0]) throw this.notFound();
    return rows[0];
  }

  private notFound() {
    return Object.assign(new Error("Unknown agent deployment"), { status: 404 });
  }
}
