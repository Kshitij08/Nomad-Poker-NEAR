/**
 * Quick Play free-table filler bots: a weighted 1–4 pack and a display-name list that reads as other players.
 * Port of Bots/QuickPlayFreeBots.cs. NOTE: used by the networked Quick Play server, NOT by the offline
 * single-player PokerGameController (which names its bots "Bot 1".."Bot N").
 */
export const QuickPlayFreeBots = {
  MaxBots: 4,

  /** roll0to99 is a 0–99 roll. 4 bots 50%, 3 bots 30%, 2 bots 15%, 1 bot 5%. */
  rollCount(roll0to99: number): number {
    if (roll0to99 < 50) return 4;
    if (roll0to99 < 80) return 3;
    if (roll0to99 < 95) return 2;
    return 1;
  },

  Names: Object.freeze([
    'LaggingAgain', 'ProSnackEater', 'NPC_Behavior', 'UrMom123', 'WashedUpGamer', 'BreadAngel', 'TacoTuesday',
    'PleaseDontShoot', 'HideAndSeekChamp', 'MomPausedMyGame', 'WiFisDown', 'Error404SkillNotFound', 'CerealKiller',
    'PotatoAim', 'NeedHealing', 'Bot_Number_42', 'JustVibing', 'TouchedGrassOnce', 'KeyboardWarrior', 'CarryMePlease',
    'Jake_2004', 'SarahPlays', 'MikeGaming', 'Chris_B', 'AlexTheGreat', 'Emily_99', 'Tom_Smith12', 'Dave_In_Action',
    'Jess_Gamer', 'Kevin_07', 'Rachel_W', 'Matt_1998', 'Sam_The_Man', 'JoshPlaysGames', 'Emma_123', 'Dan_The_Gamer',
    'Chloe_2001', 'Brian_H', 'Lauren_Plays', 'Ryan_95', 'orbit', 'cloudy', 'hazely', 'drift', 'static', 'echo', 'lunar',
    'minty', 'dusk', 'abyss', 'pixel', 'nova', 'zen', 'spark', 'ripple', 'blur', 'rust', 'ivy', 'moss', 'ember',
    'xX_Vortex_Xx', 'ShadowStriker', 'GhostFlux', 'Reaper_TTV', 'Toxic_Venom', 'VoidSeeker', 'Headshot_King',
    'NoScopePro', 'QuantumQuake', 'Fatal_Error', 'DarkReaper', 'TryHardNinja', 'SweatyPalms', 'WipingSquads',
    'The_Punisher99', 'SilentAssassin', 'CodeRed_', 'ZeroPing', 'BloodFangX', 'Elite_Gamer', 'BraveOtter402',
    'SlipperyToad88', 'CalmRhino119', 'FiercePanda33', 'LoyalHawk772', 'SilentFox901', 'HappyTurtle55',
    'SneakyRaccoon24', 'FlyingPenguin10', 'RapidCheetah99', 'SleepySloth404', 'GoldenEagle71', 'CrimsonWolf55',
    'MightyBear101', 'CleverRaven808', 'FrostyMoose303', 'MagicDolphin12', 'GiantSquid990', 'SwiftBadger27',
    'WildTiger665',
  ] as const),
};
