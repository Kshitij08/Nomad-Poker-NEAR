/**
 * Nomad menu: Coins tournaments (Browse, My Tournaments, Host, Join by code) and the Leaderboard. Port of
 * Assets/Scripts/Net/NomadUi/NomadUiHost.Tournaments.cs onto the menu porter's NomadHost (registered as a partial from
 * the tournaments module's install()). Tournament data comes from ctx.services.tournaments (demo data unless live mode
 * is configured); a tournament whose table is ready goes to the table with the practice (demo) or live session.
 *
 * Deviations, each because the C# no longer matches the art (the 15 Oct prefabs put every panel under "Body", added
 * BG_Selected/BG_Normal pairs and moved tab art to a BG child):
 * - screen paths like "Panel_Available/Viewport/Content" also resolve under "Body/" (in Unity they come back null);
 * - the selected row / sub-tab / leaderboard tab also swaps BG_Selected ↔ BG_Normal (the C# toggles a "Glow" child
 *   and the tab's own Image sprite, neither of which exists any more).
 */
import type { AppContext } from '../../app/app';
import { LeaderboardKind } from '../../core/leaderboards/freePlayLeaderboardMath';
import type { UNode } from '../../hud/unityUi';
import type { NomadHost } from '../../menu/host';
import { NomadHost as Host } from '../../menu/host';
import { openDailySpin } from '../../menu/screens/mainMenu';
import { widgetsOf } from '../../menu/ui/tree';
import { isMine as isMineOf, isOpen, isRegistered, type MineResult, type TournamentInfo } from '../api/tournamentInfo';
import { N0, actionLabel, blindsText, payout, speedShort, startLabel, tag1, tag2, when } from '../format';
import type { TournamentsService } from '../service';

type MineTab = 'Joined' | 'Hosting' | 'Past';

/** The server rejects a start sooner than 10 minutes. 15 is the shortest option so a slow request still lands. */
const HOST_STARTS = [15, 30, 60, 180, 1440];
const HOST_FEES = [0, 100, 500, 1000, 5000];
const HOST_MAX = [8, 16, 24, 30];
const HOST_PRIZES = [0, 1000, 5000, 10000];
const HOST_SPEEDS = ['regular', 'turbo', 'slow'];

const BOARD_TABS: readonly [string, LeaderboardKind][] = [
  ['Frame/Tab_Weekly', LeaderboardKind.WeeklyEarnings], ['Frame/Tab_Monthly', LeaderboardKind.SeasonEarnings],
  ['Frame/Tab_Hands', LeaderboardKind.HandsWon], ['Frame/Tab_Friends', LeaderboardKind.FriendsWeekly],
];

interface LeaderboardRow { rank: number; displayName: string; score: number }
interface LeaderboardSnapshotLike { kind: LeaderboardKind; rows: readonly LeaderboardRow[]; hasMore: boolean; localRank: number }
interface LeaderboardsLike {
  fetch(kind: LeaderboardKind, page?: number): Promise<LeaderboardSnapshotLike>;
  localScore(kind: LeaderboardKind): number;
  scoreColumnFor(kind: LeaderboardKind): string;
}

export function nomadTournamentsPartial(host: NomadHost, ctx: AppContext): void {
  const svc = ctx.services.tournaments;
  if (!svc) return;
  new NomadTournaments(host, ctx, svc).bindAll();
}

class NomadTournaments {
  private browseRows: ReturnType<NomadHost['rowList']> | null = null;
  private mineRows: ReturnType<NomadHost['rowList']> | null = null;
  private browse: TournamentInfo[] = [];
  private browseSelected: TournamentInfo | null = null;
  private mineSelected: TournamentInfo | null = null;
  private codeFound: TournamentInfo | null = null;
  private mineTab: MineTab = 'Joined';
  private mine: MineResult | null = null;
  private browseListX: number | null = null;
  private mineListX: number | null = null;
  private hostStart = 0;
  private hostFee = 2;
  private hostMax = 1;
  private hostPrize = 0;
  private hostSpeed = 0;
  private hostPrivate = false;
  private hostPrizeConfirmed = false;
  private hostNameCleared = false;
  private boardKind = LeaderboardKind.WeeklyEarnings;
  private boardPage = 0;
  private board: LeaderboardSnapshotLike | null = null;

