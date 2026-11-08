/**
 * Port of Assets/Scripts/Net/NomadUi/NomadUiHost.Agents.cs (the Coins Agents part) onto the menu's Nomad host: the
 * Agents_Overview / Agents_Strategy / Agents_SessionHistory screens bound by name to the `agents` service, plus the
 * Overview's NomadAgentStrategySummary component and the Coins half of PaintAgentFieldsForMode (NomadUiHost.Onchain.cs).
 * Level rewards / missions and the lucky slot (the other half of that C# file) belong to the retention module.
 *
 * ONCHAIN (SOL Agents) stays with the web3 partial: it can take over through `agentsOnchain` below.
 */
import type { AppContext } from '../../app/app';
import type { UNode } from '../../hud/unityUi';
import type { NomadHost } from '../../menu/host';
import { widgetsOf } from '../../menu/ui/tree';
import { marketState } from '../../menu/screens/market';
import { AgentStopReasons, readNumberField, type AgentDeploymentSummary } from '@nomad/engine/agents';
import { formatN0 } from '@nomad/engine/util/dotnetMath';
import type { AgentsService } from '../agentsService';
import { bindStrategyEditor } from './strategyEditor';

const AGENT_SCREENS = ['Agents_Overview', 'Agents_Strategy', 'Agents_SessionHistory'];
const GOOD = { r: 0.4, g: 0.9, b: 0.5, a: 1 };
const BAD = { r: 0.95, g: 0.4, b: 0.4, a: 1 };
const WHITE = { r: 1, g: 1, b: 1, a: 1 };

/** The SOL Agent (NomadUiHost.Onchain.cs) hooks, for the web3 partial: used instead of the Coins paths when host.onchain. */
export const agentsOnchain: {
  deployOrStop?: () => void;
  /** PollSolAgent + PaintSolAgent. */
  paintStatus?: () => void;
  /** PaintSolHistory. */
  refreshHistory?: () => void;
  /** PaintAgentFieldsForMode's ONCHAIN labels and defaults. */
  paintFields?: (overview: UNode) => void;
} = {};

/** Session History status label and the chip look it borrows (PaintAgentHistory). */
export function stopReasonLabel(reason: string | null): { label: string; look: string } {
  const label = reason === AgentStopReasons.Bust ? 'Bust'
    : reason === AgentStopReasons.OwnerStop ? 'Stopped'
    : reason === AgentStopReasons.StopLoss ? 'Stop loss'
    : reason === AgentStopReasons.ProfitTarget ? 'Target hit'
    : reason === AgentStopReasons.Halted ? 'Server stopped' : 'Completed';
  const look = label === 'Stop loss' || label === 'Server stopped' ? 'Stopped' : label === 'Target hit' ? 'Completed' : label;
  return { label, look };
}

const signedN0 = (v: number, zeroPlus = true) => (v > 0 || (zeroPlus && v === 0) ? '+' : '') + formatN0(v);

