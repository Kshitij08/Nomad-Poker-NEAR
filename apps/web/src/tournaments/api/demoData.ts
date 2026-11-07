import { DEMO_ME, DEMO_PREFIX, fail, ok, type CreateRequest, type ListResult, type MineResult, type Reply, type TournamentInfo } from './tournamentInfo';

/**
 * Sample tournaments for the Tournaments panel (the offline default here; Unity shows them in the Editor). They cover
 * every state the panel shows — open, starting soon, hosted by you with a private code, your table ready to join,
 * finished, cancelled — and Register / Leave / Cancel / Host / Enter code act on them locally. Nothing reaches a
 * backend. Port of Tournaments/TournamentDemoData.cs (same seed list, same rules, same messages).
 */
export class TournamentDemoData {
  private all: TournamentInfo[] | null = null;
  private created = 0;

  constructor(private readonly nowUnix: () => number = () => Math.floor(Date.now() / 1000)) {}

  private get list(): TournamentInfo[] {
    if (!this.all) this.seed();
    return this.all!;
  }

  private get now(): number {
    return this.nowUnix();
  }

  listTournaments(filter: string): ListResult {
    const pub = this.list.filter((t) => t.visibility === 'public');
    const picked = filter === 'running' ? pub.filter((t) => t.status === 'locked' || t.status === 'running')
      : filter === 'finished' ? pub.filter((t) => t.status === 'finished')
        : pub.filter((t) => t.status === 'registering');
    return { serverNowUnix: this.now, tournaments: stableSort(picked, (a, b) => a.startsAtUnix - b.startsAtUnix).map(copy) };
  }

  mine(): MineResult {
    return {
      serverNowUnix: this.now,
      entries: stableSort(this.list.filter((t) => !!t.myStatus), (a, b) => b.startsAtUnix - a.startsAtUnix).map(copy),
      hosted: stableSort(this.list.filter((t) => t.hostPlayFabId === DEMO_ME), (a, b) => b.startsAtUnix - a.startsAtUnix).map(copy),
    };
  }

  get(id: string): Reply<TournamentInfo> {
    return found(this.list.find((t) => t.id === id));
  }

  byCode(code: string): Reply<TournamentInfo> {
    const c = (code ?? '').trim().toLowerCase();
    const t = this.list.find((x) => x.joinCode.toLowerCase() === c && c.length > 0);
    return t ? found(t) : fail('No tournament has that code. (Demo codes: K7Q2XM, FRIDAY.)', 'demo');
  }

  register(id: string): Reply<TournamentInfo> {
    const t = this.list.find((x) => x.id === id);
    if (!t) return fail('Tournament not found.', 'demo');
    if (t.status !== 'registering') return fail('Registration is closed.', 'demo');
    if (t.myStatus === 'registered') return found(t);
    if (t.players >= t.maxPlayers) return fail('This tournament is full.', 'demo');
    t.myStatus = 'registered';
    t.players++;
    reprice(t);
    return found(t);
  }

  unregister(id: string): Reply<TournamentInfo> {
    const t = this.list.find((x) => x.id === id);
    if (!t || t.myStatus !== 'registered') return fail("You aren't registered.", 'demo');
    t.myStatus = 'unregistered';
    t.players = Math.max(0, t.players - 1);
    reprice(t);
    return found(t);
  }

  cancel(id: string): Reply<TournamentInfo> {
    const t = this.list.find((x) => x.id === id);
    if (!t || t.hostPlayFabId !== DEMO_ME) return fail('Only the host can do that.', 'demo');
    if (t.status !== 'registering') return fail('A tournament can only be cancelled before it starts.', 'demo');
    t.status = 'cancelled';
    t.cancelReason = 'host_cancelled';
    return found(t);
  }

  raisePrize(id: string, amount: number): Reply<TournamentInfo> {
    const t = this.list.find((x) => x.id === id);
    if (!t) return fail('Tournament not found.', 'demo');
    t.hostPrize += amount;
    reprice(t);
    return found(t);
  }

  create(r: CreateRequest): Reply<TournamentInfo> {
    if (r.startsAtUnix < this.now + 60) return fail('Start at least a minute from now (demo).', 'demo');
    const t = this.make(`${DEMO_PREFIX}created-${++this.created}`, r.name, DEMO_ME, 'You', r.hostPrize, r.entryFee, 0, r.maxPlayers, r.speed, r.startsAtUnix - this.now, r.visibility);
    if (r.visibility === 'private') t.joinCode = 'DEMO' + (10 + this.created);
    this.list.push(t);
    return found(t);
  }

  // ---- Seed --------------------------------------------------------------------------------