  constructor(private readonly host: NomadHost, private readonly ctx: AppContext, private readonly svc: TournamentsService) {}

  // ---- helpers ------------------------------------------------------------------------------------

  private screen(name: string): UNode | null {
    return this.host.screen(name);
  }

  /** NomadUiHost.Find, plus the "Body/" level the current art added (see the file comment). */
  private f(root: UNode | null, path: string): UNode | null {
    if (!root) return null;
    return this.host.find(root, path) ?? (path.includes('/') ? this.host.find(root, 'Body/' + path) : null);
  }

  private setActive(root: UNode | null, path: string, on: boolean): void {
    const n = this.f(root, path);
    if (n && n.activeSelf !== on) n.setActive(on);
  }

  private bind(root: UNode | null, path: string, action: () => void): void {
    const n = this.f(root, path);
    if (!n) {
      console.warn(`[NomadUi] ${root?.name ?? '?'}: no '${path}'`);
      return;
    }
    this.host.ensureButton(n).addListener(action);
  }

  /** The row / tab's selection: the C#'s Glow child, and the art's BG_Selected / BG_Normal pair. */
  private paintSelected(n: UNode | null, on: boolean): void {
    if (!n) return;
    this.setActive(n, 'Glow', on);
    const sel = n.children.find((c) => c.name === 'BG_Selected');
    const normal = n.children.find((c) => c.name === 'BG_Normal');
    if (sel && sel.activeSelf !== on) sel.setActive(on);
    if (normal && normal.activeSelf === on) normal.setActive(!on);
  }

  /** NomadUiHost.TintTab: a CanvasGroup at full alpha when selected, 0.6 otherwise. */
  private tintTab(root: UNode | null, path: string, selected: boolean): void {
    const t = this.f(root, path);
    if (!t) return;
    t.groupAlpha = selected ? 1 : 0.6;
    t.render();
    this.paintSelected(t, selected);
  }

  private get signedIn(): boolean {
    return this.host.signedIn;
  }

  private message(title: string, body: string, ok: string | null = 'OK', onOk?: () => void, cancel: string | null = null): void {
    this.host.message(title, body, ok, onOk, cancel);
  }

  private paintTags(t: UNode | null, x: TournamentInfo): void {
    if (!t) return;
    this.host.setText(t, 'Tag1/Label', tag1(x));
    this.host.setText(t, 'Tag2/Label', tag2(x));
  }

  private isMine(x: TournamentInfo): boolean {
    return isMineOf(x, this.svc.api.currentPlayerId);
  }

  /** Centres a list panel while it is empty (UI pass 20 Oct), back at its authored x once it has rows. */
  private centreWhenEmpty(panel: UNode | null, memo: number | null, empty: boolean): number | null {
    if (!panel) return memo;
    const x0 = memo ?? panel.anchoredPosition[0];
    const parentW = panel.parent?.w ?? 0;
    const centre = (0.5 - panel.anchorMin[0]) * parentW;
    const x = empty ? centre : x0;
    if (panel.anchoredPosition[0] !== x) {
      panel.anchoredPosition = [x, panel.anchoredPosition[1]];
      if (panel.parent?.activeInHierarchy) panel.layout();
    }
    return x0;
  }

  /** NomadUiHost.Run: an op returning an error or null; errors land in the message box. */
  private run(op: () => Promise<string | null>, onOk?: () => void): void {
    void this.host.run(op, onOk);
  }

  // ---- BindTournaments ------------------------------------------------------------------------------

