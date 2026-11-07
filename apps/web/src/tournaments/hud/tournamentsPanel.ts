import type { AppContext, Screen } from '../../app/app';
import { defaultCreateRequest, isMine, isOpen, isRegistered, isLive, isDemo, type Reply, type TournamentInfo } from '../api/tournamentInfo';
import { N0, clock, details, speedLong } from '../format';
import type { TournamentsService } from '../service';
import { Colors, anchored, button, el, group, inputRow, label, overlayCanvas, verticalScroll, type ButtonColor } from '../ui/retentionDom';

type Tab = 'Open' | 'Mine' | 'Host' | 'Code' | 'Practice';

const PANEL_REFRESH_SECONDS = 10;
const DEMO_NOTE = 'DEMO — sample tournaments, nothing is real. Live tournaments are off in this build.';

/**
 * The Tournaments panel: browse open tournaments, see yours, host one, or find one by code — and the "your
 * tournament is ready" banner with the Join button. Port of Tournaments/TournamentsHud.cs (runtime-built RetentionUi,
 * no prefab), registered as the overlay screen 'tournaments'. One addition: a Practice tab that starts the offline
 * practice tournament (Unity: Tools > Poker > Tournament > Practice: 5 / 8 / 16 players, Editor only).
 */
export class TournamentsPanelScreen implements Screen {
  readonly overlay = true;
  private canvas: { root: HTMLElement; dispose: () => void } | null = null;
  private status!: ReturnType<typeof label>;
  private readonly tabButtons = new Map<Tab, ReturnType<typeof button>>();
  private listScroll!: HTMLElement;
  private listRoot!: HTMLElement;
  private hostForm!: HTMLElement;
  private codeRow!: HTMLElement;
  private practiceRow!: HTMLElement;
  private codeInput!: HTMLInputElement;
  private nameInput!: HTMLInputElement;
  private prizeInput!: HTMLInputElement;
  private feeInput!: HTMLInputElement;
  private startInput!: HTMLInputElement;
  private maxInput!: HTMLInputElement;
  private speedButton!: ReturnType<typeof button>;
  private visibilityButton!: ReturnType<typeof button>;
  private banner!: HTMLElement;
  private bannerText!: ReturnType<typeof label>;
  private speed = 'regular';
  private isPrivate = false;
  private tab: Tab = 'Open';
  private rows: { info: TournamentInfo; details: ReturnType<typeof label> }[] = [];
  private busy = false;
  private nextPanelRefresh = 0;
  private timer = 0;
  private readonly svc: TournamentsService;

  constructor(private readonly ctx: AppContext) {
    const svc = ctx.services.tournaments;
    if (!svc) throw new Error("[tournaments] service not installed");
    this.svc = svc;
  }

  mount(root: HTMLElement): void {
    this.canvas = overlayCanvas(root, 515);
    this.build(this.canvas.root);
    if (!this.svc.api.signedIn) this.setStatus('Sign in to host or join tournaments. You can still browse.');
    this.showTab(this.tab);
    this.timer = window.setInterval(() => this.tick(), 1000);
  }

  unmount(): void {
    window.clearInterval(this.timer);
    this.canvas?.dispose();
    this.canvas = null;
  }

  private close(): void {
    this.ctx.router.back();
  }

  private tick(): void {
    if (!this.busy && performance.now() >= this.nextPanelRefresh && (this.tab === 'Open' || this.tab === 'Mine')) void this.loadTab();
    for (const row of this.rows) row.details.setText(details(row.info, this.svc.api.serverNowUnix, isMine(row.info, this.svc.api.currentPlayerId)));
    this.refreshBanner();
  }

  // ---- Banner --------------------------------------------------------------------------------

  private refreshBanner(): void {
    const ready = this.svc.ready;
    const show = !!ready && ready.id !== this.svc.bannerDismissedId && !this.svc.isJoining;
    this.banner.classList.toggle('trn-hidden', !show);
    if (!show || !ready) return;
    const left = ready.startsAtUnix - this.svc.api.serverNowUnix;
    this.bannerText.setText(left > 0
      ? `<b>${ready.name}</b> starts in ${clock(left)} — your table is ready.`
      : `<b>${ready.name}</b> has started — you're being blinded off. Join now!`);
  }

  // ---- Tabs ------------------------------------------------------------------------------------

