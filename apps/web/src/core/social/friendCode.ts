/**
 * Port of Core/Social/FriendCode.cs: a player's Friend ID is their PlayFabId (16 hex characters), shown in groups
 * of four so it can be read out over voice chat.
 */
export const FriendCode = {
  Length: 16,

  /** `1A2B3C4D5E6F7A8B` → `1A2B-3C4D-5E6F-7A8B`. Anything else comes back as-is (null → ''). */
  format(playFabId: string | null | undefined): string {
    const id = FriendCode.tryParse(playFabId);
    if (id === null) return playFabId ?? '';
    let out = '';
    for (let i = 0; i < id.length; i++) {
      if (i > 0 && i % 4 === 0) out += '-';
      out += id[i];
    }
    return out;
  },

  /**
   * The canonical id when `input` is a Friend ID however it was pasted (dashes, spaces, en/em dashes, lowercase);
   * null means the input should be treated as a display name instead.
   */
  tryParse(input: string | null | undefined): string | null {
    if (input == null || input.trim().length === 0) return null;
    let out = '';
    for (const raw of input) {
      if (raw === '-' || raw === ' ' || raw === '–' || raw === '—') continue;
      const c = raw.toUpperCase();
      const hex = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F');
      if (!hex || c.length !== 1) return null;
      out += c;
    }
    return out.length === FriendCode.Length ? out : null;
  },
};
