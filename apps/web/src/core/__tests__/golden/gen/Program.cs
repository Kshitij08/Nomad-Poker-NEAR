using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using Poker.Bots;
using Poker.Core;

// Golden vectors from the real Unity C# sources (Core + Bots), for web/src/core/__tests__/parity.test.ts.
static class Program
{
    static string Cards(IEnumerable<Card> cs) => string.Join("", cs.Select(c => c.Short));
    static string B(bool b) => b ? "1" : "0";
    static string Legal(LegalActions l) => $"{B(l.CanFold)}{B(l.CanCheck)}{B(l.CanCall)}:{l.CallAmount}:{B(l.CanBet)}{B(l.CanRaise)}:{l.MinRaiseTo}:{l.MaxRaiseTo}:{B(l.CanAllIn)}";

    static string Ser(PokerEvent e) => e switch
    {
        HandStartedEvent h => $"HS {h.HandNumber} b{h.ButtonSeat} s{h.SmallBlindSeat} B{h.BigBlindSeat} " + string.Join(",", h.Seats.Select(s => $"{s.Name}:{s.Stack}:{B(s.IsOccupied)}{B(s.IsBusted)}{B(s.IsBot)}")),
        BlindPostedEvent b => $"BP {b.Seat} {b.Amount} {B(b.IsSmallBlind)} {b.StackAfter} {b.PotAfter}",
        HoleCardsDealtEvent c => $"HC {c.Seat} {c.Card0.Short}{c.Card1.Short}",
        ActionRequestedEvent a => $"AR {a.Seat} {Legal(a.Legal)}",
        PlayerActedEvent p => $"PA {p.Seat} {p.Action} {p.Amount} {p.StackAfter} {p.PotAfter}",
        BettingRoundChangedEvent r => $"RC {r.Round}",
        CommunityDealtEvent d => $"CD {d.Round} {Cards(d.NewCards)}|{Cards(d.Board)}",
        ShowdownEvent s => "SD " + string.Join(";", s.Entries.Select(x => $"{x.Seat}:{x.Card0.Short}{x.Card1.Short}:{x.Description}")),
        PotAwardedEvent w => $"PW {w.Seat} {w.SeatName} {w.Amount} {w.StackAfter} {w.PotAfter} {w.Reason}",
        HandEndedEvent he => $"HE {he.HandNumber}",
        GameOverEvent g => $"GO {g.WinnerSeat} {g.WinnerName}",
        _ => "??"
    };

    static List<string> Simulate(int seed, long[] stacks, Func<int, IPokerBot> makeBot, int maxHands, long sb, long bb)
    {
        var log = new List<string>();
        int n = stacks.Length;
        var engine = new PokerEngine(new TableConfig { SeatCount = n, SmallBlind = sb, BigBlind = bb, StartingStack = 5000 }, new SeededRandom(seed));
        engine.Events += e => log.Add(Ser(e));
        var bots = new Dictionary<int, IPokerBot>();
        for (int s = 0; s < n; s++)
        {
            if (stacks[s] < 0) continue; // empty seat
            engine.SeatPlayer(s, $"bot{s}", s == 0 ? "You" : $"Bot {s}", s != 0, stacks[s]);
            bots[s] = makeBot(s);
        }
        for (int h = 0; h < maxHands && engine.CountFundedPlayers() >= 2; h++)
        {
            engine.StartHand();
            while (engine.HandInProgress)
            {
                int seat = engine.AwaitingActionSeat;
                var p = engine.Table.Seats[seat];
                var ctx = new BotContext
                {
                    SeatIndex = seat, HoleCards = p.HoleCards, Community = engine.Table.Community, Round = engine.Table.Round,
                    Pot = engine.Table.Pot, MyStack = p.Stack, MyCurrentBet = p.CurrentBet, BigBlind = engine.Table.BigBlind,
                    OpponentsInHand = engine.CountInHand() - 1,
                    Position = BotContext.PositionOf(engine.Table.ButtonSeat, seat, engine.Table.SeatCount),
                    Legal = engine.CurrentLegalActions
                };
                var a = bots[seat].Decide(ctx);
                log.Add($"DE {seat} {a.Type} {a.Amount}");
                engine.SubmitAction(seat, a);
            }
        }
        return log;
    }