  private showTab(tab: Tab): void {
    this.tab = tab;
    for (const [t, b] of this.tabButtons) b.setColor(t === tab ? Colors.TourGold : Colors.Grey);
    this.listScroll.classList.toggle('trn-hidden', !(tab === 'Open' || tab === 'Mine' || tab === 'Code'));
    this.hostForm.classList.toggle('trn-hidden', tab !== 'Host');
    this.codeRow.classList.toggle('trn-hidden', tab !== 'Code');
    this.practiceRow.classList.toggle('trn-hidden', tab !== 'Practice');
    this.clearRows();
    this.setStatus(tab === 'Practice'
      ? 'Practice: you host and play, bots fill the other seats. One-minute blind levels. No backend needed.'
      : this.svc.api.demoMode ? DEMO_NOTE : '');
    if (tab === 'Open' || tab === 'Mine') void this.loadTab();
  }

  private async loadTab(): Promise<void> {
    this.nextPanelRefresh = performance.now() + PANEL_REFRESH_SECONDS * 1000;
    const tab = this.tab;
    if (tab === 'Open') {
      const r = await this.svc.list('upcoming');
      if (this.tab !== tab) return;
      if (r.error !== null) return this.setStatus(r.error);
      this.showRows(r.value!.tournaments, 'No open tournaments right now. Host one!');
    } else if (tab === 'Mine') {
      const r = await this.svc.mine();
      if (this.tab !== tab) return;
      if (r.error !== null) return this.setStatus(r.error);
      const all: TournamentInfo[] = [];
      const seen = new Set<string>();
      for (const t of r.value!.hosted ?? []) if (!seen.has(t.id)) { seen.add(t.id); all.push(t); }
      for (const t of r.value!.entries ?? []) if (!seen.has(t.id)) { seen.add(t.id); all.push(t); }
      this.showRows(all, "You haven't joined or hosted a tournament yet.");
    }
  }

  private showRows(list: TournamentInfo[], emptyText: string): void {
    this.clearRows();
    if (!list || list.length === 0) {
      label(this.listRoot, emptyText, 18, Colors.Muted, { height: 60 });
      return;
    }
    for (const t of list) this.addRow(t);
  }

  private clearRows(): void {
    this.rows = [];
    this.listRoot?.replaceChildren();
  }

  private addRow(t: TournamentInfo): void {
    const row = group(this.listRoot, 'column', 4, [16, 16, 10, 10]);
    row.style.background = Colors.Reel;
    row.style.flex = '0 0 auto';
    const host = t.hostName ? `  <color=#9aa3b5><size=80%>by ${t.hostName}</size></color>` : '';
    label(row, `<b>${t.name}</b>${host}`, 21, Colors.White, { align: 'left', height: 30 });
    const mine = isMine(t, this.svc.api.currentPlayerId);
    const det = label(row, details(t, this.svc.api.serverNowUnix, mine), 16, Colors.Muted, { align: 'left', height: 46 });

    const actions = group(row, 'row', 10, [0, 0, 0, 0], 'start');
    actions.style.height = '44px';
    actions.style.flex = '0 0 auto';
    const add = (caption: string, color: ButtonColor, onClick: () => void, width = 150) => button(actions, caption, color, 42, width, onClick);

    if (isRegistered(t) && t.serverReady) add('Join', Colors.TourGold, () => void this.run(() => this.svc.join(t)));
    else if (mine && t.serverReady && isLive(t)) add('Watch', Colors.TourGold, () => void this.run(() => this.svc.join(t))); // the host watches
    if (t.status === 'registering' && !isRegistered(t) && this.svc.api.signedIn && t.myStatus !== 'removed')
      add(t.entryFee > 0 ? `Register · ${N0(t.entryFee)}` : 'Register', Colors.Green, () => void this.run(async () => report(await this.svc.register(t.id), "You're in!")), 200);
    if (t.myStatus === 'registered' && t.status === 'registering')
      add('Leave', Colors.Grey, () => void this.run(async () => report(await this.svc.unregister(t.id), t.entryFee > 0 ? 'You left. Your entry fee is on its way back.' : 'You left.')));
    if (mine && isOpen(t))
      add('Cancel', Colors.Danger, () => void this.run(async () => report(await this.svc.cancel(t.id), 'Cancelled. Everyone gets their chips back.')));

    this.rows.push({ info: t, details: det });
  }