  private seed(): void {
    this.all = [
      // The open list.
      this.make('demo-friday', 'Friday Night Stack', 'demo-rhea', 'Rhea', 20000, 500, 18, 30, 'regular', 42 * 60, 'public', 'FRIDAY'),
      this.make('demo-freeroll', 'Sunday Freeroll', 'demo-kai', 'Kai', 10000, 0, 11, 30, 'turbo', 125 * 60, 'public'),
      this.make('demo-highroller', 'High Roller Showdown', 'demo-mo', 'Mo', 50000, 2000, 5, 8, 'slow', 6 * 60, 'public'),
      this.make('demo-rookie', 'Rookie Cup', 'demo-ana', 'Ana', 2000, 0, 3, 16, 'turbo', 25 * 60, 'public'),
      this.make('demo-midnight', 'Midnight Grind', 'demo-zed', 'Zed', 8000, 250, 22, 30, 'regular', 180 * 60, 'public'),
      // Yours.
      hosting(this.make('demo-mine-hosted', 'My Test Night', DEMO_ME, 'You', 5000, 0, 4, 20, 'regular', 55 * 60, 'private', 'K7Q2XM')),
      mark(this.make('demo-ready', 'Coffee Break Turbo', 'demo-lee', 'Lee', 3000, 0, 6, 12, 'turbo', 2 * 60, 'public'), { myStatus: 'registered', serverReady: true }),
      mark(this.make('demo-weekend', 'Weekend Warriors', 'demo-rhea', 'Rhea', 15000, 300, 14, 30, 'regular', 90 * 60, 'public'), { myStatus: 'registered' }),
      mark(this.make('demo-lastweek', "Last Week's Cup", 'demo-kai', 'Kai', 6000, 200, 20, 30, 'regular', -6 * 24 * 3600, 'public'), { myStatus: 'finished', status: 'finished', place: 2 }),
      mark(this.make('demo-rainy', 'Rainy Day Open', 'demo-ana', 'Ana', 1000, 0, 1, 30, 'turbo', -2 * 3600, 'public'), { myStatus: 'cancelled', status: 'cancelled', cancelReason: 'not_enough_players' }),
    ];
  }

  private make(id: string, name: string, hostId: string, hostName: string, prize: number, fee: number, players: number, max: number,
    speed: string, startsInSeconds: number, visibility: string, code?: string): TournamentInfo {
    const t: TournamentInfo = {
      id, name, hostPlayFabId: hostId, hostName, hostPrize: prize, entryFee: fee, players, maxPlayers: max, speed,
      startsAtUnix: this.now + startsInSeconds, visibility, joinCode: code ?? '', status: 'registering', myStatus: '',
      sessionName: '', cancelReason: '', prizePool: 0, firstPrize: 0, secondPrize: 0, format: '', myPlace: 0, myPrize: 0,
      serverReady: false,
    };
    reprice(t);
    return t;
  }
}

function mark(t: TournamentInfo, o: { myStatus: string; status?: string; serverReady?: boolean; place?: number; cancelReason?: string }): TournamentInfo {
  t.myStatus = o.myStatus;
  if (o.status) t.status = o.status;
  t.serverReady = o.serverReady ?? false;
  if (t.serverReady) t.sessionName = 'TRNDEMO' + t.id.substring(DEMO_PREFIX.length, DEMO_PREFIX.length + 3).toUpperCase();
  t.myPlace = o.place ?? 0;
  t.myPrize = t.myPlace === 1 ? t.firstPrize : t.myPlace === 2 ? t.secondPrize : 0;
  if (o.cancelReason !== undefined) t.cancelReason = o.cancelReason;
  return t;
}

/** A tournament you host whose server is up — the panel offers Watch. */
function hosting(t: TournamentInfo): TournamentInfo {
  t.serverReady = true;
  t.sessionName = 'TRNDEMOHOST';
  return t;
}

/** The same 60/40 split as the backend and PayoutCalculator. */
function reprice(t: TournamentInfo): void {
  t.prizePool = t.hostPrize + t.entryFee * t.players;
  t.secondPrize = Math.trunc((t.prizePool * 4000) / 10000);
  t.firstPrize = t.prizePool - t.secondPrize;
  t.format = t.players < 2 ? 'cancelled' : t.players <= 7 ? 'single' : t.players <= 15 ? 'two_tables' : 'four_tables';
}

const copy = (t: TournamentInfo): TournamentInfo => ({ ...t });
const found = (t: TournamentInfo | undefined): Reply<TournamentInfo> => (t ? ok(copy(t)) : fail('Tournament not found.', 'demo'));

/** LINQ OrderBy is stable; so is Array.prototype.sort, but on a copy. */
function stableSort<T>(list: T[], cmp: (a: T, b: T) => number): T[] {
  return [...list].sort(cmp);
}