  bindAll(): void {
    // The pool depends on entries (plus any host prize): the art's "Guaranteed prize" promises too much.
    for (const name of this.host.screenNames) {
      if (!name.startsWith('Tournaments_')) continue;
      for (const t of this.screen(name)!.walk()) if (t.text && t.text.text === 'Guaranteed prize') t.setText('Prize pool');
    }

    const browse = this.screen('Tournaments_Browse');
    if (browse) {
      this.browseRows = this.host.rowList(this.f(browse, 'Panel_Available/Viewport/Content'), 'Row_');
      this.bind(browse, 'Panel_Selected/Btn_Register', () => this.registerOrJoin(this.browseSelected));
    }
    const mine = this.screen('Tournaments_MyTournaments');
    if (mine) {
      this.mineRows = this.host.rowList(this.f(mine, 'Panel_List/Viewport/Content'), 'Card_');
      for (const tab of ['Joined', 'Hosting', 'Past'] as MineTab[])
        this.bind(mine, `Panel_List/SubTab_${tab}`, () => { this.mineTab = tab; this.paintMine(); });
      this.bind(mine, 'Panel_Details/Btn_Leave', () => this.leaveOrCancel());
    }
    const hostScreen = this.screen('Tournaments_Host');
    if (hostScreen) {
      const cycle = (path: string, step: () => void) => this.bind(hostScreen, `Panel_Form/${path}/Field`, () => { step(); this.paintHostForm(); });
      cycle('Row_DateTime', () => (this.hostStart = (this.hostStart + 1) % HOST_STARTS.length));
      cycle('Row_EntryFee', () => (this.hostFee = (this.hostFee + 1) % HOST_FEES.length));
      cycle('Row_MaxPlayers', () => (this.hostMax = (this.hostMax + 1) % HOST_MAX.length));
      cycle('Row_PrizePool', () => (this.hostPrize = (this.hostPrize + 1) % HOST_PRIZES.length));
      cycle('Row_BlindPattern', () => (this.hostSpeed = (this.hostSpeed + 1) % HOST_SPEEDS.length));
      cycle('Row_Visibility', () => (this.hostPrivate = !this.hostPrivate));
      const nameField = this.input(hostScreen, 'Panel_Form/Row_TournamentName/Field');
      if (nameField) {
        nameField.placeholder = 'Tournament name';
        nameField.input.maxLength = 40;
        nameField.onValueChanged.push(() => this.paintHostForm());
      }
      this.bind(hostScreen, 'Panel_Summary/Btn_Create', () => this.createTournament());
    }
    const code = this.screen('Tournaments_JoinByCode');
    if (code) {
      const field = this.input(code, 'Panel_Join/CodeField');
      if (field) {
        field.placeholder = 'Enter tournament code';
        field.input.maxLength = 12;
        field.onSubmit.push(() => this.findByCode());
      }
      this.bind(code, 'Panel_Join/Btn_Find', () => this.findByCode());
      this.bind(code, 'Panel_Join/DetailsCard/Btn_Join', () => this.registerOrJoin(this.codeFound));
    }

    this.bindLeaderboard();
    this.alignTournamentChrome();

    // NomadUiHost.OnScreenShown.
    this.host.onScreenShown('Tournaments_Browse', () => void this.refreshBrowse());
    this.host.onScreenShown('Tournaments_MyTournaments', () => void this.refreshMine());
    this.host.onScreenShown('Tournaments_JoinByCode', () => this.resetJoinByCode());
    this.host.onScreenShown('Tournaments_Host', () => this.paintHostForm());
    this.host.onScreenShown('Leaderboard', () => void this.refreshLeaderboard());
    // "Starts in …" keeps counting while a screen is up (RefreshAll repaints the showing screen once a second).
    this.host.onRefresh(() => {
      if (this.host.isShowing('Tournaments_Browse')) this.paintBrowse();
      if (this.host.isShowing('Tournaments_MyTournaments')) this.paintMine();
    });
  }

  private input(root: UNode, path: string) {
    const n = this.f(root, path);
    return n ? widgetsOf(n).input ?? null : null;
  }

  // ---- Browse ---------------------------------------------------------------------------------------

  private async refreshBrowse(): Promise<void> {
    // Until the list arrives (or if it can't), no rows: the art's sample tournament had a REGISTER that did nothing.
    const root = this.screen('Tournaments_Browse');
    const avail = this.f(root, 'Panel_Available');
    if (this.browse.length === 0) {
      this.browseSelected = null;
      this.paintBrowse();
      this.host.setText(avail, 'Count', 'Loading…');
      this.host.emptyNote(avail, 'Loading tournaments…', true);
    }
    const reply = await this.svc.list();
    if (reply.error !== null) {
      this.host.setText(avail, 'Count', "Couldn't load");
      this.host.emptyNote(avail, "Couldn't load tournaments: " + reply.error + '\nOpen this screen again to retry.', true);
      return;
    }
    this.browse = reply.value?.tournaments ?? [];
    if (this.browseSelected) this.browseSelected = this.browse.find((x) => x.id === this.browseSelected!.id) ?? null;
    if (!this.browseSelected && this.browse.length > 0) this.browseSelected = this.browse[0]!;
    this.paintBrowse();
  }

