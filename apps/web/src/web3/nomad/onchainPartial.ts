/**
 * Nomad menu: the DEMO / ONCHAIN play mode and everything ONCHAIN does with the screens the art has. Port of
 * Net/NomadUi/NomadUiHost.Onchain.cs plus the SOL parts of NomadUiHost.Menu.cs (ProfileDropdown wallet / balance /
 * Deposit / Withdraw, the SOL capsule, "MY SOL TABLES", "Disconnect wallet") and NomadUiHost.Social.cs (SOL table
 * select, ONCHAIN Party), registered on the menu porter's host with registerNomadPartial.
 *
 * ONCHAIN plays the private SOL tables (devnet): Quick Play and Tables sit at a public table the backend finds or
 * opens, Party creates a default table to share by code, Agents deploy the SOL Agent, and the profile's Deposit /
 * Withdraw move SOL into and out of the game balance. DEMO is the Coins game as before.
 *
 * Nothing here touches the network until the player does something: @solana/web3.js and the PER runtime load on the
 * first ONCHAIN action (`per.get()`); the balance is read in the background only once this device has a play key and
 * a connected wallet (LoadSolSoon), never at boot.
 */
import type { AppContext } from '../../app/app';
import { agentsOnchain } from '../../agents/nomad/agentsPartial';
import { nomadSocialHooks } from '../../economy/nomad/social';
import type { UNode, RGBA } from '../../hud/unityUi';
import { NomadHost, registerNomadPartial } from '../../menu/host';
import { quickPlayOverrides, settingsAccountExtras, solTablesHandlers } from '../../menu/screens/mainMenu';
import { tableSelectOnchain } from '../../menu/screens/tableSelect';
import { widgetsOf } from '../../menu/ui/tree';
import { setOffsets } from '../../menu/ui/canvas';
import { StakeCatalog } from '@nomad/engine';
import { formatN0 } from '../per/format';
import { LAMPORTS_PER_DOLLAR, PerBuyIn, sol, solExact, STAKES, stakeMaxBuyIn, stakeMinBuyIn } from '../per/money';
import type { PerRuntime } from '../per/service';
import type { PlayKey } from '../per/vault';
import type { Stakes } from '../per/entry';
import { NomadPlayMode } from '../solana/identity';
import { w3 } from '../services';
import { copyText, friendlyError } from '../ui/perUi';
import { marketOnchain, marketState, solProfile, type AgentStrategyLike } from '../../menu/screens/market';
import { copyTerms, deployBusyText, deployedText, withCopiedStrategy } from './solAgentCopy';

/** 0.5 devnet SOL (the playtest's Deposit). */
const DEPOSIT_LAMPORTS = 500_000_000n;
const AGENT_SCREENS = ['Agents_Overview', 'Agents_Strategy', 'Agents_SessionHistory'];
const GOOD: RGBA = { r: 0.4, g: 0.9, b: 0.5, a: 1 };
const BAD: RGBA = { r: 0.95, g: 0.4, b: 0.4, a: 1 };
const WHITE: RGBA = { r: 1, g: 1, b: 1, a: 1 };
/** WithdrawalPhase values (per/withdrawal.ts), without importing the lazy chunk. */
const Phase = { None: 0, OnTheWay: 1, Ready: 2 } as const;

/** "Timeout or cancelled" and friends as the player should read them (NomadUiHost.Friendly). */
export function friendly(e: unknown): string {
  const m = (e as Error)?.message ?? String(e ?? '');
  if (/Timeout or cancelled|declined|rejected|cancel/i.test(m))
    return 'Your wallet didn\'t sign. If it said "Network mismatch", switch the wallet\'s network to Devnet (in the wallet\'s settings) and try again.';
  return friendlyError(m);
}

/** ONCHAIN actions for screens outside the Unity tree (Redesign v2, src/ui2). Filled when the partial binds. */
export interface OnchainApi {
  toggleMode(): Promise<void>;
  connectWallet(): Promise<boolean>;
  refreshSol(): Promise<void>;
  deposit(): Promise<void>;
  withdraw(): Promise<void>;
  copyWallet(): void;
  /** "◎0.5 ($50.00)", "Not connected", plus a withdrawal note. */
  balanceText(): string;
  walletAddress(): string | null;
  quickPlay(level: number, buyIn?: bigint): Promise<void>;
  partyCreate(): Promise<void>;
  partyJoin(code: string): Promise<void>;
  openPrivateTables(): void;
  tableStakes(level: number): { blinds: string; minBuyIn: string; buyIn: string; label: string };
  stepBuyIn(level: number, dir: number): unknown;
  setBuyInEnd(level: number, end: 'min' | 'max' | 'double'): unknown;
  joinTable(level: number): unknown;
}
export const onchainApi: Partial<OnchainApi> = {};

/** The one-time "Connect a wallet?" offer after the first guest sign-in (off in Redesign v2: offered on On-chain). */
export const walletOfferAfterGuest = { enabled: false };

export function registerOnchainPartial(): void {
  registerNomadPartial((host, ctx) => new OnchainPartial(host, ctx).bind());
}

class OnchainPartial {
  private moneyMoving = false;
  private solBalance: bigint | null = null;
  private nextSolCheck = 0;
  private solAgent: Record<string, any> | null = null;
  private nextSolAgentPoll = 0;
  private withdrawalPhase: number = Phase.None;
  private withdrawalSubscribed = false;
  private walletOffered = false;
  private solBuyIn = 0n;
  private readonly memo = new WeakMap<UNode, string>();
  private readonly statusTags = new Map<string, unknown>();
  private fieldsMode: boolean | null = null;

  constructor(
    private readonly host: NomadHost,
    private readonly ctx: AppContext,
  ) {}

  private get solana() {
    return w3(this.ctx).solana;
  }
  private get per(): PerRuntime | null {
    return w3(this.ctx).per.loaded;
  }
  private loadPer(): Promise<PerRuntime> {
    return w3(this.ctx).per.get().then((p) => {
      this.subscribeWithdrawal(p);
      return p;
    });
  }
  private get onchain(): boolean {
    return NomadPlayMode.onchain;
  }
  private set onchain(v: boolean) {
    NomadPlayMode.onchain = v;
    this.host.onchain = v;
  }
  private now(): number {
    return performance.now() / 1000;
  }
  private get phase(): number {
    return this.per?.withdrawal.current ?? Phase.None;
  }