export function agentsPartial(svc: AgentsService) {
  return (host: NomadHost, ctx: AppContext): void => {
    let nextPoll = 0;
    let wasActive = svc.agentActive;
    const statusTags = new Map<string, unknown>();
    const onchain = () => host.onchain;

    // Dialogs (rename, deploy, stop, the replay's "couldn't load") go through the Nomad message box.
    svc.messageSink = (title, body, ok, onOk, cancel, onCancel, input) =>
      host.message(title, body, ok, onOk ? () => onOk() : undefined, cancel, onCancel, input?.placeholder ?? null, input ? (v) => onOk?.(v) : undefined, input?.value ?? null);

    /** Rebind: drops the art's and any earlier listeners, then this one. */
    const rebind = (root: UNode | null, path: string, action: () => void) => {
      const b = host.bind(root, path, null, true);
      b?.reset();
      b?.addListener(action);
    };

    // ---------------------------------------------------------------- BindAgents

    const overview = host.screen('Agents_Overview');
    if (overview) {
      // Edit next to the Agent's name renames it; the strategy card opens the Strategy tab.
      rebind(overview, 'Panel_YourAgent/AgentCard/Btn_Edit', renameAgent);
      host.setText(overview, 'Panel_YourAgent/AgentCard/Btn_Edit/Label', 'Rename');
      host.bind(overview, 'Panel_YourAgent/StrategyCard', () => host.show('Agents_Strategy'));
      host.bind(overview, 'Btn_ReviewDeploy', deployOrStop);
    }
    const strategy = host.screen('Agents_Strategy');
    if (strategy) {
      // Bare minimum: the Advanced Settings options have nothing behind them yet.
      host.setActive(strategy, 'Panel_Parameters/Btn_AdvancedSettings', false);
      host.setActive(strategy, 'Panel_Parameters/AdvancedDropdown', false);
    }
    const history = host.screen('Agents_SessionHistory');
    if (history) {
      for (let i = 1; i <= 10; i++) {
        const row = host.find(history, `Panel_History/Table/Viewport/Content/Row_${i}`);
        // The sample rows' status tags (Completed / Bust / Stopped), to reuse for real sessions.
        const tag = host.find(row, 'Status');
        const label = host.find(row, 'Status/Label');
        const text = label?.text?.text ?? '';
        if (tag?.image && label && !statusTags.has(text)) statusTags.set(text, tag.image.sprite);
        // Tapping a session lists its hands, each with a replay (NomadUiHost.Replay.cs → ui/replayDialogs.ts).
        const index = i - 1;
        if (row) host.ensureButton(row).addListener(() => openAgentSessionHands(index));
      }
    }
    svc.deploy.onChanged(() => {
      const active = svc.agentActive;
      if (wasActive && !active) void refreshAgentHistory(); // it just ended: its session joins the list
      wasActive = active;
      host.refreshSoon();
    });
    svc.strategy.onChanged(() => paintStrategySummaryCard());

    bindStrategyEditor(host, svc);

    // NomadUiHost.OnScreenShown and RefreshAll.
    host.onScreenShown('Agents_Overview', () => void refreshAgents());
    host.onScreenShown('Agents_Strategy', () => paintAgentStatus());
    host.onScreenShown('Agents_SessionHistory', () => void refreshAgentHistory());
    host.onRefresh(() => {
      if (host.isShowing('Agents_Overview')) paintAgentStatus();
    });

    // Back from a hand watched at the table: the Session History and that session's hands again.
    ctx.events.on<string | null>('router:changed', (id) => {
      if (id !== 'menu' || !svc.reopenHands) return;
      host.show('Agents_SessionHistory');
    });

    // ---------------------------------------------------------------- actions

    function renameAgent(): void {
      host.message('Rename your Agent', 'Other players see this name at the table.', 'Save', undefined, 'Cancel', undefined, 'Agent name', (raw) => {
        const err = svc.rename(raw);
        if (err) {
          host.message('Rename your Agent', err);
          return;
        }
        paintAgentStatus();
      }, svc.strategy.agentName);
    }

    function readField(root: UNode, name: string, fallback: number): number {
      const f = host.find(root, name);
      const input = f ? widgetsOf(f).input : undefined;
      return input ? readNumberField(input.text, fallback) : fallback;
    }

    function deployOrStop(): void {
      if (!host.signedIn) {
        host.show('Login');
        return;
      }
      if (onchain() && agentsOnchain.deployOrStop) {
        agentsOnchain.deployOrStop();
        return;
      }
      if (svc.agentActive) {
        host.message('Stop your Agent', 'It leaves after the current hand and its stack comes back to your Coins.', 'Stop', () =>
          void host.run(() => svc.deploy.stop()), 'Keep playing');
        return;
      }
      const root = host.screen('Agents_Overview')!;
      const config = svc.buildConfig({
        bankroll: readField(root, 'BankrollField', 5000),
        maxHands: readField(root, 'MaxHandsField', 100),
        maxMinutes: readField(root, 'MaxMinutesField', 60),
        stopLoss: readField(root, 'StopLossField', 0),
        profitTarget: readField(root, 'ProfitField', 0),
      }, marketState.copiedStrategyId);
      const coins = ctx.services.wallet?.coins ?? 0;
      if (config.Bankroll > coins) {
        host.message('Not enough Coins', `The bankroll is ${formatN0(config.Bankroll)} Coins; you have ${formatN0(coins)}.`);
        return;
      }
      host.message('Deploy your Agent',
        `${svc.strategy.styleName} strategy, ${formatN0(config.Bankroll)} Coins bankroll, up to ${config.MaxHands} hands or ${Math.trunc(config.MaxRuntimeSeconds / 60)} minutes.`,
        'Deploy', () => void host.run(() => svc.deploy.deploy(config), () => host.message('Agent deployed', "It's looking for a table. Watch it here.")), 'Cancel');
    }

    function openAgentSessionHands(index: number): void {
      if (onchain()) return; // SOL Agent sessions keep their own records on chain
      svc.openSessionHands(index);
    }

    // ---------------------------------------------------------------- painting

    async function refreshAgents(): Promise<void> {
      paintAgentStatus();
      await refreshAgentHistory();
    }

    async function refreshAgentHistory(): Promise<void> {
      if (onchain() && agentsOnchain.refreshHistory) {
        agentsOnchain.refreshHistory();
        return;
      }
      await svc.refreshHistory();
      paintAgentHistory();
      paintAgentStatus();
      if (svc.reopenHands && host.isShowing('Agents_SessionHistory')) svc.consumeReopen();
    }

    /** NomadAgentStrategySummary on Agents_Overview: preset, playstyle, aggression and bluff bars. */
    function paintStrategySummaryCard(): void {
      const root = host.screen('Agents_Overview');
      if (!root) return;
      const s = svc.strategy;
      host.setText(root, 'Panel_YourAgent/StrategyCard/PresetPill/Label', s.styleName);
      host.setText(root, 'Panel_YourAgent/AgentCard/Playstyle', s.styleName + ' Playstyle');
      host.setFill(root, 'Panel_YourAgent/StrategyCard/AggressionBar/Fill', s.values[2] ?? 0);
      host.setFill(root, 'Panel_YourAgent/StrategyCard/BluffBar/Fill', s.values[3] ?? 0);
    }

    let fieldsPainted: boolean | null = null;
    /** PaintAgentFieldsForMode (Coins): the labels and default budget, once per mode. */
    function paintAgentFieldsForMode(): void {
      const root = host.screen('Agents_Overview');
      if (!root) return;
      const on = onchain();
      if (fieldsPainted === on) return;
      fieldsPainted = on;
      if (on && agentsOnchain.paintFields) {
        agentsOnchain.paintFields(root);
        return;
      }
      host.setText(root, 'BankrollLabel', 'Allocated bankroll');
      host.setText(root, 'StopLossLabel', 'Stop loss');
      host.setText(root, 'ProfitLabel', 'Profit target');
      host.setText(root, 'Note1', 'Plays Coins tables from your Coins. The bankroll is its stack: a deeper stack plays bigger pots.');
      host.setText(root, 'Note2', 'Stop it any time; its stack comes back to your Coins.');
      const setField = (name: string, value: string) => {
        const n = host.find(root, name);
        const input = n ? widgetsOf(n).input : undefined;
        if (!input) return;
        input.input.type = 'text';
        input.input.inputMode = 'numeric';
        input.text = value;
      };
      setField('BankrollField', '5000');
      setField('StopLossField', '2000');
      setField('ProfitField', '0');
    }

    function paintAgentStatus(): void {
      paintAgentFieldsForMode();
      paintStrategySummaryCard();
      if (onchain() && agentsOnchain.paintStatus) {
        agentsOnchain.paintStatus();
        return;
      }
      const st = svc.status();
      const name = svc.strategy.agentName;
      for (const s of AGENT_SCREENS) {
        const root = host.screen(s);
        if (!root) continue;
        host.setText(root, 'AgentHeader/Name', name);
        host.setText(root, 'AgentHeader/Status', st.line);
        host.setText(root, 'AgentHeader/IdlePill/Label', st.pill);
        // The line under the name says it already ("Playing · hand 6/100 · +175 Coins"): one status, not two.
        host.setActive(root, 'AgentHeader/IdlePill', false);
      }
      const ov = host.screen('Agents_Overview');
      if (ov) {
        host.setText(ov, 'Btn_ReviewDeploy/Label', st.active ? 'Stop Agent' : 'Review & Deploy Agent');
        host.setText(ov, 'Panel_YourAgent/AgentCard/Name', name);
        // The card's one line held the full summary, cut to "Risk: m…": a short one fits (the Strategy tab has it all).
        host.setText(ov, 'Panel_YourAgent/StrategyCard/Note/Text', svc.strategy.shortSummary);
        let net = 0;
        let hands = 0;
        let sessions = 0;
        for (const x of svc.history?.Sessions ?? []) {
          net += x.NetPnl;
          hands += x.HandsPlayed;
          sessions++;
        }
        host.setText(ov, 'Panel_RecentPerformance/Stat_Sessions/Value', String(svc.history?.Total ?? sessions));
        host.setText(ov, 'Panel_RecentPerformance/Stat_Handsplayed/Value', formatN0(hands));
        host.setText(ov, 'Panel_RecentPerformance/Stat_Netresult/Value', signedN0(net));
        host.find(ov, 'Panel_RecentPerformance/Stat_Netresult/Value')?.setTextColor(net >= 0 ? GOOD : BAD);
      }
      // While the Agent plays and its screens are open, poll its progress (and settle it when it ends). With none noted
      // on this device, the refresh asks the backend whether one is playing (every 30 s at most).
      const watching = AGENT_SCREENS.some((s) => host.isShowing(s));
      if (watching && (st.active || !onchain()) && performance.now() >= nextPoll) {
        nextPoll = performance.now() + 5000;
        void svc.deploy.refreshProgress();
        if (st.active) void svc.deploy.pollAndSettle();
      }
    }

    function paintAgentHistory(): void {
      const root = host.screen('Agents_SessionHistory');
      if (!root) return;
      const sessions: AgentDeploymentSummary[] = svc.history?.Sessions ?? [];
      const total = svc.history?.Total ?? sessions.length;
      let net = 0;
      let hands = 0;
      for (const x of sessions) {
        net += x.NetPnl;
        hands += x.HandsPlayed;
      }
      host.setText(root, 'Panel_Stats/Value_0', String(total));
      host.setText(root, 'Panel_Stats/Value_1', formatN0(hands));
      host.setText(root, 'Panel_Stats/Value_2', signedN0(net, false));
      host.find(root, 'Panel_Stats/Value_2')?.setTextColor(net > 0 ? GOOD : net < 0 ? BAD : WHITE);
      const used: UNode[] = [];
      const cats: number[] = [];
      for (let i = 1; i <= 10; i++) {
        const row = host.find(root, `Panel_History/Table/Viewport/Content/Row_${i}`);
        if (!row) continue;
        const on = i - 1 < sessions.length;
        row.setActive(on);
        if (!on) continue;
        const x = sessions[i - 1]!;
        host.setText(row, 'Session', `#${total - i + 1}`);
        host.setText(row, 'Col1', formatN0(x.StartingBankroll));
        host.setText(row, 'Col2', formatN0(x.EndingStack));
        host.setText(row, 'Col3', String(x.HandsPlayed));
        host.setText(row, 'Col4', durationText(x.RuntimeSeconds));
        host.setText(row, 'Net', signedN0(x.NetPnl));
        host.find(row, 'Net')?.setTextColor(x.NetPnl >= 0 ? GOOD : BAD);
        // A stop loss read "Completed" (UI pass 20 Oct): each ending says what it was; the chip art borrows the closest.
        const { label, look } = stopReasonLabel(x.StopReason);
        host.setText(row, 'Status/Label', label);
        const tag = host.find(row, 'Status');
        const sprite = statusTags.get(look);
        if (tag?.image && sprite !== undefined && tag.image.sprite !== sprite) {
          tag.image.sprite = sprite as typeof tag.image.sprite;
          tag.render();
        }
        used.push(row);
        cats.push(x.NetPnl >= 0 ? 1 : -1);
      }
      // "Completed = normal end, Bust = …" repeated what each row's status chip says.
      const panel = host.find(root, 'Panel_History');
      for (const t of panel?.walk() ?? []) if ((t.text?.text ?? '').startsWith('Completed = ')) t.setActive(false);
      // The profit / loss filter pills work on the rows that hold sessions.
      const filter = panel ? widgetsOf(panel).rowFilter : undefined;
      if (filter) {
        filter.rows.splice(0, filter.rows.length, ...used);
        (filter as unknown as { rowCategory: number[] }).rowCategory = cats;
        filter.select(0);
      }
      host.emptyNote(panel, 'No sessions yet. Deploy your Agent from Overview.', used.length === 0);
    }
  };
}

/** NomadUiHost.Duration (Mathf.RoundToInt: half to even). */
function durationText(seconds: number): string {
  const r = Math.round(seconds);
  const s = Math.max(0, Math.abs(seconds % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r);
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