  private paintBrowse(): void {
    const root = this.screen('Tournaments_Browse');
    if (!root || !this.browseRows) return;
    const avail = this.f(root, 'Panel_Available');
    this.host.setText(avail, 'Count', this.browse.length === 0 ? '' : `${this.browse.length} available`);
    this.host.emptyNote(avail, 'No tournaments are open right now.\nHost one, or join a private one by code.', this.browse.length === 0);
    // With nothing to list there's no details panel beside it: the list stands in the middle (UI pass 20 Oct).
    this.browseListX = this.centreWhenEmpty(avail, this.browseListX, this.browse.length === 0);
    this.browseRows.fill(this.browse.length, (row, i) => {
      const x = this.browse[i]!;
      this.host.setText(row, 'Name', x.name);
      this.paintTags(row, x);
      this.host.setText(row, 'Players', `${x.players}/${x.maxPlayers} players`);
      this.host.setText(row, 'Date', when(x));
      this.host.setText(row, 'Starts', Host.until(x.startsAtUnix));
      this.paintSelected(row, !!this.browseSelected && x.id === this.browseSelected.id);
      const b = this.host.ensureButton(row);
      b.reset();
      b.addListener(() => {
        this.browseSelected = x;
        this.paintBrowse();
      });
    });
    const sel = this.browseSelected;
    this.setActive(root, 'Panel_Selected', sel !== null);
    if (!sel) return;
    const panel = this.f(root, 'Panel_Selected');
    this.host.setText(panel, 'Name', sel.name);
    this.paintTags(panel, sel);
    this.host.setText(panel, 'Prize', `${N0(sel.prizePool)} Coins`);
    this.host.setText(panel, 'Payout', payout(sel));
    this.host.setText(root, 'Value_Entry', sel.entryFee === 0 ? 'Free' : `${N0(sel.entryFee)} Coins`);
    this.host.setText(root, 'Value_Players', `${sel.players}/${sel.maxPlayers}`);
    this.host.setText(root, 'Value_Schedule', when(sel));
    this.host.setText(root, 'Value_Starts', Host.until(sel.startsAtUnix));
    this.host.setText(root, 'Value_Blinds', blindsText(sel.speed));
    this.host.setText(panel, 'Btn_Register/Label', actionLabel(sel));
  }

  /** Register (entry fee from Coins), or join the table once the tournament's server is ready. */
  private registerOrJoin(x: TournamentInfo | null): void {
    if (!x) return;
    if (!this.signedIn) {
      this.host.show('Login');
      return;
    }
    if (isRegistered(x)) {
      if (!x.serverReady) {
        this.message(x.name, `You're registered. ${Host.until(x.startsAtUnix)}; come back then.`);
        return;
      }
      this.run(() => this.svc.join(x));
      return;
    }
    if (!isOpen(x)) {
      this.message(x.name, 'Registration is closed.');
      return;
    }
    const fee = x.entryFee === 0 ? "It's free to enter." : `Entry fee: ${N0(x.entryFee)} Coins.`;
    this.message(x.name, `${fee} Register?`, 'Register', () => this.run(async () => {
      const r = await this.svc.register(x.id);
      return r.error;
    }, () => {
      void this.refreshBrowse();
      void this.refreshMine();
      this.message('Registered', `You're in ${x.name}. ${Host.until(x.startsAtUnix)}.`);
    }), 'Cancel');
  }

  // ---- My tournaments -------------------------------------------------------------------------------

  private async refreshMine(): Promise<void> {
    const reply = await this.svc.mine();
    if (reply.error !== null) {
      this.message('My tournaments', reply.error);
      return;
    }
    this.mine = reply.value;
    this.paintMine();
  }

  private mineList(): TournamentInfo[] {
    const list: TournamentInfo[] = [];
    if (!this.mine) return list;
    const past = (x: TournamentInfo) => x.status === 'finished' || x.status === 'cancelled' || x.status === 'paid';
    if (this.mineTab === 'Hosting') for (const x of this.mine.hosted ?? []) { if (!past(x)) list.push(x); }
    else if (this.mineTab === 'Joined') for (const x of this.mine.entries ?? []) { if (!past(x)) list.push(x); }
    else {
      for (const x of this.mine.entries ?? []) if (past(x)) list.push(x);
      for (const x of this.mine.hosted ?? []) if (past(x) && !list.some((y) => y.id === x.id)) list.push(x);
    }
    return list;
  }

