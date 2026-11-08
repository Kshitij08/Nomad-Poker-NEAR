/**
 * Profile-picture catalogue. Port of Core/Social/AvatarCatalog.cs (+ PokerTokenHash FNV-1a), so a seat whose player
 * never picked an avatar (every bot, and "You" offline) shows the same default face as in Unity.
 * Sprites: Assets/Test/UI/Common_UI/Pro_Pic/<id>.png.
 */
export const AvatarCatalog = {
  None: 0,

  Ids: Object.freeze([
    'pro_pic_08', 'pro_pic_09', 'pro_pic_010', 'pro_pic_011', 'pro_pic_012',
    'pro_pic_013', 'pro_pic_014', 'pro_pic_015', 'pro_pic_016', 'pro_pic_017',
    'pro_pic_018', 'pro_pic_019', 'pro_pic_020', 'pro_pic_021', 'pro_pic_022',
    'pro_pic_023', 'pro_pic_024', 'pro_pic_025', 'pro_pic_026',
  ] as const) as readonly string[],

  get count(): number {
    return AvatarCatalog.Ids.length;
  },

  isValid(avatar: number): boolean {
    return avatar >= 1 && avatar <= AvatarCatalog.Ids.length;
  },

  idOf(avatar: number): string | null {
    return AvatarCatalog.isValid(avatar) ? AvatarCatalog.Ids[avatar - 1]! : null;
  },

  /** The face a name maps to when no avatar was picked: FNV-1a(name) % 19 + 1. */
  fallbackFor(name: string | null | undefined): number {
    if (!name) return 1;
    const hash = tokenHash(name);
    return Number(hash % BigInt(AvatarCatalog.Ids.length)) + 1;
  },

  resolve(avatar: number, name: string | null | undefined): number {
    return AvatarCatalog.isValid(avatar) ? avatar : AvatarCatalog.fallbackFor(name);
  },
};

const OFFSET_BASIS = 14695981039346656037n;
const PRIME = 1099511628211n;
const MASK64 = (1n << 64n) - 1n;

/** PokerTokenHash.Of, as the unsigned 64-bit value AvatarCatalog reinterprets it as. 0 → 1. */
function tokenHash(token: string): bigint {
  let hash = OFFSET_BASIS;
  for (let i = 0; i < token.length; i++) {
    hash ^= BigInt(token.charCodeAt(i)); // C# iterates UTF-16 chars
    hash = (hash * PRIME) & MASK64;
  }
  return hash === 0n ? 1n : hash;
}
