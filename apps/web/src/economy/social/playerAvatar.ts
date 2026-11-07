/**
 * Ports of Game/PlayerAvatar.cs (this player's own picture, PlayerPrefs "Poker.Avatar") and Social/PlayFabAvatar.cs
 * (keeps it in step with the PlayFab account's AvatarUrl: the account wins on sign-in unless it has none).
 */
import { PlayerPrefs } from '../../app/services';
import { AvatarCatalog } from '../../core/social/avatarCatalog';
import { AvatarUrl } from '../../core/social/avatarUrl';
import { errorReport } from '../playfab/client';
import { isClientLoggedIn, playFab } from '../playfab/runtime';
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
  if (!isClientLoggedIn() || !AvatarCatalog.isValid(avatar)) return;
  const r = await playFab()!.client('UpdateAvatarUrl', { ImageUrl: AvatarUrl.urlFor(avatar) });
  if (r.error) console.warn(`[Avatar] Could not save the picture to the account: ${errorReport(r.error)}`);
}

export const PlayFabAvatar = {
  /** Hook (AfterAssembliesLoaded): every local pick is pushed to the account. */
  hook(): () => void {
    return PlayerAvatar.changed.on(() => {
      if (!PlayerAvatar.lastChangeFromAccount) void pushAsync(PlayerAvatar.current);
    });
  },

  /** After a sign-in: adopt the account's picture, or give the account this device's. */
  async pullAsync(): Promise<void> {
    if (!isClientLoggedIn()) return;
    const r = await playFab()!.client<{ AccountInfo?: { TitleInfo?: { AvatarUrl?: string } } }>('GetAccountInfo', {});
    if (r.error) {
      console.warn(`[Avatar] Could not read the account's picture: ${errorReport(r.error)}`);
      return;
    }
    const fromAccount = AvatarUrl.fromUrl(r.data.AccountInfo?.TitleInfo?.AvatarUrl ?? '');
    if (AvatarCatalog.isValid(fromAccount)) PlayerAvatar.adoptFromAccount(fromAccount);
    else if (AvatarCatalog.isValid(PlayerAvatar.current)) await pushAsync(PlayerAvatar.current);
  },
};
