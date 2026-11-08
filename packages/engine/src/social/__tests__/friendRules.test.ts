/** Ports of Assets/Scripts/Tests/FriendRulesTests.cs + the AvatarCatalog URL test (same golden values). */
import { describe, expect, it } from 'vitest';
import { FriendCode } from '../friendCode';
import { FriendInviteRules, FriendLastSeen, FriendRelation, FriendTags } from '../friendRules';
import { AvatarUrl } from '../avatarUrl';
import { AvatarCatalog } from '../avatarCatalog';

describe('FriendRulesTests', () => {
  it('Tags_MapToRelation', () => {
    expect(FriendTags.fromTags(['friend'])).toBe(FriendRelation.Friend);
    expect(FriendTags.fromTags(['pending_in'])).toBe(FriendRelation.IncomingRequest);
    expect(FriendTags.fromTags(['pending_out'])).toBe(FriendRelation.OutgoingRequest);
    expect(FriendTags.fromTags(['something_else'])).toBe(FriendRelation.None);
    expect(FriendTags.fromTags(null)).toBe(FriendRelation.None);
    expect(FriendTags.fromTags([])).toBe(FriendRelation.None);
  });

  it('Tags_FriendWinsOverAStalePendingTag', () => {
    expect(FriendTags.fromTags(['pending_in', 'friend'])).toBe(FriendRelation.Friend);
  });

  it('FriendCode_AcceptsPastedVariants', () => {
    expect(FriendCode.tryParse('1A2B3C4D5E6F7A8B')).toBe('1A2B3C4D5E6F7A8B');
    expect(FriendCode.tryParse('1a2b-3c4d-5e6f-7a8b')).toBe('1A2B3C4D5E6F7A8B');
    expect(FriendCode.tryParse(' 1A2B 3C4D 5E6F 7A8B ')).toBe('1A2B3C4D5E6F7A8B');
    expect(FriendCode.tryParse('1A2B–3C4D—5E6F7A8B')).toBe('1A2B3C4D5E6F7A8B');
  });

  it('FriendCode_RejectsNamesAndWrongLengths', () => {
    expect(FriendCode.tryParse('PlayerX7K')).toBeNull();
    expect(FriendCode.tryParse('1A2B3C4D5E6F7A8')).toBeNull();
    expect(FriendCode.tryParse('1A2B3C4D5E6F7A8B0')).toBeNull();
    expect(FriendCode.tryParse('1A2B3C4D5E6F7A8G')).toBeNull();
    expect(FriendCode.tryParse('')).toBeNull();
    expect(FriendCode.tryParse(null)).toBeNull();
  });

  it('FriendCode_FormatsInGroupsOfFour', () => {
    expect(FriendCode.format('1a2b3c4d5e6f7a8b')).toBe('1A2B-3C4D-5E6F-7A8B');
    expect(FriendCode.format('not-an-id')).toBe('not-an-id');
    expect(FriendCode.format(null)).toBe('');
  });

  it('Invite_ExpiresAfterTheTtl', () => {
    const sent = 1_800_000_000;
    expect(FriendInviteRules.isLive(sent, sent)).toBe(true);
    expect(FriendInviteRules.isLive(sent, sent + FriendInviteRules.TtlSeconds - 1)).toBe(true);
    expect(FriendInviteRules.isLive(sent, sent + FriendInviteRules.TtlSeconds)).toBe(false);
  });

  it('Invite_ToleratesSmallSkewButNotNonsense', () => {
    const now = 1_800_000_000;
    expect(FriendInviteRules.isLive(now + 10, now)).toBe(true);
    expect(FriendInviteRules.isLive(now + 3600, now)).toBe(false);
    expect(FriendInviteRules.isLive(0, now)).toBe(false);
  });

  it('LastSeen_ReadsInTheLargestSensibleUnit', () => {
    const now = Date.UTC(2026, 8, 27, 12, 0, 0);
    expect(FriendLastSeen.describe(null, now)).toBe('');
    expect(FriendLastSeen.describe(now - 20_000, now)).toBe('Seen just now');
    expect(FriendLastSeen.describe(now - 5 * 60_000, now)).toBe('Seen 5m ago');
    expect(FriendLastSeen.describe(now - 3 * 3600_000, now)).toBe('Seen 3h ago');
    expect(FriendLastSeen.describe(now - 2 * 86400_000, now)).toBe('Seen 2d ago');
    expect(FriendLastSeen.describe(now - 45 * 86400_000, now)).toBe('Seen over a month ago');
  });
});

describe('AvatarCatalogTests (URL half)', () => {
  it('Url_RoundTripsAndIgnoresForeignUrls', () => {
    const pick = AvatarUrl.fromId('pro_pic_019');
    const url = AvatarUrl.urlFor(pick);
    expect(url).toBe('https://avatars.poker.invalid/pro_pic_019');
    expect(AvatarUrl.fromUrl(url)).toBe(pick);
    expect(AvatarUrl.urlFor(AvatarCatalog.None)).toBe('');
    expect(AvatarUrl.fromUrl(null)).toBe(AvatarCatalog.None);
    expect(AvatarUrl.fromUrl('https://example.com/me.png')).toBe(AvatarCatalog.None);
    expect(AvatarUrl.fromUrl(AvatarUrl.Prefix + 'missing')).toBe(AvatarCatalog.None);
    expect(AvatarUrl.fromUrl('HTTPS://AVATARS.POKER.INVALID/pro_pic_08')).toBe(1);
  });
});