  private paintMine(): void {
    const root = this.screen('Tournaments_MyTournaments');
    if (!root || !this.mineRows) return;
    this.tintTab(root, 'Panel_List/SubTab_Joined', this.mineTab === 'Joined');
    this.tintTab(root, 'Panel_List/SubTab_Hosting', this.mineTab === 'Hosting');
    this.tintTab(root, 'Panel_List/SubTab_Past', this.mineTab === 'Past');
    const list = this.mineList();
    if (this.mineSelected) this.mineSelected = list.find((x) => x.id === this.mineSelected!.id) ?? null;
    if (!this.mineSelected && list.length > 0) this.mineSelected = list[0]!;
    const panel = this.f(root, 'Panel_List');
    this.host.setText(panel, 'Count', list.length === 0 ? '' : list.length === 1 ? '1 tournament' : `${list.length} tournaments`);
    // As Browse: an empty list stands in the middle instead of on the left beside an empty half.
    this.mineListX = this.centreWhenEmpty(panel, this.mineListX, list.length === 0);
    this.host.emptyNote(panel, 'Nothing here yet.\nTournaments you join or host show up here.', list.length === 0);
    this.mineRows.fill(list.length, (row, i) => {
      const x = list[i]!;
      this.host.setText(row, 'Name', x.name);
      this.paintTags(row, x);
      this.host.setText(row, 'Players', `${x.players}/${x.maxPlayers}`);
      this.host.setFill(row, 'Progress/Fill', x.maxPlayers > 0 ? x.players / x.maxPlayers : 0);
      const at = new Date(x.startsAtUnix * 1000);
      const pad = (n: number) => String(n).padStart(2, '0');
      this.host.setText(row, 'Date', `${at.toLocaleDateString('en-GB', { weekday: 'short' })} ${pad(at.getDate())} ${at.toLocaleDateString('en-GB', { month: 'short' })}`);
      this.host.setText(row, 'Time', `${pad(at.getHours())}:${pad(at.getMinutes())}`);
      this.host.setText(row, 'Starts', x.status === 'running' ? 'Playing now' : Host.until(x.startsAtUnix));
      this.host.setText(row, 'Registered/Label', this.isMine(x) ? 'Hosting' : x.myPlace > 0 ? `Finished #${x.myPlace}` : 'Registered');
      this.paintSelected(row, !!this.mineSelected && x.id === this.mineSelected.id);
      const b = this.host.ensureButton(row);
      b.reset();
      b.addListener(() => {
        this.mineSelected = x;
        this.paintMine();
      });
    });
    const sel = this.mineSelected;
    this.setActive(root, 'Panel_Details', sel !== null);
    if (!sel) return;
    const d = this.f(root, 'Panel_Details');
    this.host.setText(d, 'Name', sel.name);
    this.host.setText(d, 'Prize', `${N0(sel.prizePool)} Coins`);
    this.host.setText(d, 'Payout', payout(sel));
    this.host.setText(d, 'Value_Date', when(sel));
    this.host.setText(d, 'Value_Players', `${sel.players}/${sel.maxPlayers}`);
    this.host.setText(d, 'Value_Entry', sel.entryFee === 0 ? 'Free' : `${N0(sel.entryFee)} Coins`);
    this.host.setText(d, 'Value_Starts', Host.until(sel.startsAtUnix));
    this.host.setText(d, 'Value_Blinds', blindsText(sel.speed));
    this.host.setText(d, 'Value_Type', sel.visibility === 'private' ? `Private · code ${sel.joinCode}` : 'Public');
    this.host.setText(d, 'Value_Speed', speedShort(sel.speed));
    this.host.setActive(d, 'Btn_Leave', this.mineTab !== 'Past');
    this.host.setText(d, 'Btn_Leave/Label', this.isMine(sel) ? 'CANCEL TOURNAMENT' : sel.serverReady ? 'JOIN TABLE' : 'LEAVE TOURNAMENT');
  }

