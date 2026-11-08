/**
 * Port of Game/PlayerAvatar.cs (this player's own picture, PlayerPrefs "Poker.Avatar"), kept in step with the Nomad
 * account's avatar (it was PlayFab's AvatarUrl): the account wins on sign-in unless it has none, and every local pick
 * is saved to the account.
 */
import { PlayerPrefs } from '../../app/services';
import { AvatarCatalog } from '@nomad/engine/social/avatarCatalog';
import { SocialRoutes } from '@nomad/contract';
import { NomadLink } from '../nomadLink';
import { Signal } from '../signal';

const Pref = 'Poker.Avatar';
let lastChangeFromAccount = false;

function store(avatar: number, fromAccount: boolean): void {
  if (!AvatarCatalog.isValid(avatar) || avatar === PlayerAvatar.current) return;
  PlayerPrefs.setInt(Pref, avatar);
  lastChangeFromAccount = fromAccount;
  PlayerAvatar.changed.emit();
}

export const PlayerAvatar = {
  /** Raised after the pick changes, from either direction. */
  changed: new Signal(),

  get lastChangeFromAccount(): boolean {
    return lastChangeFromAccount;
  },

  /** The pick, or None (0) if this player never chose one. */
  get current(): number {
    const stored = PlayerPrefs.getInt(Pref, AvatarCatalog.None);
    return stored >= 0 && stored <= 255 ? stored : AvatarCatalog.None;
  },

  /** The picture to draw: the pick, or the default the name gives. */
  shown(playerName: string | null): number {
    return AvatarCatalog.resolve(PlayerAvatar.current, playerName);
  },

  choose(avatar: number): void {
    store(avatar, false);
  },

  adoptFromAccount(avatar: number): void {
    store(avatar, true);
  },

  /** Drops this device's copy on sign-out (the next account must not inherit it). */
  forgetLocal(): void {
    if (PlayerAvatar.current === AvatarCatalog.None) return;
    PlayerPrefs.deleteKey(Pref);
    lastChangeFromAccount = true;
    PlayerAvatar.changed.emit();
  },
};

async function pushAsync(avatar: number): Promise<void> {
  if (!NomadLink.signedIn || !AvatarCatalog.isValid(avatar)) return;
  try {
    await NomadLink.call('POST', SocialRoutes.profile, { avatar });
  } catch (e) {
    console.warn('[Avatar] Could not save the picture to the account', e);
  }
}

export const AccountAvatar = {
  /** Every local pick is saved to the account. Returns the unhook. */
  hook(): () => void {
    return PlayerAvatar.changed.on(() => {
      if (!PlayerAvatar.lastChangeFromAccount) void pushAsync(PlayerAvatar.current);
    });
  },

  /** After a sign-in: adopt the account's picture, or give the account this device's. */
  async pullAsync(): Promise<void> {
    const me = NomadLink.session?.me;
    if (!me) return;
    if (AvatarCatalog.isValid(me.player.avatar)) PlayerAvatar.adoptFromAccount(me.player.avatar);
    else if (AvatarCatalog.isValid(PlayerAvatar.current)) await pushAsync(PlayerAvatar.current);
  },
};
