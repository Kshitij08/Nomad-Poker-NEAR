/**
 * `?online=local`: an in-browser emulation of the PlayFab title, so every PlayFab code path in this module (device
 * login, email recovery, display names, UserData progress, friends + invites through CloudScript, statistics and
 * leaderboards, the Economy v2 chips balance and the retention-grant claims) runs with NO network.
 *
 * It answers the same REST paths with the same envelopes as the real title. The title data lives in localStorage
 * ('web.economy.localTitle'), shared with the offline chip ledger and the CloudScript ports (economy/server).
 * Google sign-in is not emulated (it needs Google's servers): it fails like a title without the Google add-on.
 */
import { AvatarUrl } from '../../core/social/avatarUrl';
import { FreePlayLeaderboardMath } from '../../core/leaderboards/freePlayLeaderboardMath';
import { runCloudScript } from '../server/cloudScript';
import {
  createPlayer, emptyTitleState, playerByEntity, randomHex, rankedBoard, setStat, statOf,
  type TitlePlayer, type TitleState, type TitleStateHandle,
} from '../server/titleState';
import type { RawEnvelope, Transport } from './client';

const STORAGE_KEY = 'web.economy.localTitle';
const SESSION_MS = 24 * 3600_000;
/** The CH currency item's id on the emulated title (a real title assigns a GUID). */
export const LOCAL_CURRENCY_ITEM_ID = '0c0c0c0c-0000-4000-8000-00000000c4c4';

/** A title persisted in localStorage (or kept in memory where storage is blocked). */
export function browserTitle(): TitleStateHandle {
  let state: TitleState = emptyTitleState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as TitleState;
      if (parsed && parsed.version === 1 && parsed.players) state = parsed;
    }
  } catch {
    /* corrupt or blocked: start a fresh title */
  }
  return {
    state,
    save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        /* blocked storage: keep in memory */
      }
    },
  };
}

type Body = Record<string, unknown>;
const ok = (data: unknown): RawEnvelope => ({ code: 200, status: 'OK', data });
const err = (error: string, errorMessage: string, code = 400, errorCode = 1000): RawEnvelope => ({ code, status: 'BadRequest', error, errorCode, errorMessage });
const iso = (ms: number | null) => (ms === null ? undefined : new Date(ms).toISOString());

export class LocalTitleTransport implements Transport {
  readonly kind = 'local' as const;

  constructor(readonly title: TitleStateHandle, private readonly now: () => number = Date.now, private readonly latencyMs = 0) {}

