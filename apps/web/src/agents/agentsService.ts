/**
 * The `agents` service: what the Nomad Agents screens (Overview / Strategy / Session history) and the Agent dialogs
 * call. It bundles the deploy service (AgentDeployService + AgentDeployGateway), the player's strategy
 * (AgentStrategyState), the session history the screens paint (NomadUiHost.Agents' _agentHistory), the hand / replay
 * dialogs (NomadUiHost.Replay) and the 3D replay at the table.
 */
import type { AppContext } from '../app/app';
import { PlayerPrefs } from '../app/services';
import {
  AgentStrategyState, buildAgentConfig, cleanAgentName,
  type AgentBudgetFields, type AgentDeploymentConfig, type AgentDeploymentProgress, type AgentHandRecord,
  type AgentHandReplay, type AgentSessionHistory,
} from '@nomad/engine/agents';
import type { AgentBackend } from './agentBackend';
import { AgentDeployService } from './agentDeployService';
import { replaySession } from './replaySession';
import { ReplayDialogs } from './ui/replayDialogs';
import { message } from './ui/dom';

/** NomadUiHost.PaintAgentStatus' one status line and pill. */
export interface AgentStatus {
  active: boolean;
  /** "Idle" | "Playing" | "Stopping". */
  pill: string;
  /** "Not playing" / "Looking for a table" / "Playing · hand 6/100 · +175 Coins". */
  line: string;
  progress: AgentDeploymentProgress | null;
}

export class AgentsService {
  /** The session list the screens paint (FetchSessionHistoryAsync(10, 0)). */
  history: AgentSessionHistory | null = null;
  readonly dialogs: ReplayDialogs;
  /** After a 3D replay, the Agents screen reopens this session's hands (Back to hands). */
  reopenHands: { deploymentId: string; label: string } | null = null;
  private readonly layer: HTMLElement;
  /** Where message boxes go: the Nomad host's (set by the agents partial), else a small DOM box on the dialog layer. */
  messageSink: ((title: string, body: string, ok: string | null, onOk?: (input?: string) => void, cancel?: string | null,
    onCancel?: () => void, input?: { placeholder: string; value?: string }) => void) | null = null;

  constructor(
    private readonly ctx: AppContext,
    readonly deploy: AgentDeployService,
    readonly strategy: AgentStrategyState,
  ) {
    this.layer = document.createElement('div');
    this.layer.className = 'agent-dialog-layer';
    document.body.append(this.layer);
    this.dialogs = new ReplayDialogs({
      layer: this.layer,
      fetchHands: (id, limit, offset) => this.deploy.fetchHandHistory(id, limit, offset),
      watchAtTable: (hand, replay, label) => this.watchAtTable(hand, replay, label),
      message: (title, body) => this.message(title, body),
    });
  }

  get backend(): AgentBackend {
    return this.deploy.backend;
  }

  /** A Nomad-style message box on the dialog layer (NomadUiHost.Message). */
  message(title: string, body: string, ok: string | null = 'OK', onOk?: (input?: string) => void, cancel: string | null = null,
    onCancel?: () => void, input?: { placeholder: string; value?: string }): void {
    if (this.messageSink) this.messageSink(title, body, ok, onOk, cancel, onCancel, input);
    else message(this.layer, title, body, ok, onOk, cancel, onCancel, input);
  }

  get agentActive(): boolean {
    return this.deploy.hasActiveDeployment;
  }

  status(): AgentStatus {
    const active = this.agentActive;
    const progress = active ? this.deploy.lastProgress : null;
    const pill = active ? (progress?.stopRequested ? 'Stopping' : 'Playing') : 'Idle';
    const net = progress ? (progress.NetPnl >= 0 ? '+' : '') + progress.NetPnl.toLocaleString('en-US') : '';
    const line = !active ? 'Not playing'
      : !progress ? 'Looking for a table'
      : `${progress.stopRequested ? 'Stopping after this hand' : 'Playing'} · hand ${progress.HandsPlayed}/${progress.MaxHands} · ${net} Coins`;
    return { active, pill, line, progress };
  }

  /** NomadUiHost.RefreshAgentHistoryAsync. */
  async refreshHistory(): Promise<AgentSessionHistory | null> {
    try {
      this.history = await this.deploy.fetchSessionHistory(10, 0);
    } catch (e) {
      console.warn('[agents] history: ' + String(e));
    }
    this.ctx.events.emit('agents:changed');
    return this.history;
  }

  /** NomadUiHost.BuildAgentConfig from the Overview's fields and the Strategy screen's numbers. */
  buildConfig(fields: AgentBudgetFields, copiedStrategyId: string | null = null): AgentDeploymentConfig {
    return buildAgentConfig(this.strategy, fields, { ownerName: this.ctx.services.account?.displayName ?? null, copiedStrategyId });
  }

  /** NomadUiHost.RenameAgent's rule. Null when saved, else the message to show. */
  rename(raw: string): string | null {
    const name = cleanAgentName(raw);
    if (name.length < 2) return 'Use at least 2 letters or digits.';
    this.strategy.agentName = name;
    this.ctx.events.emit('agents:changed');
    return null;
  }

  /** Opens a session's hands (the Session History row tap). `index` is the row (newest first). */
  openSessionHands(index: number): void {
    const sessions = this.history?.Sessions;
    if (!sessions || index < 0 || index >= sessions.length) return;
    const s = sessions[index]!;
    void this.dialogs.openSession(s, `#${(this.history?.Total ?? sessions.length) - index}`);
  }

  /**
   * The web port's "Watch at the table": the hand replays on the 3D table; Back returns to the menu, which shows the
   * Session History and reopens this session's hands (agents partial).
   */
  watchAtTable(hand: AgentHandRecord, replay: AgentHandReplay, sessionLabel: string): void {
    this.reopenHands = hand.DeploymentId ? { deploymentId: hand.DeploymentId, label: sessionLabel } : null;
    void this.ctx.router.navigate('table', {
      session: replaySession(replay, {
        returnTo: this.ctx.router.has('menu') ? 'menu' : undefined,
        title: `Session ${sessionLabel} · Hand #${replay.handNumber || hand.HandNumber}`,
      }),
    });
  }

  /** After the Session History repainted: reopen the hands list a 3D replay came from. */
  consumeReopen(): void {
    const r = this.reopenHands;
    this.reopenHands = null;
    if (!r) return;
    const sessions = this.history?.Sessions ?? [];
    const i = sessions.findIndex((s) => s.DeploymentId === r.deploymentId);
    if (i >= 0) void this.dialogs.openSession(sessions[i]!, r.label);
  }
}

/** PlayerPrefs as the strategy state's store. */
export const prefsStore = {
  getString: (k: string, fb = '') => PlayerPrefs.getString(k, fb),
  setString: (k: string, v: string) => PlayerPrefs.setString(k, v),
  deleteKey: (k: string) => PlayerPrefs.deleteKey(k),
};