  private async run(action: () => Promise<string | null>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.setStatus('Working…');
    try {
      const message = await action();
      if (message !== null) this.setStatus(message);
      else if (this.tab === 'Open' || this.tab === 'Mine') this.setStatus(this.svc.api.demoMode ? DEMO_NOTE : '');
      if (this.tab === 'Open' || this.tab === 'Mine') await this.loadTab();
      void this.svc.pollMine();
    } catch (ex) {
      console.warn('[Tournaments]', ex);
      this.setStatus('Something went wrong. Try again.');
    } finally {
      this.busy = false;
    }
  }

  // ---- Host --------------------------------------------------------------------------------

  private async createAsync(): Promise<string | null> {
    if (!this.svc.api.signedIn) return 'Sign in to host a tournament.';
    const name = this.nameInput.value.trim();
    if (name.length === 0) return 'Give your tournament a name.';
    const int = (s: string) => (/^-?\d+$/.test(s.trim()) ? Number.parseInt(s.trim(), 10) : Number.NaN);
    const prize = int(this.prizeInput.value);
    if (!(prize >= 0)) return 'The prize must be a whole number of chips.';
    const fee = int(this.feeInput.value);
    if (!(fee >= 0)) return 'The entry fee must be a whole number of chips (0 for free).';
    const minutes = int(this.startInput.value);
    if (!(minutes >= 10)) return 'Start time: minutes from now, at least 10.';
    const max = int(this.maxInput.value);
    if (!(max >= 2 && max <= 30)) return 'Max players must be 2 to 30.';

    const reply = await this.svc.create({
      ...defaultCreateRequest(), name, hostPrize: prize, entryFee: fee, maxPlayers: max, speed: this.speed,
      visibility: this.isPrivate ? 'private' : 'public', startsAtUnix: this.svc.api.serverNowUnix + minutes * 60 + 60,
    });
    if (reply.error !== null) return reply.error;
    const t = reply.value!;
    this.showTab('Mine');
    return t.visibility === 'private' ? `Created! Share the code ${t.joinCode} with your players.` : "Created! It's on the open list.";
  }

  private async findByCodeAsync(): Promise<string | null> {
    const code = this.codeInput.value.trim().toUpperCase();
    if (code.length === 0) return 'Type the 6-letter code.';
    // Testing: a tournament server's own session name joins it directly.
    if (this.svc.isTournamentSession(code)) return this.svc.joinSession(code);
    const reply = await this.svc.byCode(code);
    if (reply.error !== null) return reply.error;
    this.clearRows();
    this.addRow(reply.value!);
    return null;
  }

  private refreshToggles(): void {
    this.speedButton.setCaption(`Blinds: ${speedLong(this.speed)}`);
    this.visibilityButton.setCaption(this.isPrivate ? 'Private · code only' : 'Public · on the list');
  }

  private setStatus(message: string | null): void {
    this.status?.setText(message ?? '');
  }

  // ---- Build ---------------------------------------------------------------------------------

