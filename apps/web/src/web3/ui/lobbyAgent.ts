/**
 * 'private-agent': Per/Unity/PerAgentPanel.cs (M12c) — the Agents panel of the private-tables lobby: strategy and
 * limits, Deploy (the play key sets the Agent key on chain, no wallet prompt), what it's doing, Stop, its sessions.
 * The runner is the private-tables backend (agents.ts); every request is signed by the play key. Refreshes every
 * 10 s while open and idle (Update).
 */
import { PublicKey } from '@solana/web3.js';
import type { AppContext } from '../../app/app';
import type { PerRuntime } from '../per/service';
import { closeScreen, type PanelFactory, type PanelImpl } from './lazy';
import { box, button, column, errMsg, line, logStatus, PerCanvas, PerColor, text, type PerButton, type PerText } from './perUi';
import { w3 } from '../services';

const STRATEGIES = ['conservative', 'balanced', 'aggressive', 'custom'];
const STRATEGY_LABELS = ['Conservative', 'Balanced', 'Aggressive', 'Custom'];
const STAKES = [10_000_000n, 25_000_000n, 50_000_000n, 100_000_000n];
const BUY_IN_BB = [25, 50, 100];
const HANDS = [25, 100, 500];
const MINUTES = [15, 60, 240, 1440];
const LOSS_PCT = [0, 25, 50];
const PROFIT_PCT = [0, 50, 100];
/** Custom: fold below, raise above, aggression, bluff, bet size (fraction of the pot); the runner clamps them. */
const CUSTOM_NAMES = ['Fold below', 'Raise above', 'Aggression', 'Bluff', 'Bet size'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "dd MMM HH:mm" (invariant culture), local time. */
export function sessionWhen(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())} ${MONTHS[d.getMonth()]} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** PerAgentPanel.Label. */
export const agentLabel = (status: string): string => ({ running: 'playing', stopping: 'leaving', prepared: 'not started' } as Record<string, string>)[status] ?? 'stopped';