  bind(): void {
    const host = this.host;
    host.onchain = NomadPlayMode.onchain;
    // Each part binds on its own: one screen missing from the art must not take the others down.
    for (const [name, step] of [['mode toggles', () => this.bindModeToggles()], ['main menu', () => this.bindMenu()], ['table select', () => this.bindTableSelect()], ['agents', () => this.bindAgents()]] as const) {
      try {
        step();
      } catch (e) {
        console.error(`[NomadUi.Onchain] binding the ${name} failed`, e);
      }
    }
    nomadSocialHooks.onchainParty = (create, code) => (create ? void this.partyCreate() : void this.partyJoin(code));
    quickPlayOverrides.push(() => {
      if (!this.onchain) return false;
      void this.quickPlay(0);
      return true;
    });
    solTablesHandlers.push(() => this.openPrivateTables());
    // Redesign v2 screens (src/ui2) call the same ONCHAIN actions without the Unity nodes.
    Object.assign(onchainApi, {
      toggleMode: () => this.toggleMode(),
      connectWallet: () => this.connectWallet(),
      refreshSol: () => this.refreshSol(),
      deposit: () => this.depositHalfSol(),
      withdraw: () => this.withdrawAll(),
      copyWallet: () => this.copyWalletAddress(),
      balanceText: () => {
        const addr = this.solana.address;
        const w = this.per?.withdrawal;
        const withdrawing = this.phase === Phase.Ready ? ` · ${sol(w!.arrived)} ready to receive` : this.phase === Phase.OnTheWay ? ` · withdrawing ${sol(w!.amount)}` : '';
        this.loadSolSoon();
        return (!addr ? 'Not connected' : this.solBalance !== null ? `${sol(this.solBalance)} (${solExact(this.solBalance)})` : 'Tap to load balance') + withdrawing;
      },
      walletAddress: () => this.solana.address ?? null,
      quickPlay: (level: number, buyIn?: bigint) => this.quickPlay(level, buyIn ?? 0n),
      partyCreate: () => this.partyCreate(),
      partyJoin: (code: string) => this.partyJoin(code),
      openPrivateTables: () => this.openPrivateTables(),
      tableStakes: (level: number) => {
        const l = Math.min(Math.max(level, 0), STAKES.length - 1);
        const st = STAKES[l]!;
        return { blinds: `${sol(st.small)} / ${sol(st.big)}`, minBuyIn: sol(stakeMinBuyIn(l)), buyIn: sol(this.solBuyInFor(l)), label: st.label };
      },
      stepBuyIn: (level: number, dir: number) => tableSelectOnchain.step?.(host, level, dir),
      setBuyInEnd: (level: number, end: 'min' | 'max' | 'double') => tableSelectOnchain.setEnd?.(host, level, end),
      joinTable: (level: number) => tableSelectOnchain.join?.(host, level),
    } satisfies OnchainApi);
    settingsAccountExtras.push((_h, rows) => {
      if (this.solana.isConnected)
        rows.push(['Disconnect wallet', () => {
          host.dialogs.close();
          void this.solana.disconnect();
          host.message('Wallet disconnected', 'SOL games ask for a wallet again. Your game balance stays yours on chain.');
          host.refreshSoon();
        }]);
    });
    // Redesign v2: no wallet offer right after the first guest sign-in (nothing interrupts the first hand). The wallet
    // is offered when the player picks On-chain (toggleMode connects first). Re-enable with walletOfferAfterGuest.
    if (walletOfferAfterGuest.enabled) host.afterGuest.push(() => this.offerWalletAfterGuest());
    this.ctx.events.on('web3:wallet-changed', () => host.refreshSoon());
    host.onRefresh(() => this.refresh());
    // M9c: opened from an invite link: go straight to the private tables (PerMenuButton). Only a page whose address
    // names an invite loads the PER code for it; nothing else happens at boot.
    if (typeof location !== 'undefined' && /[?&#]invite=[0-9a-f]{32}/.test(location.href))
      void this.loadPer().then((p) => {
        if (p.invites.readLinkOnce()) this.openPrivateTables();
      });
  }

  // ------------------------------------------------------------------------------ mode

  /** Switching to ONCHAIN connects the wallet first; DEMO needs nothing. */
  private async toggleMode(): Promise<void> {
    if (this.onchain) {
      this.onchain = false;
      this.paintMode();
      return;
    }
    if (!(await this.connectWallet())) return;
    this.onchain = true;
    this.paintMode();
  }

  private async connectWallet(): Promise<boolean> {
    if (this.solana.isConnected) return true;
    let ok = false;
    try {
      // The message waits until a wallet is chosen: shown before, it sat on top of the wallet picker.
      ok = await this.solana.connect(undefined, { onPicked: () => this.host.busy('Connect wallet', 'Approve the connection in your wallet…') });
    } catch (e) {
      // A missing wallet is an expected case the wallet sheet already showed: no error in the console for it.
      if (!(e as { shown?: boolean }).shown) console.error(e);
      this.host.closeMessage();
      // The wallet sheet already told the player (no wallet installed): don't repeat it in a second dialog.
      if (!(e as { shown?: boolean }).shown) this.host.message('Wallet', (e as Error).message || 'No wallet connected. On-chain play needs a Solana wallet.');
      return false;
    }
    this.host.closeMessage();
    if (!ok) this.host.message('Wallet', 'No wallet connected. On-chain play needs a Solana wallet.');
    return ok;
  }

  private bindModeToggles(): void {
    const host = this.host;
    const toggle = () => void this.toggleMode();
    const dd = host.find('MainMenu', 'ProfileDropdown');
    if (dd) {
      host.bind(dd, 'Panel/PlayModeToggle', toggle);
      host.bind(dd, 'Panel/PlayModeToggle/Active_Demo', toggle, true);
    }
    const tables = host.screen('TableSelect_TownLobby');
    if (tables) {
      host.bind(tables, 'TopBar/ModeToggle', toggle);
      host.bind(tables, 'TopBar/ModeToggle/Active_Demo', toggle, true);
    }
    this.paintMode();
  }

  /** The toggles' active pill sits on DEMO in the art: it moves to ONCHAIN's half in ONCHAIN mode. */
  private paintMode(): void {
    const host = this.host;
    const on = this.onchain;
    host.onchain = on;
    this.paintToggle(host.find('MainMenu', 'ProfileDropdown/Panel/PlayModeToggle'), 'Demo', on);
    this.paintToggle(host.find('TableSelect_TownLobby', 'TopBar/ModeToggle'), 'Active_Demo/Label', on);
    // Coins tournaments are DEMO; ONCHAIN ones are in the private lobby.
    for (const s of ['Tournaments_Browse', 'Tournaments_MyTournaments', 'Tournaments_Host', 'Tournaments_JoinByCode']) host.setText(s, 'TopBar/Mode', 'DEMO');
    host.refreshSoon();
  }

  private readonly pillPad = new WeakMap<UNode, number>();

  /** Each label centred in its own half of the track; the pill fills the active half (NomadPillMemo). */
  private paintToggle(toggle: UNode | null, demoLabelPath: string, onchain: boolean): void {
    if (!toggle) return;
    const pill = this.host.find(toggle, 'Active_Demo');
    if (pill) {
      let pad = this.pillPad.get(pill);
      if (pad === undefined) {
        pad = Math.max(0, (toggle.sizeDelta[1] - pill.sizeDelta[1]) / 2);
        this.pillPad.set(pill, pad);
      }
      pill.anchorMin = [onchain ? 0.5 : 0, 0];
      pill.anchorMax = [onchain ? 1 : 0.5, 1];
      setOffsets(pill, [onchain ? 0 : pad, pad], [onchain ? -pad : 0, -pad]);
    }
    const demo = this.host.find(toggle, demoLabelPath);
    const chain = this.host.find(toggle, 'Onchain');
    const bright = WHITE;
    const dim = { r: 0.55, g: 0.62, b: 0.91, a: 1 };
    const half = (t: UNode | null, from: number, color: RGBA) => {
      if (!t?.text) return;
      if (t.parent !== toggle) {
        const p = t.parent;
        if (p) p.children.splice(p.children.indexOf(t), 1);
        toggle.add(t);
      }
      t.anchorMin = [from, 0];
      t.anchorMax = [from + 0.5, 1];
      setOffsets(t, [6, 0], [-6, 0]);
      t.text.alignH = 'center';
      t.setTextColor(color);
      t.setAsLastSibling();
    };
    half(demo, 0, onchain ? dim : bright);
    half(chain, 0.5, onchain ? bright : dim);
    toggle.layout();
  }

  // ------------------------------------------------------------------------------ main menu, profile

  private bindMenu(): void {
    const host = this.host;
    const root = host.screen('MainMenu');
    if (!root) return;
    // ONCHAIN: the SOL capsule refreshes the game balance (or, with a withdrawal under way, shows it or finishes it).
    host.bind(root, 'TopBar/Stat_Coins', () => {
      if (!this.onchain) return; // DEMO: the menu's own binding opens the daily spin
      if (this.phase === Phase.Ready) this.offerFinishWithdrawal();
      else if (this.phase === Phase.OnTheWay) this.showWithdrawalOnTheWay();
      else void this.refreshSol();
    });
    const dd = host.find(root, 'ProfileDropdown');
    if (!dd) return;
    // SOL lives in the private tables' game balance (devnet): Deposit puts 0.5 SOL in, Withdraw takes it all out.
    host.bind(dd, 'Panel/Btn_Deposit', () => void this.depositHalfSol());
    host.bind(dd, 'Panel/WalletTitle', () => this.copyWalletAddress());
    host.bind(dd, 'Panel/SolBalance', () => void this.refreshSol());
    host.bind(dd, 'Panel/Btn_Withdraw', () => void this.withdrawAll());
  }

  private openPrivateTables(): void {
    if (!this.host.signedIn) return this.host.show('Login');
    // Redesign v2: Tables › Private tables (src/ui2/screens/play.ts) is the private SOL tables lobby.
    this.host.show('TableSelect_TownLobby');
    this.ctx.services.ui2?.show('tables', 'priv');
  }

  private refresh(): void {
    const host = this.host;
    const menu = host.screen('MainMenu');
    if (menu) {
      if (this.onchain) host.setText(menu, 'TopBar/Stat_Coins/Value', host.solShort);
      this.paintWithdrawal(menu);
      this.paintProfile(menu);
    }
  }

  /** Your wallet (address, tap to copy) and the game balance in $ (and SOL) (NomadUiHost.Menu PaintProfile). */
  private paintProfile(menu: UNode): void {
    const host = this.host;
    const dd = host.find(menu, 'ProfileDropdown');
    if (!dd?.activeInHierarchy) return;
    const addr = this.solana.address;
    host.setText(dd, 'Panel/WalletTitle', addr ? `WALLET  ${addr.slice(0, 4)}…${addr.slice(-4)}` : 'WALLET (SOL)');
    const w = this.per?.withdrawal;
    const withdrawing = this.phase === Phase.Ready ? `  ·  ${sol(w!.arrived)} ready to receive` : this.phase === Phase.OnTheWay ? `  ·  withdrawing ${sol(w!.amount)}` : '';
    host.setText(dd, 'Panel/SolBalance', (!addr ? 'Not connected' : this.solBalance !== null ? `${sol(this.solBalance)}  (${solExact(this.solBalance)})` : 'Tap to load balance') + withdrawing);
    host.setActive(dd, 'Panel/Btn_Withdraw', !!addr);
    const depositLabel = host.find(dd, 'Panel/Btn_Deposit/Label');
    if (depositLabel?.text) {
      if (!this.memo.has(depositLabel)) this.memo.set(depositLabel, depositLabel.text.text === 'Connect' ? 'Deposit' : depositLabel.text.text);
      const want = !addr ? 'Connect' : this.memo.get(depositLabel)!;
      if (depositLabel.text.text !== want) depositLabel.setText(want);
    }
    // The balance was laid out beside a SOL coin (a placeholder, hidden): it lines up under WALLET instead.
    const sb = host.find(dd, 'Panel/SolBalance');
    const wt = host.find(dd, 'Panel/WalletTitle');
    if (sb && wt && !this.memo.has(sb)) {
      this.memo.set(sb, 'aligned');
      sb.anchorMin = [...wt.anchorMin];
      sb.anchorMax = [...wt.anchorMax];
      sb.pivot = [...wt.pivot];
      sb.anchoredPosition = [wt.anchoredPosition[0], sb.anchoredPosition[1]];
      sb.sizeDelta = [Math.max(wt.sizeDelta[0], sb.sizeDelta[0]), sb.sizeDelta[1]];
      if (sb.text) sb.text.alignH = 'left';
      sb.layout();
    }
    this.loadSolSoon();
  }

  private setBalance(b: bigint): void {
    this.solBalance = b;
    this.host.solShort = sol(b);
    this.host.refreshSoon();
  }

  /** Reads the game balance now (asked for: a wallet signature is fine if this device has no play key yet). */
  private async refreshSol(): Promise<void> {
    if (!(await this.connectWallet())) return;
    try {
      this.host.busy('Game balance', 'Checking your game balance…');
      const per = await this.loadPer();
      const bal = await per.balance((s) => this.host.busy('Game balance', s));
      this.host.closeMessage();
      this.setBalance(bal ?? 0n);
      this.nextSolCheck = this.now() + 15;
    } catch (e) {
      this.host.message('Game balance', friendly(e));
      console.error(e);
    }
  }

  /** Only with a play key already on this device and a connected wallet (no wallet prompt from opening a menu). */
  private loadSolSoon(): void {
    if (this.now() < this.nextSolCheck) return;
    this.nextSolCheck = this.now() + 15;
    const per = this.per;
    const addr = per?.gameWallet.address;
    if (!per || !addr || !per.gameWallet.hasPlayKey(addr)) return;
    void per.balance(() => {}).then(
      (b) => b !== null && this.setBalance(b),
      (e) => console.warn('[NomadUi] SOL balance:', (e as Error).message),
    );
  }

  private copyWalletAddress(): void {
    const addr = this.solana.address;
    if (!addr) return void this.connectWallet();
    copyText(addr);
    this.host.message('Wallet', `Your wallet address is copied:\n<size=80%>${addr}</size>`);
  }

  // ------------------------------------------------------------------------------ game balance

  /** Review #10: a deposit or withdrawal is running; a second tap must not start a second one. */
  private isMoneyMoving(title: string): boolean {
    if (!this.moneyMoving) return false;
    this.host.message(title, 'A deposit or withdrawal is still running. Finish it in your wallet, or wait a moment and try again.');
    return true;
  }

  private async depositHalfSol(): Promise<void> {
    if (this.isMoneyMoving('Deposit')) return;
    this.moneyMoving = true;
    try {
      await this.depositHalfSolAsync();
    } finally {
      this.moneyMoving = false;
    }
  }

  private async depositHalfSolAsync(): Promise<void> {
    if (!(await this.connectWallet())) return;
    const host = this.host;
    try {
      const per = await this.loadPer();
      await per.gameWallet.assertCanDeposit(DEPOSIT_LAMPORTS); // before opening the game balance costs rent
      await per.gameWallet.ensureVault((s) => host.busy('Deposit', s), 'nothing was deposited');
      await per.deposit(DEPOSIT_LAMPORTS, (s) => host.busy('Deposit 0.5 SOL', s));
      // The deposit reaches the game balance after a moment: read it again until it moves (a few tries).
      const before = this.solBalance ?? 0n;
      host.busy('Deposited', `0.5 devnet SOL (${sol(DEPOSIT_LAMPORTS)}) is on its way to your game balance…`);
      for (let i = 0; i < 6; i++) {
        await wait(3000);
        try {
          const bal = (await per.balance((s) => host.busy('Deposited', s))) ?? 0n;
          this.setBalance(bal);
          if (bal > before) break;
        } catch (e) {
          console.warn('[NomadUi] balance after deposit:', (e as Error).message);
        }
      }
      this.nextSolCheck = this.now() + 15;
      host.message('Deposited', `Your game balance: ${host.solShort}. Tap the balance any time to refresh it.`);
    } catch (e) {
      host.message('Deposit failed', friendly(e));
      console.error(e);
    }
  }

  /** Withdraw all runs in the background (PerWithdrawal); the same button finishes or reports one under way. */
  private async withdrawAll(): Promise<void> {
    if (this.isMoneyMoving('Withdraw')) return;
    if (this.phase === Phase.Ready) return this.offerFinishWithdrawal();
    if (this.phase === Phase.OnTheWay) return this.showWithdrawalOnTheWay();
    if (!(await this.connectWallet())) return;
    const host = this.host;
    // A balance already read as 0: say so now instead of asking to confirm a withdrawal of nothing.
    if (this.solBalance === 0n) return host.message('Withdraw', 'Your game balance is empty. Deposit or win at a SOL table first.');
    host.message('Withdraw', 'Send your whole game balance back to your wallet?', 'Withdraw all', () => {
      if (this.isMoneyMoving('Withdraw')) return;
      this.moneyMoving = true;
      void (async () => {
        try {
          const per = await this.loadPer();
          let last: string | null = null;
          const sent = await per.withdrawal.start((s) => {
            last = s;
            host.busy('Withdraw', s);
          });
          this.nextSolCheck = 0; // the game balance went down
          host.refreshSoon();
          if (sent > 0n)
            host.message('Withdrawal started', `${sol(sent)} is on its way to Solana (about a minute). You can keep playing; when it arrives, approve receiving it with Finish withdrawal (in your profile, or tap your balance).`);
          else if (this.phase === Phase.Ready) this.offerFinishWithdrawal();
          else if (this.phase === Phase.OnTheWay) this.showWithdrawalOnTheWay();
          else host.message('Withdraw', last ?? 'Your game balance is empty.');
        } catch (e) {
          host.message('Withdraw failed', friendly(e));
          console.error(e);
        } finally {
          this.moneyMoving = false;
        }
      })();
    }, 'Cancel');
  }

  private showWithdrawalOnTheWay(): void {
    const w = this.per?.withdrawal;
    if (!w) return;
    w.checkSoon();
    const arrived = w.arrived;
    this.host.message('Withdrawal in progress', `${sol(w.amount)} is on its way to Solana`
      + (arrived > 0n ? ` (${sol(arrived)} has arrived so far)` : '')
      + (w.slow ? ". It's taking longer than usual; it's safe to leave the game, and it continues next time." : '. It usually takes about a minute.')
      + ' Finish withdrawal appears here when it has arrived.');
  }

  private offerFinishWithdrawal(): void {
    const w = this.per?.withdrawal;
    if (!w) return;
    this.host.message('Finish withdrawal', `${sol(w.arrived)} has arrived on Solana. Approve receiving it in your wallet.`,
      'Finish withdrawal', () => void this.finishWithdrawal(), 'Later');
  }

  private async finishWithdrawal(): Promise<void> {
    if (this.isMoneyMoving('Withdraw')) return;
    if (!(await this.connectWallet())) return;
    const host = this.host;
    this.moneyMoving = true;
    try {
      const per = await this.loadPer();
      const paid = await per.withdrawal.finish((s) => host.busy('Finish withdrawal', s));
      // Read the balance again rather than assume it's zero (chips cashed out meanwhile stay in it).
      try {
        this.setBalance((await per.balance(() => {})) ?? 0n);
      } catch (e) {
        console.warn('[NomadUi] balance after withdraw:', (e as Error).message);
      }
      this.nextSolCheck = this.now() + 15;
      host.refreshSoon();
      host.message('Withdrawn', `${sol(paid)} is in your wallet as SOL. Your game balance: ${host.solShort}.`
        + (per.withdrawal.current !== Phase.None ? ` The rest (${sol(per.withdrawal.amount)}) is still on its way.` : ''));
    } catch (e) {
      host.message('Finish withdrawal failed', friendly(e));
      console.error(e);
    } finally {
      this.moneyMoving = false;
    }
  }

  private subscribeWithdrawal(per: PerRuntime): void {
    if (this.withdrawalSubscribed) return;
    this.withdrawalSubscribed = true;
    this.withdrawalPhase = per.withdrawal.current;
    per.withdrawal.onChanged(() => this.onWithdrawalChanged());
    per.withdrawal.resume(); // a withdrawal saved by an earlier visit carries on (only once the player is ONCHAIN here)
  }

  /** The background withdrawal moved on: repaint, and say so if it arrived (or was dropped) while the menu is free. */
  private onWithdrawalChanged(): void {
    const was = this.withdrawalPhase;
    this.withdrawalPhase = this.phase;
    this.host.refreshSoon();
    if (was !== Phase.OnTheWay || this.host.dialogs.isOpen || this.moneyMoving) return;
    if (this.withdrawalPhase === Phase.Ready) this.offerFinishWithdrawal();
    else if (this.withdrawalPhase === Phase.None)
      this.host.message('Withdraw', "The withdrawal didn't reach Solana, so nothing left your game balance. Try Withdraw all again.");
  }

  /** Profile panel and top bar: "Withdrawing" while it's on its way, "Finish withdrawal" once it has arrived. */
  private paintWithdrawal(menu: UNode): void {
    const host = this.host;
    const phase = this.phase;
    if (phase === Phase.OnTheWay) this.per?.withdrawal.checkSoon();
    if (this.onchain && phase !== Phase.None) host.setText(menu, 'TopBar/Stat_Coins/Caption', phase === Phase.Ready ? 'FINISH' : 'WITHDRAWING');
    const label = host.find(menu, 'ProfileDropdown/Panel/Btn_Withdraw/Label');
    if (!label?.text) return;
    if (!this.memo.has(label)) this.memo.set(label, label.text.text);
    const want = phase === Phase.Ready ? 'Finish withdrawal' : phase === Phase.OnTheWay ? 'Withdrawing…' : this.memo.get(label)!;
    if (label.text.text !== want) label.setText(want);
  }

  /** Wallet connected, game balance opened, play key ready, and at least `need` in the game balance (else an offer
   * to deposit). Returns the play key, or null. */
  private async readyForOnchain(need: bigint, what: string): Promise<{ per: PerRuntime; key: PlayKey } | null> {
    const host = this.host;
    if (!host.signedIn) {
      host.show('Login');
      return null;
    }
    if (!(await this.connectWallet())) return null;
    const per = await this.loadPer();
    await per.gameWallet.ensureVault((s) => host.busy(what, s), 'nothing happened');
    const key = await per.gameWallet.playKey((s) => host.busy(what, s));
    const bal = (await per.balance((s) => host.busy(what, s))) ?? 0n;
    this.setBalance(bal);
    if (bal < need) {
      host.message('Deposit first', `${what} needs ${sol(need)} in your game balance; you have ${sol(bal)}.`, 'Deposit 0.5 SOL', () => void this.depositHalfSol(), 'Cancel');
      return null;
    }
    return { per, key };
  }

  /** PerEntry.Join with the busy note as its status; if not seated, Join's last status is the message. */
  private async joinOnchainTable(per: PerRuntime, title: string, table: string, buyIn: bigint, shown: Stakes): Promise<void> {
    let last: string | null = null;
    const params = await per.join(table, buyIn, (s) => {
      last = s;
      this.host.busy(title, s);
    }, shown);
    if (params) {
      this.host.dialogs.closeBusy();
      await this.ctx.router.navigate('table', params);
    } else this.host.message(title, last ?? "Couldn't sit at the table. Try again.");
  }

  // ------------------------------------------------------------------------------ ONCHAIN quick play, tables, party

  private async quickPlay(level: number, pickedBuyIn = 0n): Promise<void> {
    const host = this.host;
    level = Math.min(Math.max(level, 0), STAKES.length - 1);
    const { label, small, big } = STAKES[level]!;
    const min = stakeMinBuyIn(level);
    const max = stakeMaxBuyIn(level);
    try {
      const ready = await this.readyForOnchain(min > pickedBuyIn ? min : pickedBuyIn, 'Quick Play');
      if (!ready) return;
      const { per, key } = ready;
      host.busy('Quick Play', `Finding a ${label} table…`);
      const res = await per.agent.call(per.http, per.config.perBackendUrl, key, '/quickplay/onchain', { stake: level });
      if (res.needHostFee != null) {
        // No table at this stake has players: the service opens one, paid from the game balance. Asked first.
        const fee = BigInt(String(res.needHostFee));
        const { PublicKey } = await import('@solana/web3.js');
        const hostWallet = new PublicKey(String(res.hostWallet));
        host.message('Open a table?', `No ${label} table has players right now. Open a new one for ${sol(fee)} (its rent), paid from your game balance?`, 'Open it', () => {
          void (async () => {
            try {
              host.busy('Quick Play', `Paying ${sol(fee)} for the table (your play key signs)…`);
              await per.gameWallet.sendAsKey(key, per.agent.payHostFee(key, fee, hostWallet)[1]!);
              void this.quickPlay(level, pickedBuyIn);
            } catch (e) {
              host.message('Quick Play failed', friendly(e));
              console.error(e);
            }
          })();
        }, 'Cancel');
        return;
      }
      const bal = (await per.balance(() => {})) ?? 0n;
      const want = pickedBuyIn > 0n ? pickedBuyIn : PerBuyIn.for(min, max, big);
      // The backend matches the big blind only: the small blind must be the picked stake's too.
      await this.joinOnchainTable(per, 'Quick Play', String(res.table), want < bal ? want : bal, { smallBlind: small, bigBlind: big });
    } catch (e) {
      host.message('Quick Play failed', friendly(e));
      console.error(e);
    }
  }

  /** Party in ONCHAIN mode: a default table (the lowest SOL stake, 8 seats, public) hosted by you, shared by code. */
  private async partyCreate(): Promise<void> {
    const host = this.host;
    const { small, big } = STAKES[0]!;
    const p = { smallBlind: small, bigBlind: big, minBuyIn: stakeMinBuyIn(0), maxBuyIn: stakeMaxBuyIn(0), maxSeats: 8, inviteOnly: false };
    try {
      const ready = await this.readyForOnchain(p.minBuyIn, 'Party');
      if (!ready) return;
      const { per, key } = ready;
      const wallet = per.gameWallet.address!;
      const id = per.host.newTableId();
      const table = per.host.tableAddress(wallet, id);
      host.busy('Party', 'Approve creating your table in your wallet…');
      await per.gameWallet.l1.sendWithWallet(per.host.createAndDelegate(wallet, id, p), per.gameWallet.signer);
      per.hostedTables.add(wallet, table, id);
      host.busy('Party', 'Opening your table (no wallet prompt)…');
      const { PerTableAddresses } = await import('../per/addresses');
      const t = new PerTableAddresses(table);
      let last: unknown = null;
      for (let i = 0; i < 10; i++) {
        await wait(3000);
        try {
          await per.gameWallet.sendAsKey(key, per.host.open(t, key.key.publicKey));
          last = null;
          break;
        } catch (e) {
          last = e;
        }
      }
      if (last) throw new Error("the table was created but couldn't be opened yet: " + ((last as Error).message ?? last));
      const code = table.toBase58().slice(0, 6);
      copyText(code);
      host.message('Your table is ready', `Party code <b>${code}</b> (copied). Your friends enter it in Party, Join.`, 'Sit down', () => {
        void (async () => {
          try {
            const bal = (await per.balance(() => {})) ?? 0n;
            const want = PerBuyIn.for(p.minBuyIn, p.maxBuyIn, p.bigBlind);
            await this.joinOnchainTable(per, 'Party', table.toBase58(), want < bal ? want : bal, { smallBlind: p.smallBlind, bigBlind: p.bigBlind, minBuyIn: p.minBuyIn, maxBuyIn: p.maxBuyIn });
          } catch (e) {
            host.message("Couldn't sit", friendly(e));
            console.error(e);
          }
        })();
      }, 'Later');
    } catch (e) {
      host.message("Couldn't create the table", friendly(e));
      console.error(e);
    }
  }

  private async partyJoin(rawCode: string): Promise<void> {
    const host = this.host;
    try {
      host.busy('Join a table', 'Finding the table…');
      const per = await this.loadPer();
      const tables = await per.listTables();
      // Addresses are base58, so case matters. Two tables sharing the code (one made to look like it) are refused.
      const code = (rawCode ?? '').trim();
      const found = tables.filter((t) => code.length > 0 && String(t.address ?? '').startsWith(code));
      if (found.length === 0) return host.message('Join a table', 'No open table has that code (codes are case-sensitive).');
      if (found.length > 1) return host.message('Join a table', "More than one table has that code. Ask your friend for the table's full address.");
      const f = found[0]!;
      const min = BigInt(String(f.minBuyIn));
      const max = BigInt(String(f.maxBuyIn));
      const big = BigInt(String(f.bigBlind));
      const small = BigInt(String(f.smallBlind));
      const ready = await this.readyForOnchain(min, 'Join a table');
      if (!ready) return;
      const bal = (await per.balance(() => {})) ?? 0n;
      const want = PerBuyIn.for(min, max, big);
      await this.joinOnchainTable(per, 'Join a table', String(f.address), want < bal ? want : bal, { smallBlind: small, bigBlind: big, minBuyIn: min, maxBuyIn: max });
    } catch (e) {
      host.message("Couldn't join", friendly(e));
      console.error(e);
    }
  }

  // ------------------------------------------------------------------------------ table select (NomadUiHost.Social)

  private solBuyInFor(level: number): bigint {
    const min = stakeMinBuyIn(level);
    const max = stakeMaxBuyIn(level);
    return this.solBuyIn < min ? min : this.solBuyIn > max ? max : this.solBuyIn;
  }

  private bindTableSelect(): void {
    const lvl = (l: number) => Math.min(Math.max(l, 0), STAKES.length - 1);
    tableSelectOnchain.paint = (host, root, level) => {
      const l = lvl(level);
      const st = STAKES[l]!;
      host.setText(root, 'SelectedTablePanel/Stakes', `${StakeCatalog.Tiers[l]?.displayName ?? st.label} Stakes (SOL)`);
      host.setText(root, 'SelectedTablePanel/Blinds', `${sol(st.small)} / ${sol(st.big)}`);
      host.setText(root, 'SelectedTablePanel/MinBuyIn', `Minimum buy-in: ${sol(stakeMinBuyIn(l))}`);
      host.setText(root, 'SelectedTablePanel/BuyInField/Value', sol(this.solBuyInFor(l)));
      const join = host.find(root, 'SelectedTablePanel/Btn_JoinTable');
      if (join) widgetsOf(join).button?.setInteractable(true);
      return true;
    };
    tableSelectOnchain.setEnd = (_host, level, end) => {
      const l = lvl(level);
      this.solBuyIn = end === 'min' ? stakeMinBuyIn(l) : end === 'max' ? stakeMaxBuyIn(l) : this.solBuyInFor(l) * 2n;
      return true;
    };
    tableSelectOnchain.step = (_host, level, dir) => {
      const l = lvl(level);
      const step = 10n * STAKES[l]!.big;
      const cur = this.solBuyInFor(l);
      this.solBuyIn = dir > 0 ? cur + step : cur > step ? cur - step : 0n;
      return true;
    };
    tableSelectOnchain.join = (host, level) => {
      if (!host.signedIn) {
        host.show('Login');
        return true;
      }
      // ONCHAIN: the $ stake that matches the card, at the buy-in picked here.
      void this.quickPlay(lvl(level), this.solBuyInFor(lvl(level)));
      return true;
    };
  }

  // ------------------------------------------------------------------------------ ONCHAIN Agents (SOL)

  private bindAgents(): void {
    // The art's status chips (Completed / Bust / Stopped) on the history rows, for PaintSolHistory.
    const hist = this.host.screen('Agents_SessionHistory');
    for (let i = 1; hist && i <= 10; i++) {
      const row = this.host.find(hist, `Panel_History/Table/Viewport/Content/Row_${i}`);
      const label = row && this.host.find(row, 'Status/Label')?.text?.text;
      const tag = row && this.host.find(row, 'Status');
      if (label && tag?.image && !this.statusTags.has(label)) this.statusTags.set(label, tag.image.sprite);
    }
    agentsOnchain.deployOrStop = () => void this.deployOrStop();
    agentsOnchain.paintStatus = () => {
      this.pollSolAgent();
      this.paintSolAgent();
    };
    agentsOnchain.refreshHistory = () => {
      this.paintSolHistory();
      this.nextSolAgentPoll = 0;
      this.pollSolAgent();
    };
    agentsOnchain.paintFields = (root) => this.paintAgentFields(root);
    // The SOL marketplace (NomadUiHost.Market's ONCHAIN half): its requests, the wallet that decides SolCopy.Own, $.
    marketOnchain.loadSol = (title, path, show, signed, data) => void this.loadSol(title, path, show, signed, data);
    marketOnchain.walletAddress = () => this.solana.address;
    marketOnchain.sol = (lamports) => sol(lamports);
  }

  /** NomadUiHost.LoadSol: the SOL marketplace (per/backend solStrategies.ts): public GETs, or requests signed by the play key. */
  private async loadSol(title: string, path: string, show: (j: Record<string, unknown>) => void, signed: boolean, data: Record<string, unknown> | null): Promise<void> {
    const host = this.host;
    try {
      let j: Record<string, unknown>;
      if (signed) {
        if (!(await this.connectWallet())) return;
        const per = await this.loadPer();
        const key = await per.gameWallet.playKey((s) => host.busy(title, s));
        host.busy(title, 'Loading…');
        j = await per.agent.call(per.http, per.config.perBackendUrl, key, path, data);
      } else {
        host.busy(title, 'Loading…');
        const per = await this.loadPer();
        j = await per.agent.get(per.http, per.config.perBackendUrl, path);
      }
      show(j);
    } catch (e) {
      host.message(title, friendly(e));
      console.error(e);
    }
  }

  /** The Overview's setup fields mean SOL in ONCHAIN mode (stake, stop-loss, profit target). */
  private paintAgentFields(root: UNode): void {
    const host = this.host;
    if (this.fieldsMode === true) return;
    this.fieldsMode = true;
    host.setText(root, 'BankrollLabel', 'Stake ($, most at risk)');
    host.setText(root, 'StopLossLabel', 'Stop loss ($)');
    host.setText(root, 'ProfitLabel', 'Profit target ($)');
    host.setText(root, 'Note1', "Plays public SOL tables (devnet) from your game balance; it can't withdraw. The stake is its stack: deeper plays bigger pots.");
    host.setText(root, 'Note2', 'Stop it any time; its seat cashes out into your game balance.');
    const set = (name: string, value: string) => {
      const n = host.find(root, name);
      const input = n ? widgetsOf(n).input : undefined;
      if (!input) return;
      input.input.type = 'text';
      input.input.inputMode = 'numeric';
      input.text = value;
    };
    set('BankrollField', '250');
    set('StopLossField', '0');
    set('ProfitField', '0');
    // The agents partial repaints the Coins defaults when the mode goes back to DEMO; next ONCHAIN paints ours again.
    setTimeout(() => (this.fieldsMode = null), 0);
  }

  private readField(root: UNode, field: string, fallback: number): number {
    const n = this.host.find(root, field);
    const v = Number.parseFloat((n ? widgetsOf(n).input?.text : '')?.replace(/[,$]/g, '') ?? '');
    return Number.isFinite(v) ? v : fallback;
  }

  /** A $ field as lamports ($1 = 0.0001 SOL). */
  private readSol(root: UNode, field: string, fallbackDollars: number): bigint {
    return BigInt(Math.max(0, Math.round(this.readField(root, field, fallbackDollars) * Number(LAMPORTS_PER_DOLLAR))));
  }

  private get solAgentRunning(): boolean {
    const s = this.solAgent?.agent?.status;
    return s === 'running' || s === 'stopping';
  }

  private async deployOrStop(): Promise<void> {
    const host = this.host;
    try {
      if (this.solAgentRunning) {
        if (!(await this.connectWallet())) return;
        const per = await this.loadPer();
        const k = await per.gameWallet.playKey((s) => host.busy('Stop', s));
        host.busy('Stop your Agent', 'Stopping (on chain first, then the service)…');
        try {
          await per.gameWallet.sendAsKey(k, per.agent.stop(k)[1]!);
        } catch (e) {
          console.warn('[NomadUi] on-chain stop:', (e as Error).message);
        }
        await per.agent.call(per.http, per.config.perBackendUrl, k, '/agents/stop');
        host.message('Stopping', 'Your Agent leaves after this hand; its seat cashes out into your game balance.');
        this.nextSolAgentPoll = 0;
        return;
      }
      const root = host.screen('Agents_Overview');
      if (!root) return;
      const stake = this.readSol(root, 'BankrollField', 250);
      if (stake < stakeMinBuyIn(0)) return host.message('Agent', `The stake must be at least ${sol(stakeMinBuyIn(0))} (a Micro table's buy-in).`);
      const ready = await this.readyForOnchain(stake, 'Your Agent');
      if (!ready) return;
      const { per, key } = ready;
      const maxMinutes = Math.trunc(this.readField(root, 'MaxMinutesField', 60));
      // Agents v2: a copied marketplace strategy (Market panel). The service plays its profile; the fee terms go on
      // chain with the Agent below.
      const copy = marketState.copiedSol;
      const settings = withCopiedStrategy({
        strategy: 'custom',
        custom: solProfile(this.strategy),
        stake: Number(stake), buyInBB: 50, maxHands: Math.trunc(this.readField(root, 'MaxHandsField', 100)), maxMinutes,
        stopLoss: Number(this.readSol(root, 'StopLossField', 0)), profitTarget: Number(this.readSol(root, 'ProfitField', 0)),
      }, copy);
      host.busy('Your Agent', 'Getting an Agent key from the Agent service…');
      const prep = await per.agent.call(per.http, per.config.perBackendUrl, key, '/agents/prepare', { settings });
      if (BigInt(String(prep.stake)) !== stake) throw new Error('the Agent service answered with a different stake');
      const { PublicKey } = await import('@solana/web3.js');
      // Sign only the terms the player was shown (none for their own strategy).
      const terms = copyTerms(copy, this.solana.address, prep.terms, (creator, c, p) => per.agent.terms(new PublicKey(creator), c, p));
      const until = BigInt(Math.floor(Date.now() / 1000) + Math.min(maxMinutes * 60 + 15 * 60, per.agent.MAX_SECONDS - 60));
      host.busy('Your Agent', deployBusyText(copy));
      await per.gameWallet.sendAsKey(key, per.agent.set(key, new PublicKey(String(prep.agent)), until, stake, terms)[1]!);
      let last: unknown = null;
      for (let i = 0; i < 6; i++) {
        await wait(2000);
        try {
          await per.agent.call(per.http, per.config.perBackendUrl, key, '/agents/start');
          last = null;
          break;
        } catch (e) {
          last = e;
        }
      }
      if (last) throw last;
      host.message('Agent deployed', deployedText(sol(stake), copy));
      this.nextSolAgentPoll = 0;
    } catch (e) {
      host.message('Agent', friendly(e));
      console.error(e);
    }
  }

  /** AgentStrategyState (agents module), for SolProfile (menu/screens/market.ts solProfile). */
  private get strategy(): AgentStrategyLike | undefined {
    return (this.ctx.services as unknown as { agentStrategy?: AgentStrategyLike }).agentStrategy;
  }

  private pollSolAgent(): void {
    if (this.now() < this.nextSolAgentPoll) return;
    this.nextSolAgentPoll = this.now() + 10;
    const per = this.per;
    const addr = per?.gameWallet.address;
    if (!per || !addr || !per.gameWallet.hasPlayKey(addr) || !per.config.perBackendUrl) return;
    void (async () => {
      try {
        const key = await per.gameWallet.playKey(() => {});
        this.solAgent = await per.agent.call(per.http, per.config.perBackendUrl, key, '/agents/me');
        this.paintSolAgent();
        this.paintSolHistory();
      } catch (e) {
        console.warn('[NomadUi] SOL agent:', (e as Error).message);
      }
    })();
  }

  private paintSolAgent(): void {
    const host = this.host;
    const a = this.solAgent?.agent as Record<string, any> | undefined;
    const status = String(a?.status ?? '');
    const pill = status === 'running' ? 'Playing' : status === 'stopping' ? 'Stopping' : 'Idle';
    const line = !a ? 'SOL Agent · Not deployed' : 'SOL Agent · ' + NomadHost.short(String(a.detail ?? ''), 60);
    for (const s of AGENT_SCREENS) {
      const root = host.screen(s);
      if (!root) continue;
      host.setText(root, 'AgentHeader/Name', 'Your SOL Agent');
      host.setText(root, 'AgentHeader/Status', line);
      host.setText(root, 'AgentHeader/IdlePill/Label', pill);
    }
    const overview = host.screen('Agents_Overview');
    if (!overview) return;
    host.setText(overview, 'Btn_ReviewDeploy/Label', this.solAgentRunning ? 'Stop Agent' : 'Review & Deploy Agent');
    const arr = this.sessions();
    let net = 0n;
    let hands = 0;
    for (const x of arr) {
      hands += Number(x.hands);
      net += sessionNet(x);
    }
    host.setText(overview, 'Panel_RecentPerformance/Stat_Sessions/Value', String(arr.length));
    host.setText(overview, 'Panel_RecentPerformance/Stat_Handsplayed/Value', formatN0(hands));
    host.setText(overview, 'Panel_RecentPerformance/Stat_Netresult/Value', signedSol(net));
    host.find(overview, 'Panel_RecentPerformance/Stat_Netresult/Value')?.setTextColor(net > 0n ? GOOD : net < 0n ? BAD : WHITE);
  }

  private sessions(): Record<string, any>[] {
    return Array.isArray(this.solAgent?.sessions) ? (this.solAgent!.sessions as Record<string, any>[]) : [];
  }

  private paintSolHistory(): void {
    const host = this.host;
    const root = host.screen('Agents_SessionHistory');
    if (!root) return;
    const arr = this.sessions(); // none yet: an empty history, not the art's sample rows
    let net = 0n;
    let hands = 0;
    for (const x of arr) {
      net += sessionNet(x);
      hands += Number(x.hands);
    }
    host.setText(root, 'Panel_Stats/Value_0', String(arr.length));
    host.setText(root, 'Panel_Stats/Value_1', formatN0(hands));
    host.setText(root, 'Panel_Stats/Value_2', signedSol(net));
    host.find(root, 'Panel_Stats/Value_2')?.setTextColor(net > 0n ? GOOD : net < 0n ? BAD : WHITE);
    const used: UNode[] = [];
    const cats: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const row = host.find(root, `Panel_History/Table/Viewport/Content/Row_${i}`);
      if (!row) continue;
      const on = i - 1 < arr.length;
      row.setActive(on);
      if (!on) continue;
      const x = arr[i - 1]!;
      const buyIn = BigInt(String(x.buy_in));
      const d = sessionNet(x);
      const ended = x.ended_at != null;
      host.setText(row, 'Session', `#${arr.length - i + 1}`);
      host.setText(row, 'Col1', sol(buyIn));
      host.setText(row, 'Col2', sol(buyIn + d > 0n ? buyIn + d : 0n));
      host.setText(row, 'Col3', String(Number(x.hands)));
      const start = Date.parse(String(x.started_at));
      const stop = ended ? Date.parse(String(x.ended_at)) : Date.now();
      host.setText(row, 'Col4', NomadHost.duration((stop - start) / 1000));
      host.setText(row, 'Net', (d >= 0n ? '+' : '−') + sol(d < 0n ? -d : d));
      host.find(row, 'Net')?.setTextColor(d >= 0n ? GOOD : BAD);
      const reason = String(x.end_reason ?? '');
      const label = !ended ? 'Playing' : reason.includes('lost its stack') ? 'Bust' : reason.includes('stopped') ? 'Stopped' : 'Completed';
      host.setText(row, 'Status/Label', label);
      const tag = host.find(row, 'Status');
      const sprite = this.statusTags.get(label === 'Playing' ? 'Completed' : label);
      if (tag?.image && sprite !== undefined && tag.image.sprite !== sprite) {
        tag.image.sprite = sprite as typeof tag.image.sprite;
        tag.render();
      }
      used.push(row);
      cats.push(d >= 0n ? 1 : -1);
    }
    const panel = host.find(root, 'Panel_History');
    const filter = panel ? widgetsOf(panel).rowFilter : undefined;
    if (filter) {
      filter.rows.splice(0, filter.rows.length, ...used);
      (filter as unknown as { rowCategory: number[] }).rowCategory = cats;
      filter.select(0);
    }
    host.emptyNote(panel, 'No SOL sessions yet. Deploy your Agent from Overview.', arr.length === 0);
  }

  // ------------------------------------------------------------------------------ after guest sign-in

  /** Once per device: "Not now" is remembered. */
  private offerWalletAfterGuest(): void {
    const host = this.host;
    const isGuest = (this.ctx.services.account as unknown as { isGuest?: boolean }).isGuest;
    if (this.walletOffered || this.solana.isConnected || !isGuest || localStorage.getItem('nomad.walletOffered') === '1') return;
    this.walletOffered = true;
    try {
      localStorage.setItem('nomad.walletOffered', '1');
    } catch {
      /* ignore */
    }
    host.message('Connect a wallet?', 'Connect a Solana wallet to play On-chain: SOL tables and SOL Agents. You can also do it later from your profile.', 'Connect Wallet', () => {
      void (async () => {
        if (!(await this.connectWallet())) return;
        this.onchain = true;
        this.paintMode();
        host.message("You're playing On-chain", 'Tables and Agents now use SOL. Switch back to Coins any time with the Demo / On-chain switch at the top.');
      })();
    }, 'Not now');
  }
}

function sessionNet(x: Record<string, any>): bigint {
  const buyIn = BigInt(String(x.buy_in));
  const end = x.cash_out == null ? BigInt(String(x.stack)) : BigInt(String(x.cash_out));
  return end - buyIn;
}

const signedSol = (v: bigint) => (v > 0n ? '+' : v < 0n ? '−' : '') + sol(v < 0n ? -v : v);
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
