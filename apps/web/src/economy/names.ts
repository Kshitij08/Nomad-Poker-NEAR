/**
 * The player's display name on this device (Fusion's menu username pref, PokerClientIdentity.playerName) and its
 * rules — what PlayFabAuth's local half did, kept when PlayFab went. With a Nomad account the server's name wins and
 * renames are saved there (account.ts).
 */
import { PlayerPrefs } from '../app/services';
import { MenuUsernamePref, PokerClientIdentity } from './identity';
import { Signal } from './signal';

export const MinDisplayName = 3;
export const MaxDisplayName = 24; // the server's limit
const PlaceholderName = 'Player';

const sameIgnoreCase = (a: string | null | undefined, b: string): boolean => !!a && a.toLowerCase() === b.toLowerCase();
const isLetterOrDigit = (c: string): boolean => /[\p{L}\p{Nd}]/u.test(c);

export const DisplayNames = {
  /** Raised after the local name changes. */
  changed: new Signal<string>(),

  /** Null when `name` is acceptable, else the reason to show. */
  validate(name: string | null): string | null {
    const trimmed = name?.trim();
    if (!trimmed || trimmed.length < MinDisplayName || trimmed.length > MaxDisplayName) return `Names must be ${MinDisplayName}–${MaxDisplayName} characters.`;
    if (sameIgnoreCase(trimmed, PlaceholderName)) return 'Pick a name other than "Player".';
    return null;
  },

  /** Fusion's SetDefaults invents `Player` + 3 characters when the pref is empty. */
  isFusionPlaceholder(name: string | null | undefined): boolean {
    if (!name || name.length !== 9 || !name.startsWith('Player')) return false;
    for (let i = 6; i < name.length; i++) if (!isLetterOrDigit(name[i]!)) return false;
    return true;
  },

  /** Keeps PokerClientIdentity.playerName and the menu username pref in lockstep. */
  apply(name: string | null): void {
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (trimmed === PokerClientIdentity.playerName && PlayerPrefs.getString(MenuUsernamePref, '') === trimmed) return;
    PokerClientIdentity.playerName = trimmed;
    PlayerPrefs.setString(MenuUsernamePref, trimmed);
    DisplayNames.changed.emit(trimmed);
  },

  /**
   * Run once at boot: the menu username pref is the name this device plays under; a Fusion placeholder is replaced by
   * the durable guest name.
   */
  boot(): void {
    let menu = PlayerPrefs.getString(MenuUsernamePref, '');
    if (!menu || DisplayNames.isFusionPlaceholder(menu)) {
      const guest = PokerClientIdentity.getOrCreateGuestName();
      if (guest.trim() && !DisplayNames.isFusionPlaceholder(guest)) {
        PlayerPrefs.setString(MenuUsernamePref, guest);
        menu = guest;
      }
    }
    if (!menu) {
      menu = 'Player' + String(100 + Math.floor(Math.random() * 900));
      PlayerPrefs.setString(MenuUsernamePref, menu);
    }
    PokerClientIdentity.playerName = menu;
  },
};