class AgentPanel implements PanelImpl {
  private readonly canvas: PerCanvas;
  private readonly custom = [0.3, 0.66, 0.52, 0.07, 0.62];
  private strategy = 1;
  private stake = 1;
  private buyIn = 1;
  private hands = 1;
  private minutes = 1;
  private loss = 0;
  private profit = 0;
  private busy = false;
  private alive = true;
  private status!: PerText;
  private now!: PerText;
  private history!: PerText;
  private readonly customTexts: PerText[] = [];
  private readonly groups: PerButton[][] = [];
  private refreshAt = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly ctx: AppContext,
    private readonly per: PerRuntime,
    private readonly root: HTMLElement,
  ) {
    this.canvas = new PerCanvas(root, 'PerAgents');
    this.build(this.canvas.root);
    void this.refresh();
    this.timer = setInterval(() => {
      if (!this.busy && performance.now() - this.refreshAt > 10_000) void this.refresh();
    }, 1000);
  }

  private build(root: HTMLElement): void {
    const sol = this.per.format.sol;
    box(root, 'Dim', PerColor.Dim, [0, 0], [1, 1]);
    const panel = box(root, 'Panel', PerColor.Panel, [0.14, 0.04], [0.86, 0.96]);
    const col = column(panel, 'Column', [0, 0], [1, 1], 6, 20);
    text(col, '<b>Agent</b>: plays private SOL tables for you', 32);
    text(col, "It stakes from your game balance and its winnings go back there. On chain it can only buy in (up to your stake), play its seat and leave: it can't withdraw. One Agent at a time; other players see a normal seat.", 19).color = [1, 1, 1, 0.7];
    this.group(col, 'Strategy', STRATEGY_LABELS, (i) => (this.strategy = i), 220);
    const custom = line(col, 52, PerColor.Clear);
    CUSTOM_NAMES.forEach((_, k) => {
      button(custom, '−', () => ((this.custom[k] = Math.max(0, this.custom[k]! - 0.05)), (this.strategy = 3), this.paint()), PerColor.Muted, 44);
      this.customTexts.push(text(custom, '', 18, 'Center', 1.4));
      button(custom, '+', () => ((this.custom[k] = Math.min(1.2, this.custom[k]! + 0.05)), (this.strategy = 3), this.paint()), PerColor.Muted, 44);
    });
    this.group(col, 'Most at risk (each Deploy)', STAKES.map((s) => sol(s)), (i) => (this.stake = i), 180);
    this.group(col, 'Buy-in', BUY_IN_BB.map((b) => `${b} BB`), (i) => (this.buyIn = i), 140);
    this.group(col, 'Stop after', HANDS.map((h) => `${h} hands`), (i) => (this.hands = i), 180);
    this.group(col, 'Or after', MINUTES.map((m) => (m < 60 ? `${m} min` : `${m / 60} h`)), (i) => (this.minutes = i), 140);
    this.group(col, 'Stop-loss (per table)', LOSS_PCT.map((p) => (p === 0 ? 'Off' : `−${p}% of stake`)), (i) => (this.loss = i), 200);
    this.group(col, 'Profit target (per table)', PROFIT_PCT.map((p) => (p === 0 ? 'Off' : `+${p}% of stake`)), (i) => (this.profit = i), 200);
    const buttons = line(col, 60, PerColor.Clear);
    button(buttons, 'Deploy', () => void this.deploy(), PerColor.Accent, 200);
    button(buttons, 'Stop', () => void this.stop(), PerColor.Warn, 160);
    button(buttons, 'Refresh', () => void this.refresh(), PerColor.Muted, 160);
    button(buttons, 'Close', () => closeScreen(this.ctx, this.root), PerColor.Muted, 160);
    this.status = text(col, '', 20);
    this.now = text(col, '', 21);
    this.history = text(col, '', 18, 'TopLeft', 3);
    this.paint();
  }

  private group(col: HTMLElement, title: string, labels: string[], pick: (i: number) => void, width: number): void {
    const row = line(col, 50, PerColor.Clear);
    text(row, title, 20, 'Left', 1.2);
    this.groups.push(labels.map((l, k) => button(row, l, () => (pick(k), this.paint()), PerColor.Muted, width)));
  }

  private paint(): void {
    const picked = [this.strategy, this.stake, this.buyIn, this.hands, this.minutes, this.loss, this.profit];
    this.groups.forEach((g, gi) => g.forEach((b, i) => (b.color = i === picked[gi] ? PerColor.Selected : PerColor.Muted)));
    this.customTexts.forEach((t, i) => (t.text = `${CUSTOM_NAMES[i]} ${this.custom[i]!.toFixed(2)}`));
  }

  private settings(): Record<string, unknown> {
    const stake = STAKES[this.stake]!;
    const s: Record<string, unknown> = {
      strategy: STRATEGIES[this.strategy], stake: Number(stake), buyInBB: BUY_IN_BB[this.buyIn], maxHands: HANDS[this.hands], maxMinutes: MINUTES[this.minutes],
      stopLoss: Number((stake * BigInt(LOSS_PCT[this.loss]!)) / 100n), profitTarget: Number((stake * BigInt(PROFIT_PCT[this.profit]!)) / 100n),
    };
    if (this.strategy === 3) {
      const [foldBelow, raiseAbove, aggression, bluffChance, raiseFractionOfPot] = this.custom.map((v) => Math.round(v * 100) / 100);
      s.custom = { foldBelow, raiseAbove, aggression, bluffChance, raiseFractionOfPot };
    }
    return { settings: s };
  }

  private call(key: Parameters<PerRuntime['agent']['call']>[2], path: string, data: Record<string, unknown> | null = null) {
    return this.per.agent.call(this.per.http, this.per.config.perBackendUrl, key, path, data);
  }

  private async deploy(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const per = this.per;
    const st = (s: string) => this.setStatus(s);
    try {
      if (!(await w3(this.ctx).solana.connect())) return this.setStatus('Connect a wallet first.');
      await per.gameWallet.ensureVault(st, 'no Agent was deployed');
      const key = await per.gameWallet.playKey(st);
      const stake = STAKES[this.stake]!;
      const balance = (await per.balance(st)) ?? 0n;
      if (balance < stake) return this.setStatus(`Your game balance is ${per.format.sol(balance)}; the stake is ${per.format.sol(stake)}. Deposit first, or pick a smaller stake.`);
      st('Getting an Agent key from the Agent service…');
      const prep = await this.call(key, '/agents/prepare', this.settings());
      // M12 review M2: the stake and end time set on chain are the ones chosen here, never what the service answers.
      const until = Math.floor(Date.now() / 1000) + Math.min(MINUTES[this.minutes]! * 60 + 15 * 60, per.agent.MAX_SECONDS - 60);
      let answered: bigint;
      try {
        answered = BigInt(String(prep.stake));
      } catch {
        answered = -1n;
      }
      if (answered !== stake) throw new Error('the Agent service answered with a different stake');
      st('Setting your Agent on chain (your play key signs; no wallet prompt)…');
      await per.gameWallet.sendAsKey(key, per.agent.set(key, new PublicKey(String(prep.agent)), until, stake)[1]!);
      let last: unknown = null;
      for (let i = 0; i < 6; i++) {
        await per.http.delay(2000);
        try {
          await this.call(key, '/agents/start');
          last = null;
          break;
        } catch (e) {
          last = e;
        }
      }
      if (last) throw last;
      st('Your Agent is playing. It looks for a public table with players at your stake.');
      await this.refresh();
    } catch (e) {
      this.setStatus("Couldn't deploy: " + errMsg(e));
      console.error(e);
    } finally {
      this.busy = false;
    }
  }

  private async stop(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const per = this.per;
    try {
      if (!(await w3(this.ctx).solana.connect())) return this.setStatus('Connect a wallet first.');
      const key = await per.gameWallet.playKey((s) => this.setStatus(s));
      this.setStatus('Stopping: it leaves after the hand being played…');
      // On chain first (M12 review M3), so the Agent key can't buy in again whatever the service does.
      let onChain: string | null = null;
      let service: string | null = null;
      try {
        await per.gameWallet.sendAsKey(key, per.agent.stop(key)[1]!);
      } catch (e) {
        onChain = errMsg(e);
        console.warn('[PerAgent] on-chain stop: ' + onChain);
      }
      try {
        await this.call(key, '/agents/stop');
      } catch (e) {
        service = errMsg(e);
      }
      this.setStatus(onChain === null && service === null ? 'Stopped. Its seat cashes out into your game balance after this hand.'
        : onChain === null ? "Stopped on chain (it can't buy in again); the Agent service didn't answer: " + service
        : 'The Agent service is stopping it, but the on-chain stop failed: ' + onChain);
      await this.refresh();
    } catch (e) {
      this.setStatus("Couldn't stop: " + errMsg(e));
      console.error(e);
    } finally {
      this.busy = false;
    }
  }

  private async refresh(): Promise<void> {
    this.refreshAt = performance.now();
    const w = this.per.gameWallet.address;
    if (!w || !this.per.gameWallet.hasPlayKey(w)) {
      this.now.text = 'Connect your wallet to see your Agent.';
      return;
    }
    try {
      const key = await this.per.gameWallet.playKey((s) => this.setStatus(s));
      const me = await this.call(key, '/agents/me');
      if (!this.alive) return;
      const a = me.agent && typeof me.agent === 'object' ? (me.agent as Record<string, unknown>) : null;
      this.now.text = !a ? 'No Agent yet.' : `Your Agent: <b>${agentLabel(String(a.status))}</b> · ${String(a.detail ?? '')}`;
      const lines: string[] = [];
      for (const s of (Array.isArray(me.sessions) ? me.sessions : []) as Record<string, unknown>[]) {
        const buyIn = BigInt(String(s.buy_in ?? '0'));
        const end = BigInt(String(s.cash_out === null || s.cash_out === undefined ? (s.stack ?? '0') : s.cash_out));
        const delta = end - buyIn;
        const when = sessionWhen(new Date(String(s.started_at)));
        const res = s.ended_at === null || s.ended_at === undefined ? 'playing' : String(s.end_reason);
        lines.push(`${when} · table ${String(s.table_address).slice(0, 6)}… · ${Number(s.hands) | 0} hands · ${delta >= 0n ? '<color=#5ed39b>+' : '<color=#e07e7e>−'}${this.per.format.sol(delta < 0n ? -delta : delta)}</color> · ${res}`);
        if (lines.length >= 8) break;
      }
      this.history.text = lines.length === 0 ? '' : '<b>Sessions</b>\n' + lines.join('\n');
    } catch (e) {
      if (this.alive) this.now.text = "Couldn't reach the Agent service: " + errMsg(e);
    }
  }

  private setStatus(s: string): void {
    if (this.alive) this.status.text = s;
    logStatus('PerAgent', s);
  }

  unmount(): void {
    this.alive = false;
    clearInterval(this.timer);
    this.canvas.dispose();
  }
}

export const agentPanel: PanelFactory<Record<string, never>> = (ctx, per, root) => new AgentPanel(ctx, per, root);