  private leaveOrCancel(): void {
    const x = this.mineSelected;
    if (!x) return;
    if (!this.isMine(x) && x.serverReady) {
      this.registerOrJoin(x);
      return;
    }
    if (this.isMine(x))
      this.message(x.name, 'Cancel this tournament? Everyone who registered gets their entry fee back.', 'Cancel it',
        () => this.run(async () => (await this.svc.cancel(x.id)).error, () => void this.refreshMine()), 'Keep it');
    else
      this.message(x.name, 'Leave this tournament? Your entry fee comes back.', 'Leave',
        () => this.run(async () => (await this.svc.unregister(x.id)).error, () => void this.refreshMine()), 'Stay');
  }

  // ---- Host -----------------------------------------------------------------------------------------

  private hostName(): string {
    const field = this.input(this.screen('Tournaments_Host')!, 'Panel_Form/Row_TournamentName/Field');
    return (field?.text ?? '').replace(/​/g, '').trim();
  }

  private paintHostForm(): void {
    const root = this.screen('Tournaments_Host');
    if (!root) return;
    const f = this.f(root, 'Panel_Form');
    // The art fills the name with its sample ("Coffee Break Turbo"): start empty, with a hint.
    const nameField = this.input(root, 'Panel_Form/Row_TournamentName/Field');
    if (nameField && !this.hostNameCleared) {
      this.hostNameCleared = true;
      nameField.text = '';
      nameField.placeholder = 'Name your tournament';
    }
    // The pool depends on entries (plus the host's prize): not "guaranteed".
    const fee = HOST_FEES[this.hostFee]!;
    const prize = HOST_PRIZES[this.hostPrize]!;
    const max = HOST_MAX[this.hostMax]!;
    const speed = HOST_SPEEDS[this.hostSpeed]!;
    this.host.setText(f, 'Row_DateTime/Field/Value', startLabel(HOST_STARTS[this.hostStart]!));
    this.host.setText(f, 'Row_EntryFee/Field/Value', fee === 0 ? 'Free' : `${N0(fee)} Coins`);
    this.host.setText(f, 'Row_MaxPlayers/Field/Value', `${max} players`);
    this.host.setText(f, 'Row_PrizePool/Field/Value', prize === 0 ? 'From entry fees' : `+${N0(prize)} Coins from you`);
    this.host.setText(f, 'Row_BlindPattern/Field/Value', speedShort(speed));
    this.host.setText(f, 'Row_BlindPattern/Hint', blindsText(speed));
    this.host.setText(f, 'Row_Visibility/Field/Value', this.hostPrivate ? 'Private (code only)' : 'Public');
    const s = this.f(root, 'Panel_Summary');
    const name = this.hostName();
    this.host.setText(s, 'Name', name.length === 0 ? 'Your tournament' : name);
    this.host.setText(s, 'Value_0', startLabel(HOST_STARTS[this.hostStart]!));
    // "(if full)" overflowed the value, and a hint saying it sat under Blind Pattern: the label says it.
    this.host.setText(s, 'Label_1', 'Prize if full');
    this.host.setText(s, 'Value_1', `${N0(prize + fee * max)} Coins`);
    this.host.setText(s, 'Value_2', fee === 0 ? 'Free' : `${N0(fee)} Coins`);
    this.host.setText(s, 'Value_3', String(max));
    this.host.setText(s, 'Value_4', this.hostPrivate ? 'Private' : 'Public');
    this.host.setText(s, 'Value_5', speedShort(speed));
    this.host.setText(s, 'BlindHint', prize > 0 ? `Your ${N0(prize)} Coins prize is taken from your balance.` : '');
  }

