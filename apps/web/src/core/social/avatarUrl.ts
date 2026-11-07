/**
 * The PlayFab-account half of Core/Social/AvatarCatalog.cs (UrlFor / FromUrl / FromId), kept beside the already
 * ported avatarCatalog.ts. On the account the pick is stored as the profile's AvatarUrl: a real https URL under the
 * reserved `.invalid` domain (RFC 2606) that passes URL validation and can never resolve.
 */
import { AvatarCatalog } from './avatarCatalog';

export const AvatarUrl = {
  Prefix: 'https://avatars.poker.invalid/',

  fromId(id: string | null | undefined): number {
    if (!id) return AvatarCatalog.None;
    const index = AvatarCatalog.Ids.indexOf(id);
    return index < 0 ? AvatarCatalog.None : index + 1;
  },

  /** What goes in the PlayFab AvatarUrl for this pick. Empty clears it. */
  urlFor(avatar: number): string {
    const id = AvatarCatalog.idOf(avatar);
    return id === null ? '' : AvatarUrl.Prefix + id;
  },

  /** Reads a stored AvatarUrl back. Anything that is not one of ours is None (OrdinalIgnoreCase prefix). */
  fromUrl(url: string | null | undefined): number {
    if (!url || !url.toLowerCase().startsWith(AvatarUrl.Prefix.toLowerCase())) return AvatarCatalog.None;
    return AvatarUrl.fromId(url.substring(AvatarUrl.Prefix.length));
  },
};