    static string R(double d) => d.ToString("R", CultureInfo.InvariantCulture);
    static string R(float f) => ((double)f).ToString("R", CultureInfo.InvariantCulture);

    static void Main(string[] args)
    {
        var sb = new StringBuilder();
        sb.Append("{\n");

        sb.Append("\"random\": {");
        int[] seeds = { 0, 1, 42, 12345, -7, int.MinValue, int.MaxValue };
        sb.Append(string.Join(",", seeds.Select(s =>
        {
            var r = new Random(s);
            var nx = Enumerable.Range(0, 5).Select(_ => r.Next().ToString());
            var n52 = Enumerable.Range(0, 5).Select(_ => r.Next(52).ToString());
            var nd = Enumerable.Range(0, 3).Select(_ => R(r.NextDouble()));
            return $"\"{s}\": {{\"next\": [{string.Join(",", nx)}], \"next52\": [{string.Join(",", n52)}], \"nextDouble\": [{string.Join(",", nd)}]}}";
        })));
        sb.Append("},\n");

        sb.Append("\"deck\": {");
        sb.Append(string.Join(",", new[] { 7, 12345 }.Select(s =>
        {
            var d = new Deck(); d.Shuffle(new SeededRandom(s));
            var idx = Enumerable.Range(0, 52).Select(_ => d.Deal().Index.ToString());
            return $"\"{s}\": [{string.Join(",", idx)}]";
        })));
        sb.Append("},\n");

        sb.Append("\"personality\": {");
        sb.Append(string.Join(",", new[] { 0, 1, 12446, 999 }.Select(s =>
        {
            var p = new HeuristicBot(s).Profile;
            return $"\"{s}\": [{R(p.FoldBelow)},{R(p.RaiseAbove)},{R(p.Aggression)},{R(p.BluffChance)},{R(p.RaiseFractionOfPot)}]";
        })));
        sb.Append("},\n");

        var hs = new List<string>();
        var rr = new Random(5);
        for (int i = 0; i < 200; i++)
        {
            var deck = Enumerable.Range(0, 52).OrderBy(_ => rr.Next()).Select(Card.FromIndex).ToList();
            int boardLen = new[] { 0, 3, 4, 5 }[i % 4];
            var hole = deck.Take(2).ToList();
            var board = deck.Skip(2).Take(boardLen).ToList();
            float v = HandStrength.Estimate(hole, board);
            hs.Add($"[\"{Cards(hole)}\",\"{Cards(board)}\",{R(v)}]");
        }
        sb.Append("\"handStrength\": [" + string.Join(",", hs) + "],\n");

        var names = new[] { "You", "Bot 1", "Bot 2", "Bot 3", "Bot 4", "Bot 5", "Bot 6", "Bot 7", "LaggingAgain", "x" };
        sb.Append("\"avatarFallback\": {" + string.Join(",", names.Select(n => $"\"{n}\": {AvatarCatalog.FallbackFor(n)}")) + "},\n");

        var classic = Simulate(12345, new long[] { 5000, 5000, 5000, 5000, 5000, 5000, 5000 }, s => new HeuristicBot(12345 + s * 101), 60, 25, 50);
        var shorty = Simulate(7, new long[] { 300, 120, 900, -1, 75, 2000 }, s => new HeuristicBot(100 + s), 200, 25, 50);
        var v2 = Simulate(99, new long[] { 2000, 2000, 1500, 800 }, s =>
        {
            var p = BotProfile.FromPreset(s % 2 == 0 ? "aggressive" : "conservative");
            p.Brain = BotProfile.BrainV2;
            p.PositionWeight = 0.5f;
            return new HeuristicBot(p, 500 + s);
        }, 40, 10, 20);
        string J(List<string> l) => "[" + string.Join(",\n", l.Select(x => "\"" + x.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"")) + "]";
        sb.Append("\"simClassic7\": " + J(classic) + ",\n");
        sb.Append("\"simShortStacks\": " + J(shorty) + ",\n");
        sb.Append("\"simBrainV2\": " + J(v2) + "\n");
        sb.Append("}\n");
        File.WriteAllText(args[0], sb.ToString());
        Console.WriteLine($"classic {classic.Count} lines, short {shorty.Count}, v2 {v2.Count}");
    }
}