  private createTournament(): void {
    if (!this.signedIn) {
      this.host.show('Login');
      return;
    }
    const name = this.hostName();
    if (name.length === 0) return this.message('Host a tournament', 'Give your tournament a name.');
    if (name.length > 40) return this.message('Host a tournament', 'Keep the name to 40 characters.');
    const prize = HOST_PRIZES[this.hostPrize]!;
    const coins = this.ctx.services.wallet?.coins ?? 10_000;
    if (prize > coins) return this.message('Not enough Coins', `Your prize of ${N0(prize)} Coins is more than you have.`);
    // The host's prize leaves their Coins now: ask first.
    if (prize > 0 && !this.hostPrizeConfirmed) {
      this.message('Host a tournament', `Creating ${name} takes your ${N0(prize)} Coins prize from your balance now. It goes to the winners.`, 'Create', () => {
        this.hostPrizeConfirmed = true;
        this.createTournament();
        this.hostPrizeConfirmed = false;
      }, 'Cancel');
      return;
    }
    const startMinutes = HOST_STARTS[this.hostStart]!;
    const req = {
      name, hostPrize: prize, entryFee: HOST_FEES[this.hostFee]!, maxPlayers: HOST_MAX[this.hostMax]!, speed: HOST_SPEEDS[this.hostSpeed]!,
      visibility: this.hostPrivate ? 'private' : 'public', startsAtUnix: this.svc.api.serverNowUnix + startMinutes * 60,
    };
    let made: TournamentInfo | null = null;
    this.run(async () => {
      const r = await this.svc.create(req);
      made = r.value;
      return r.error;
    }, () => {
      const m = made as TournamentInfo | null;
      const isPrivate = !!m && m.visibility === 'private' && !!m.joinCode;
      if (isPrivate) void navigator.clipboard?.writeText(m!.joinCode).catch(() => {});
      const code = isPrivate ? ` Its code is ${m!.joinCode}; share it with your players.` : '';
      this.message('Tournament created', `${name} ${startLabel(startMinutes).toLowerCase()}.${code}`);
      this.mineTab = 'Hosting';
      this.host.show('Tournaments_MyTournaments');
      void this.refreshMine();
    });
  }

  // ---- Join by code ---------------------------------------------------------------------------------

  private resetJoinByCode(): void {
    this.codeFound = null;
    const root = this.screen('Tournaments_JoinByCode');
    this.setActive(root, 'Panel_Join/DetailsCard', false);
    this.showJoinDetailsHeading(root, false);
  }

  /** "Tournament details · Review the information below" sat over an empty card before any search: it shows with the details only. */
  private showJoinDetailsHeading(root: UNode | null, show: boolean): void {
    if (!root) return;
    for (const t of root.walk()) {
      const s = t.text?.text ?? '';
      if (!t.text) continue;
      if (s.toUpperCase().startsWith('TOURNAMENT DETAILS') || s.toLowerCase().startsWith('review the tournament')) t.setActive(show);
    }
  }

  private findByCode(): void {
    const root = this.screen('Tournaments_JoinByCode');
    if (!root) return;
    const code = (this.input(root, 'Panel_Join/CodeField')?.text ?? '').replace(/​/g, '').trim().toUpperCase();
    if (code.length === 0) return this.message('Join by code', 'Enter the code the host shared.');
    this.run(async () => {
      const r = await this.svc.byCode(code);
      if (r.error !== null) return r.code === 'not_found' || !r.error ? 'No tournament has that code.' : r.error;
      this.codeFound = r.value;
      return null;
    }, () => {
      const x = this.codeFound;
      const card = this.f(root, 'Panel_Join/DetailsCard');
      this.setActive(root, 'Panel_Join/DetailsCard', x !== null);
      if (!x || !card) return;
      this.showJoinDetailsHeading(root, true);
      this.host.setText(card, 'Name', x.name);
      this.paintTags(card, x);
      this.host.setText(card, 'Prize', `${N0(x.prizePool)} Coins`);
      this.host.setText(card, 'Payout', payout(x));
      this.host.setText(card, 'Value_0', when(x));
      this.host.setText(card, 'Value_1', `${x.players}/${x.maxPlayers}`);
      this.host.setText(card, 'Value_2', x.entryFee === 0 ? 'Free' : `${N0(x.entryFee)} Coins`);
      this.host.setText(card, 'Value_3', Host.until(x.startsAtUnix));
      this.host.setText(card, 'Value_4', blindsText(x.speed));
      this.host.setText(card, 'Value_5', x.visibility === 'private' ? 'Private' : 'Public');
      this.host.setText(card, 'Btn_Join/Label', actionLabel(x) === 'REGISTER' ? 'JOIN TOURNAMENT' : actionLabel(x));
      this.host.afterLayout(root);
    });
  }

  // ---- Leaderboard ----------------------------------------------------------------------------------

  private get leaderboards(): LeaderboardsLike | null {
    return ((this.ctx.services as { leaderboards?: LeaderboardsLike }).leaderboards) ?? null;
  }

