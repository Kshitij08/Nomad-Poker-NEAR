using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Poker.Core;

// Encodes one of every wire event with the real C# codec and writes the bytes as hex.
static class Program
{
    static Card C(string s) { int r = "23456789TJQKA".IndexOf(char.ToUpperInvariant(s[0])); int su = "cdhs".IndexOf(char.ToLowerInvariant(s[1])); return Card.FromIndex(su * 13 + r); }

    static void Main()
    {
        var seats = new[]
        {
            new SeatSnapshot { Name = "You", Stack = 5000, IsOccupied = true, Avatar = 7 },
            new SeatSnapshot { Name = "LaggingAgain", Stack = 2450, IsOccupied = true, IsBot = true },
            new SeatSnapshot { Name = null, Stack = 0 },
            new SeatSnapshot { Name = "A name that is far longer than twenty-four chars", Stack = 123456789012, IsOccupied = true, IsBusted = true, IsPendingNextHand = true, IsLeaving = true, IsAgent = true, Avatar = 19 },
            new SeatSnapshot { Name = "Ünïcødé ♠", Stack = 1, IsOccupied = true },
        };
        var legal = new LegalActions(true, false, true, 150, false, true, 300, 4850, true);
        var events = new List<(string, PokerEvent, int)>
        {
            ("HandStarted", new HandStartedEvent { HandNumber = 42, ButtonSeat = 3, SmallBlindSeat = 4, BigBlindSeat = 0, Seats = seats }, 7),
            ("BlindPosted", new BlindPostedEvent { Seat = 4, Amount = 25, IsSmallBlind = true, StackAfter = 4975, PotAfter = 25 }, 8),
            ("HoleCardsDealt", new HoleCardsDealtEvent { Seat = 1, Card0 = C("As"), Card1 = C("Td") }, 9),
            ("HoleCardsHidden", new HoleCardsDealtEvent { Seat = 2 }, 10),
            ("TurnStartedForYou", new TurnStartedEvent { Seat = 0, ForYou = true, TurnSeconds = 20f, Legal = legal }, 11),
            ("TurnStartedOther", new TurnStartedEvent { Seat = 5, ForYou = false, TurnSeconds = 19.25f }, 12),
            ("PlayerActed", new PlayerActedEvent { Seat = 2, Action = ActionType.Raise, Amount = 300, StackAfter = 4700, PotAfter = 375 }, 13),
            ("RoundChanged", new BettingRoundChangedEvent { Round = BettingRound.Turn }, 14),
            ("CommunityDealt", new CommunityDealtEvent { Round = BettingRound.Flop, NewCards = new[] { C("2c"), C("Kh"), C("9s") }, Board = new[] { C("2c"), C("Kh"), C("9s") } }, 15),
            ("Showdown", new ShowdownEvent { Entries = new[] { new ShowdownEntry { Seat = 1, Card0 = C("As"), Card1 = C("Ad"), Description = "Pair of Aces" }, new ShowdownEntry { Seat = 3, Card0 = C("7h"), Card1 = C("7d"), Description = "Three of a Kind, Sevens" } }, Board = new[] { C("2c"), C("Kh"), C("9s"), C("7c"), C("3d") } }, 16),
            ("PotAwarded", new PotAwardedEvent { Seat = 3, SeatName = "Bot 3", Amount = 1250, StackAfter = 6250, PotAfter = 0, Reason = "Main pot" }, 17),
            ("HandEnded", new HandEndedEvent { HandNumber = 42 }, 18),
            ("GameOver", new GameOverEvent { WinnerSeat = 3, WinnerName = "Bot 3" }, 19),
            ("TableRoster", new TableRosterEvent { Seats = seats }, 20),
            ("LobbyState", new LobbyStateEvent { Phase = TablePhase.Playing, YouAreOwner = true, YouJoinNextHand = false, YouCanBuyIn = true, AutoStart = true, SeatedCount = 5, MinToStart = 2, SeatCount = 8, ReadyCount = 4 }, 21),
            ("TableEconomy", new TableEconomyEvent { TableId = "t-0123456789abcdef0123", BuyInChips = 1000, SmallBlind = 25, BigBlind = 50, Halted = false }, 22),
            ("Reaction", new ReactionEvent { Seat = 6, ReactionId = 13 }, 23),
            ("VoiceState", new VoiceStateEvent { Seat = 2, IsTalking = true, IsMuted = true }, 24),
            ("TournamentStatus", new TournamentStatusEvent { Name = "Friday Freeroll", Phase = TournamentPhase.Running, MyState = TournamentPlayerState.Seated, MyTableId = 1, Entrants = 24, PlayersRemaining = 11, StartsInSeconds = 0, FirstPrize = 50000, SecondPrize = 20000,
                Tables = new[] { new TournamentTableLine { TableId = 0, Round = 1, IsDealing = true, PlayersLeft = 6, Level = 3, SmallBlind = 50, BigBlind = 100, SecondsToNextLevel = 87, DealInSeconds = 0 }, new TournamentTableLine { TableId = 1, Round = 1, IsFinal = true, IsClosed = true, IsSpedUp = true, PlayersLeft = 5, Level = 2, SmallBlind = 25, BigBlind = 50, SecondsToNextLevel = 70000, DealInSeconds = 12 } } }, -1),
            ("TournamentView", new TournamentViewEvent { TableId = 2, Round = 2, IsFinal = false, YourSeat = -1, CountdownSeconds = 15, Reason = TournamentViewReason.Watching }, -1),
            ("TournamentResult", new TournamentResultEvent { Finished = true, YouWon = false, YourPlace = 2, YourRound = 3, Entrants = 24, XpEarned = 350, YourPrize = 20000, ChampionName = "SilentFox901", RunnerUpName = "You", FirstPrize = 50000, SecondPrize = 20000 }, -1),
        };

        var sb = new StringBuilder();
        sb.Append("{\n  \"generatedBy\": \"web/src/core/events/__tests__/golden/Program.cs (real Assets/Scripts/Core/Events/PokerEventCodec.cs)\",\n  \"payloads\": {\n");
        for (int i = 0; i < events.Count; i++)
        {
            var (name, e, seq) = events[i];
            var bytes = PokerEventCodec.Encode(e, seq);
            sb.Append($"    \"{name}\": \"{Convert.ToHexString(bytes).ToLowerInvariant()}\"{(i < events.Count - 1 ? "," : "")}\n");
        }
        sb.Append("  },\n  \"tokenHash\": {\n");
        var tokens = new[] { "", "abc", "7f3e2b9c0d1a4e5f8a6b7c8d9e0f1a2b", "player-1#3" };
        for (int i = 0; i < tokens.Length; i++)
            sb.Append($"    \"{tokens[i]}\": \"{PokerTokenHash.Of(tokens[i])}\"{(i < tokens.Length - 1 ? "," : "")}\n");
        sb.Append("  }\n}\n");
        File.WriteAllText("codec-golden.json", sb.ToString());
        Console.WriteLine(sb.ToString());
    }
}