  async post(path: string, body: unknown, headers: Record<string, string>): Promise<RawEnvelope> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    const b = (body && typeof body === 'object' ? body : {}) as Body;
    const res = this.route(path, b, headers);
    this.title.save();
    // Hand back a copy, like a real response: callers must not hold live references into the title.
    return JSON.parse(JSON.stringify(res)) as RawEnvelope;
  }

  private get s(): TitleState {
    return this.title.state;
  }

  private bySession(headers: Record<string, string>): TitlePlayer | null {
    const t = headers['X-Authorization'];
    const sess = t ? this.s.sessions[t] : undefined;
    if (!sess || sess.expires <= this.now()) return null;
    return this.s.players[sess.playFabId] ?? null;
  }

  private byEntity(headers: Record<string, string>): TitlePlayer | null {
    const t = headers['X-EntityToken'];
    const tok = t ? this.s.entityTokens[t] : undefined;
    if (!tok || tok.expires <= this.now()) return null;
    return this.s.players[tok.playFabId] ?? null;
  }

  private route(path: string, b: Body, headers: Record<string, string>): RawEnvelope {
    const [api, name] = path.split('/') as [string, string];
    if (api === 'Client') {
      switch (name) {
        case 'LoginWithCustomID': return this.loginCustomId(b);
        case 'LoginWithEmailAddress': return this.loginEmail(b);
        case 'LoginWithGoogleAccount':
          return err('GoogleOAuthNotConfiguredForTitle', 'Google login is not configured on the local emulated title.');
      }
      const me = this.bySession(headers);
      if (!me) return err('NotAuthenticated', 'This API method requires a valid session ticket.', 401, 1074);
      return this.client(name, b, me);
    }
    const ent = this.byEntity(headers);
    if (!ent) return err('NotAuthenticated', 'Entity token missing or expired.', 401, 1074);
    if (path === 'Catalog/GetItem') {
      const alt = b.AlternateId as { Type?: string; Value?: string } | undefined;
      if (alt?.Type === 'FriendlyId' && alt.Value === 'CH') return ok({ Item: { Id: LOCAL_CURRENCY_ITEM_ID, Type: 'currency' } });
      return err('ItemNotFound', 'No catalog item with that id.', 404, 1047);
    }
    if (path === 'Inventory/GetInventoryItems') {
      const items = ent.chips === null ? [] : [{ Id: LOCAL_CURRENCY_ITEM_ID, Type: 'currency', Amount: ent.chips }];
      return ok({ Items: items });
    }
    return err('APINotEnabledForGameClientAccess', `${path} is not emulated by the local title.`, 404, 1082);
  }

  // ---- Login ------------------------------------------------------------------------------------------

  private issueLogin(p: TitlePlayer, newlyCreated: boolean, b: Body): RawEnvelope {
    const now = this.now();
    p.lastLogin = now;
    const ticket = `${p.id}-${randomHex(32)}`;
    const entityToken = randomHex(48);
    this.s.sessions[ticket] = { playFabId: p.id, expires: now + SESSION_MS };
    this.s.entityTokens[entityToken] = { playFabId: p.id, expires: now + SESSION_MS };
    this.pruneTokens(now);
    const wantProfile = (b.InfoRequestParameters as { GetPlayerProfile?: boolean } | undefined)?.GetPlayerProfile;
    return ok({
      SessionTicket: ticket,
      PlayFabId: p.id,
      NewlyCreated: newlyCreated,
      EntityToken: { EntityToken: entityToken, TokenExpiration: iso(now + SESSION_MS), Entity: { Id: p.entityId, Type: 'title_player_account' } },
      InfoResultPayload: wantProfile ? { PlayerProfile: { PlayerId: p.id, DisplayName: p.displayName ?? undefined } } : undefined,
    });
  }

  private pruneTokens(now: number): void {
    for (const [k, v] of Object.entries(this.s.sessions)) if (v.expires <= now) delete this.s.sessions[k];
    for (const [k, v] of Object.entries(this.s.entityTokens)) if (v.expires <= now) delete this.s.entityTokens[k];
  }

  private loginCustomId(b: Body): RawEnvelope {
    const customId = typeof b.CustomId === 'string' ? b.CustomId : '';
    if (!customId) return err('InvalidParams', 'CustomId is required.');
    let p = Object.values(this.s.players).find((x) => x.customIds.includes(customId)) ?? null;
    let created = false;
    if (!p) {
      if (b.CreateAccount !== true) return err('AccountNotFound', 'User not found', 400, 1001);
      p = createPlayer(this.s, { customIds: [customId], created: this.now() });
      created = true;
      // Automation rule: com.playfab.player_added_title → grantStartingChips.
      runCloudScript({ title: this.title, currentPlayerId: p.id, now: this.now() }, 'grantStartingChips', {});
    }
    return this.issueLogin(p, created, b);
  }

  private loginEmail(b: Body): RawEnvelope {
    const email = String(b.Email ?? '').trim().toLowerCase();
    const p = Object.values(this.s.players).find((x) => x.email === email) ?? null;
    if (!p) return err('AccountNotFound', 'User not found', 400, 1001);
    if (p.password !== String(b.Password ?? '')) return err('InvalidEmailOrPassword', 'Invalid email address or password', 400, 1142);
    return this.issueLogin(p, false, b);
  }

  // ---- Client API ---------------------------------------------------------------------------------------

  private client(name: string, b: Body, me: TitlePlayer): RawEnvelope {
    const now = this.now();
    switch (name) {
      case 'AddUsernamePassword': {
        const email = String(b.Email ?? '').trim().toLowerCase();
        const password = String(b.Password ?? '');
        const username = String(b.Username ?? '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err('InvalidEmailAddress', 'Invalid email address', 400, 1005);
        if (password.length < 6) return err('InvalidParams', 'Password must be between 6 and 100 characters.');
        if (Object.values(this.s.players).some((x) => x !== me && x.email === email)) return err('EmailAddressNotAvailable', 'Email address not available', 400, 1006);
        if (Object.values(this.s.players).some((x) => x !== me && x.username === username)) return err('UsernameNotAvailable', 'Username not available', 400, 1009);
        if (me.email) return err('AccountAlreadyLinked', 'This account already has a recovery login.', 400, 1011);
        me.email = email;
        me.password = password;
        me.username = username;
        return ok({ Username: username });
      }
      case 'LinkCustomID': {
        const customId = String(b.CustomId ?? '');
        const owner = Object.values(this.s.players).find((x) => x.customIds.includes(customId));
        if (owner && owner !== me) {
          if (b.ForceLink !== true) return err('LinkedIdentifierAlreadyClaimed', 'Custom ID already linked to another player.', 400, 1184);
          owner.customIds = owner.customIds.filter((c) => c !== customId);
        }
        if (!me.customIds.includes(customId)) me.customIds.push(customId);
        return ok({});
      }
      case 'LinkGoogleAccount':
        return err('GoogleOAuthNotConfiguredForTitle', 'Google login is not configured on the local emulated title.');
      case 'UpdateUserTitleDisplayName': {
        const dn = String(b.DisplayName ?? '').trim();
        if (dn.length < 3 || dn.length > 25) return err('InvalidParams', 'DisplayName must be between 3 and 25 characters.');
        if (Object.values(this.s.players).some((x) => x !== me && x.displayName?.toLowerCase() === dn.toLowerCase())) {
          return err('NameNotAvailable', 'Name not available', 400, 1058);
        }
        me.displayName = dn;
        return ok({ DisplayName: dn });
      }
      case 'GetPlayerProfile': {
        const p = this.s.players[String(b.PlayFabId ?? me.id)];
        if (!p) return err('AccountNotFound', 'User not found', 400, 1001);
        return ok({ PlayerProfile: { PlayerId: p.id, DisplayName: p.displayName ?? undefined } });
      }
      case 'GetAccountInfo': {
        let p: TitlePlayer | undefined = me;
        if (typeof b.TitleDisplayName === 'string') {
          const n = b.TitleDisplayName.trim().toLowerCase();
          p = Object.values(this.s.players).find((x) => x.displayName?.toLowerCase() === n);
        } else if (typeof b.PlayFabId === 'string') p = this.s.players[b.PlayFabId];
        if (!p) return err('AccountNotFound', 'User not found', 400, 1001);
        return ok({
          AccountInfo: {
            PlayFabId: p.id,
            Created: iso(p.created),
            TitleInfo: { DisplayName: p.displayName ?? undefined, AvatarUrl: p.avatarUrl ?? undefined, Created: iso(p.created), LastLogin: iso(p.lastLogin) },
            PrivateInfo: p === me && p.email ? { Email: p.email } : undefined,
            Username: p === me ? p.username ?? undefined : undefined,
          },
        });
      }
      case 'UpdateAvatarUrl':
        me.avatarUrl = String(b.ImageUrl ?? '') || null;
        return ok({});
      case 'GetUserData':
      case 'GetUserReadOnlyData': {
        const src = name === 'GetUserData' ? me.userData : me.readOnlyData;
        const keys = Array.isArray(b.Keys) ? (b.Keys as string[]) : Object.keys(src);
        const data: Record<string, unknown> = {};
        for (const k of keys) if (src[k]) data[k] = { ...src[k], Permission: 'Private' };
        return ok({ Data: data, DataVersion: 0 });
      }
      case 'UpdateUserData': {
        const data = (b.Data ?? {}) as Record<string, string>;
        for (const [k, v] of Object.entries(data)) me.userData[k] = { Value: String(v), LastUpdated: new Date(now).toISOString() };
        for (const k of (b.KeysToRemove as string[] | undefined) ?? []) delete me.userData[k];
        return ok({ DataVersion: 0 });
      }
      case 'GetTime':
        return ok({ Time: new Date(now).toISOString() });
      case 'GetFriendsList': {
        const c = (b.ProfileConstraints ?? null) as { ShowDisplayName?: boolean; ShowLastLogin?: boolean; ShowAvatarUrl?: boolean } | null;
        const friends = Object.entries(me.friends).map(([id, l]) => {
          const p = this.s.players[id];
          return {
            FriendPlayFabId: id,
            TitleDisplayName: p?.displayName ?? undefined,
            Tags: [...l.tags],
            Profile: c && p ? {
              PlayerId: id,
              DisplayName: c.ShowDisplayName ? p.displayName ?? undefined : undefined,
              LastLogin: c.ShowLastLogin ? iso(p.lastLogin) : undefined,
              AvatarUrl: c.ShowAvatarUrl ? p.avatarUrl ?? undefined : undefined,
            } : undefined,
          };
        });
        return ok({ Friends: friends });
      }
      case 'ExecuteCloudScript': {
        const fn = String(b.FunctionName ?? '');
        const result = runCloudScript({ title: this.title, currentPlayerId: me.id, now }, fn, b.FunctionParameter);
        if (result === null) return err('CloudScriptNotFound', `No function named ${fn} was found to execute`, 400, 1172);
        return ok({ FunctionName: fn, Revision: 1, FunctionResult: result, Logs: [], ExecutionTimeSeconds: 0 });
      }
      case 'UpdatePlayerStatistics': {
        for (const st of (b.Statistics as { StatisticName?: string; Value?: number }[] | undefined) ?? []) {
          if (st.StatisticName && typeof st.Value === 'number') setStat(me, st.StatisticName, st.Value, now);
        }
        return ok({});
      }
      case 'GetLeaderboard':
      case 'GetFriendLeaderboard': {
        const stat = String(b.StatisticName ?? '');
        const ids = name === 'GetFriendLeaderboard' ? new Set([me.id, ...Object.keys(me.friends)]) : undefined;
        const start = Math.max(0, Number(b.StartPosition ?? 0) | 0);
        const max = Math.min(100, Math.max(1, Number(b.MaxResultsCount ?? 10) | 0));
        const rows = rankedBoard(this.s, stat, now, ids).slice(start, start + max);
        return ok({ Leaderboard: rows.map((r, i) => this.entry(r.player, r.value, start + i)), Version: 0 });
      }
      case 'GetLeaderboardAroundPlayer': {
        const stat = String(b.StatisticName ?? '');
        const board = rankedBoard(this.s, stat, now);
        let pos = board.findIndex((r) => r.player.id === me.id);
        const value = pos >= 0 ? board[pos]!.value : 0;
        if (pos < 0) pos = board.length; // PlayFab lists an unranked player after everyone, at 0
        return ok({ Leaderboard: [this.entry(me, value, pos)], Version: 0 });
      }
    }
    return err('APINotEnabledForGameClientAccess', `Client/${name} is not emulated by the local title.`, 404, 1082);
  }

  private entry(p: TitlePlayer, value: number, position: number) {
    return { PlayFabId: p.id, DisplayName: p.displayName ?? undefined, StatValue: value, Position: position, Profile: { PlayerId: p.id, DisplayName: p.displayName ?? undefined } };
  }
}