  private bindLeaderboard(): void {
    const root = this.screen('Leaderboard');
    if (!root) return;
    for (const [tab, kind] of BOARD_TABS)
      this.bind(root, tab, () => { this.boardKind = kind; this.boardPage = 0; void this.refreshLeaderboard(); });
    this.bind(root, 'Frame/Btn_Prev', () => { if (this.boardPage > 0) { this.boardPage--; void this.refreshLeaderboard(); } });
    this.bind(root, 'Frame/Btn_Next', () => { if (this.board?.hasMore) { this.boardPage++; void this.refreshLeaderboard(); } });
    this.bind(root, 'Frame/Coins/Btn_AddCoins', () => openDailySpin(this.host));
  }

  private async refreshLeaderboard(): Promise<void> {
    this.paintLeaderboard();
    const lb = this.leaderboards;
    if (!lb) return;
    try {
      this.board = await lb.fetch(this.boardKind, this.boardPage);
    } catch (e) {
      console.warn('[NomadUi] leaderboard: ' + (e as Error).message);
      return;
    }
    this.paintLeaderboard();
  }

  private paintLeaderboard(): void {
    const root = this.screen('Leaderboard');
    if (!root) return;
    const lb = this.leaderboards;
    for (const [tab, kind] of BOARD_TABS) this.paintSelected(this.host.find(root, tab), kind === this.boardKind);
    this.host.setText(root, 'Frame/Table/H_Coins', lb?.scoreColumnFor(this.boardKind) ?? 'Coins');
    this.host.setText(root, 'Frame/Page', `Page ${this.boardPage + 1}`);
    this.host.setText(root, 'Frame/ResetInfo', this.boardKind === LeaderboardKind.SeasonEarnings ? 'Season standings' : 'Resets every Monday (UTC)');
    const rows = this.board && this.board.kind === this.boardKind ? this.board.rows : null;
    for (let i = 1; i <= 10; i++) {
      const row = this.host.find(root, `Frame/Table/Viewport/Content/Row_${i}`);
      if (!row) continue;
      const on = !!rows && i - 1 < rows.length;
      if (row.activeSelf !== on) row.setActive(on);
      if (!on) continue;
      const e = rows![i - 1]!;
      this.host.setText(row, 'Rank', String(e.rank));
      this.host.setText(row, 'Name', Host.short(e.displayName, 20));
      this.host.setText(row, 'Coins', N0(e.score));
      this.host.setActive(row, 'Crown', e.rank <= 3);
      this.host.setAvatar(row, 'Avatar/Art', e.displayName);
    }
    const you = this.host.find(root, 'Frame/Row_You');
    if (you) {
      const rank = this.board?.localRank ?? 0;
      const me = this.ctx.services.account?.displayName ?? 'You';
      this.host.setText(you, 'Rank', rank > 0 ? String(rank) : '–');
      this.host.setText(you, 'Name', Host.short(me, 9)); // ends before the "You" tag
      this.host.setText(you, 'Coins', N0(lb?.localScore(this.boardKind) ?? 0));
      this.host.setAvatar(you, 'Avatar/Art', me);
    }
    const prev = this.host.find(root, 'Frame/Btn_Prev');
    if (prev) widgetsOf(prev).button?.setInteractable(this.boardPage > 0);
    const next = this.host.find(root, 'Frame/Btn_Next');
    if (next) widgetsOf(next).button?.setInteractable(!!this.board?.hasMore);
  }

  /**
   * The four Tournaments screens were drawn separately, each with its tabs, title and Back at slightly different
   * places, so the bar jumped when switching tabs. All take Browse's.
   */
  private alignTournamentChrome(): void {
    const browse = this.screen('Tournaments_Browse');
    if (!browse) return;
    const parts = ['TopBar/Btn_Back', 'TopBar/Title', 'TopBar/Mode', 'TopBar/CoinIcon', 'TopBar/Coins', 'TopBar/HeaderLine',
      'Tabs/Tab_Browse', 'Tabs/Tab_MyTournaments', 'Tabs/Tab_Host', 'Tabs/Tab_JoinByCode'];
    for (const other of ['Tournaments_MyTournaments', 'Tournaments_Host', 'Tournaments_JoinByCode']) {
      const root = this.screen(other);
      if (!root) continue;
      for (const path of parts) {
        const from = this.host.find(browse, path);
        const to = this.host.find(root, path);
        if (!from || !to) continue;
        to.anchorMin = [...from.anchorMin];
        to.anchorMax = [...from.anchorMax];
        to.pivot = [...from.pivot];
        to.anchoredPosition = [...from.anchoredPosition];
        to.sizeDelta = [...from.sizeDelta];
      }
    }
  }
}