  private build(root: HTMLElement): void {
    const panel = el('div', 'trn-panel', root);
    panel.style.position = 'absolute';
    panel.style.inset = '0';

    const dim = el('div', '', panel);
    dim.style.position = 'absolute';
    dim.style.inset = '0';
    dim.style.background = Colors.Overlay;
    dim.addEventListener('click', () => this.close());

    const sheet = group(panel, 'column', 12, [28, 28, 22, 22]);
    sheet.style.position = 'absolute';
    sheet.style.background = Colors.Panel;
    sheet.style.width = '980px';
    sheet.style.left = 'calc(50% - 490px)';
    sheet.style.top = '32px';
    sheet.style.bottom = '32px';

    const header = group(sheet, 'row', 0);
    header.style.height = '52px';
    header.style.flex = '0 0 auto';
    const title = label(header, 'Tournaments', 32, Colors.Gold, { bold: true, align: 'left' });
    title.style.flex = '1 1 0';
    title.style.alignSelf = 'stretch';
    button(header, 'Close', Colors.Grey, 46, 120, () => this.close());

    const tabs = group(sheet, 'row', 10, [0, 0, 0, 0], 'start');
    tabs.style.height = '48px';
    tabs.style.flex = '0 0 auto';
    for (const [t, caption] of [['Open', 'Open'], ['Mine', 'Mine'], ['Host', 'Host'], ['Code', 'Enter code'], ['Practice', 'Practice']] as [Tab, string][])
      this.tabButtons.set(t, button(tabs, caption, Colors.Grey, 44, 160, () => this.showTab(t)));

    this.status = label(sheet, '', 17, Colors.Gold, { align: 'left', height: 28 });

    // Code row.
    this.codeRow = group(sheet, 'row', 10);
    this.codeRow.style.height = '52px';
    this.codeRow.style.flex = '0 0 auto';
    this.codeInput = el('input', 'trn-input', this.codeRow) as HTMLInputElement;
    this.codeInput.placeholder = 'Code';
    this.codeInput.maxLength = 16;
    this.codeInput.style.height = '52px';
    this.codeInput.style.flex = '1 1 0';
    button(this.codeRow, 'Find', Colors.TourGold, 52, 150, () => void this.run(() => this.findByCodeAsync()));

    // Host form.
    this.hostForm = group(sheet, 'column', 10);
    this.hostForm.style.flex = '0 0 auto';
    this.nameInput = inputRow(this.hostForm, 'Name', 'Friday Night Stack', 40);
    this.prizeInput = inputRow(this.hostForm, 'Your prize (chips)', '1000', 40, true);
    this.feeInput = inputRow(this.hostForm, 'Entry fee (0 = free)', '0', 40, true);
    this.startInput = inputRow(this.hostForm, 'Starts in (minutes)', '15', 40, true);
    this.maxInput = inputRow(this.hostForm, 'Max players (2–30)', '30', 40, true);
    const toggles = group(this.hostForm, 'row', 10, [0, 0, 0, 0], 'start');
    toggles.style.height = '48px';
    this.speedButton = button(toggles, '', Colors.Grey, 46, 300, () => {
      this.speed = this.speed === 'turbo' ? 'regular' : this.speed === 'regular' ? 'slow' : 'turbo';
      this.refreshToggles();
    });
    this.visibilityButton = button(toggles, '', Colors.Grey, 46, 300, () => {
      this.isPrivate = !this.isPrivate;
      this.refreshToggles();
    });
    this.refreshToggles();
    label(this.hostForm, 'Your prize is taken now and paid 60/40 to 1st and 2nd, plus every entry fee. Cancel before the start and everyone gets their chips back.',
      15, Colors.Muted, { align: 'left', height: 46 });
    const create = button(this.hostForm, 'Create & lock prize', Colors.TourGold, 54, 0, () => void this.run(() => this.createAsync()));
    create.style.flex = '0 0 auto';

    // Practice (web addition: Unity's Editor-only practice menu).
    this.practiceRow = group(sheet, 'column', 10);
    this.practiceRow.style.flex = '0 0 auto';
    for (const [n, caption] of [[5, 'Practice: 5 players (one table)'], [8, 'Practice: 8 players (2 tables, then the final)'], [16, 'Practice: 16 players (4 tables, 2, then the final)']] as [number, string][]) {
      const b = button(this.practiceRow, caption, Colors.TourGold, 54, 0, () => void this.svc.startPractice(n));
      b.style.flex = '0 0 auto';
    }

    this.listRoot = verticalScroll(sheet, 240, 10);
    this.listScroll = this.listRoot.parentElement!;
    this.listScroll.style.flex = '1 1 240px';

    // Drawn after the sheet so it stays clickable even if the sheet fills the screen.
    const corner = button(panel, 'Close', Colors.Grey, 46, 120, () => this.close());
    anchored(corner, 1, 1, [-16, -16], 120, 46);

    // The ready banner (bottom centre).
    this.banner = group(panel, 'row', 12, [20, 14, 10, 10]);
    this.banner.style.background = Colors.Panel;
    anchored(this.banner, 0.5, 0, [0, 28], 900, 76);
    this.bannerText = label(this.banner, '', 19, Colors.White, { align: 'left' });
    this.bannerText.style.flex = '1 1 0';
    this.bannerText.style.alignSelf = 'stretch';
    button(this.banner, 'Join', Colors.TourGold, 52, 150, () => {
      const ready = this.svc.ready;
      if (ready && isDemo(ready)) this.showTab('Mine');
      void this.run(() => this.svc.join(ready));
    });
    button(this.banner, '×', Colors.Grey, 44, 44, () => {
      if (this.svc.ready) this.svc.bannerDismissedId = this.svc.ready.id;
      this.banner.classList.add('trn-hidden');
    });
    this.banner.classList.add('trn-hidden');
  }
}

const report = (reply: Reply<TournamentInfo>, success: string): string => (reply.error === null ? success : reply.error);