// ---- Demo data -----------------------------------------------------------------------------------------

const DEMO_NAMES = ['RiyaK', 'NomadAce', 'SilverFox21', 'BluffMaster', 'LuckyLynx', 'CalmOtter', 'RoyalRaven', 'TableTiger'];

/**
 * Seeds demo players on the local title so the friends list, requests, invites and leaderboards have something to
 * show offline: ranked statistics for everyone, one friend, one incoming request and a live table invite for `me`.
 * Idempotent per player (re-running refreshes the invite and the scores).
 */
export function seedLocalDemo(title: TitleStateHandle, meId: string, now = Date.now()): void {
  const s = title.state;
  const me = s.players[meId];
  const demo: TitlePlayer[] = DEMO_NAMES.map((name, i) => {
    let p = Object.values(s.players).find((x) => x.demo && x.displayName === name);
    if (!p) p = createPlayer(s, { displayName: name, demo: true, chips: 10000, created: now - (i + 2) * 86400_000 });
    p.lastLogin = now - [3, 20, 90, 300, 1440, 4000, 9000, 50000][i]! * 60_000;
    p.avatarUrl = AvatarUrl.urlFor((i * 5) % 19 + 1);
    setStat(p, FreePlayLeaderboardMath.WeeklyEarnings, [48250, 31900, 22500, 15100, 9800, 4200, -1500, -6000][i]!, now);
    setStat(p, FreePlayLeaderboardMath.SeasonEarnings, [182000, 96500, 140200, 30500, 51000, 12000, 8000, -2000][i]!, now);
    setStat(p, FreePlayLeaderboardMath.HandsWon, [812, 640, 1210, 205, 388, 97, 150, 40][i]!, now);
    setStat(p, FreePlayLeaderboardMath.WeeklyHandsWon, [61, 44, 70, 12, 30, 9, 11, 3][i]!, now);
    return p;
  });
  if (me) {
    const [friend, requester, , friend2] = demo as [TitlePlayer, TitlePlayer, TitlePlayer, TitlePlayer];
    me.friends[friend.id] = { tags: ['friend'] };
    friend.friends[me.id] = { tags: ['friend'] };
    me.friends[friend2.id] = { tags: ['friend'] };
    friend2.friends[me.id] = { tags: ['friend'] };
    if (!me.friends[requester.id]) {
      me.friends[requester.id] = { tags: ['pending_in'] };
      requester.friends[me.id] = { tags: ['pending_out'] };
    }
    const invites = [{ from: friend.id, name: friend.displayName ?? '', session: 'NOMAD-' + friend.id.slice(0, 4), money: false, at: Math.floor(now / 1000) }];
    me.readOnlyData['Poker.Social.Invites'] = { Value: JSON.stringify(invites), LastUpdated: new Date(now).toISOString() };
  }
  title.save();
}

/** For tests: is this player's statistic live this period? */
export const _statOf = statOf;
export const _playerByEntity = playerByEntity;
