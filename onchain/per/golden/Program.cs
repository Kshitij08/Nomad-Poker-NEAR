// Golden vectors for the on-chain Hold'em engine (M5), produced by the game's own C# Poker.Core.
// Writes three files into the directory given as the first argument:
//   eval.json  - random 5/6/7-card sets and HandEvaluator's result [category, t0..t4]
//   pots.json  - random contributions/statuses and SidePotCalculator's pots
//   hands.json - random cash-game hands played by PokerEngine with random legal actions: seats,
//                button, blinds, cards, every legal-action set offered, every action, every award
// Deterministic: fixed seeds, so the same Poker.Core always produces the same files.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Poker.Core;

static class Program
{
    static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "replay")
        {
            Console.WriteLine(Replay(File.ReadAllText(args[1])));
            return 0;
        }
        string dir = args.Length > 0 ? args[0] : ".";
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "eval.json"), EvalVectors(20_000));
        File.WriteAllText(Path.Combine(dir, "pots.json"), PotVectors(5_000));
        var (hands, stats) = HandVectors(3_000);
        File.WriteAllText(Path.Combine(dir, "hands.json"), hands);
        Console.WriteLine(stats);
        return 0;
    }

    // ------------------------------------------------------------------ evaluator

    static string EvalVectors(int n)
    {
        var rng = new Random(11);
        var sb = new StringBuilder("[\n");
        for (int i = 0; i < n; i++)
        {
            int k = i % 10 == 0 ? 5 : i % 10 == 1 ? 6 : 7;
            var cards = Enumerable.Range(0, 52).OrderBy(_ => rng.Next()).Take(k).Select(Card.FromIndex).ToList();
            // Bias some sets towards made hands so every category is well covered.
            if (i % 4 == 0) cards = Biased(rng, k);
            var v = HandEvaluator.Evaluate(cards);
            sb.Append($"[[{string.Join(",", cards.Select(c => c.Index))}],[{(int)v.Category},{v.T0},{v.T1},{v.T2},{v.T3},{v.T4}]]");
            sb.Append(i + 1 < n ? ",\n" : "\n");
        }
        return sb.Append("]\n").ToString();
    }

    // Few ranks or one suit, so pairs/trips/quads/full houses/flushes/straights appear often.
    static List<Card> Biased(Random rng, int k)
    {
        var pool = new List<int>();
        if (rng.Next(2) == 0)
        {
            int lo = rng.Next(0, 9); // ranks lo..lo+4 (index in 0..12), all suits
            for (int s = 0; s < 4; s++) for (int r = lo; r < lo + 5; r++) pool.Add(s * 13 + r);
            if (rng.Next(3) == 0) { pool.AddRange(new[] { 12, 25, 38, 51 }); } // aces, for wheels
        }
        else
        {
            int s = rng.Next(4);
            for (int r = 0; r < 13; r++) pool.Add(s * 13 + r);
            for (int x = 0; x < 6; x++) pool.Add(rng.Next(52));
        }
        return pool.Distinct().OrderBy(_ => rng.Next()).Take(k).Select(Card.FromIndex).ToList();
    }

    // ------------------------------------------------------------------ side pots

    static string PotVectors(int n)
    {
        var rng = new Random(22);
        var sb = new StringBuilder("[\n");
        for (int i = 0; i < n; i++)
        {
            int seats = rng.Next(2, 10);
            var ps = new List<PlayerState>();
            for (int s = 0; s < seats; s++)
            {
                var st = (PlayerStatus)new[] { 0, 2, 2, 3, 4, 4 }[rng.Next(6)]; // Empty, Active, Folded, AllIn
                long committed = st == PlayerStatus.Empty ? 0 : rng.Next(4) == 0 ? rng.Next(1, 5) * 100 : rng.Next(0, 1000);
                ps.Add(new PlayerState { SeatIndex = s, Status = st, TotalCommitted = committed });
            }
            var pots = SidePotCalculator.Build(ps);
            sb.Append("{\"seats\":[");
            sb.Append(string.Join(",", ps.Select(p => $"[{(int)p.Status},{p.TotalCommitted}]")));
            sb.Append("],\"pots\":[");
            sb.Append(string.Join(",", pots.Select(p => $"[{p.Amount},[{string.Join(",", p.EligibleSeats)}]]")));
            sb.Append("]}");
            sb.Append(i + 1 < n ? ",\n" : "\n");
        }
        return sb.Append("]\n").ToString();
    }

    // ------------------------------------------------------------------ whole hands

    static (string, string) HandVectors(int target)
    {
        var rng = new Random(33);
        var sb = new StringBuilder("[\n");
        int written = 0, showdowns = 0, sidePots = 0, allIns = 0, headsUp = 0, splits = 0, illegalTried = 0;
        int game = 0;
        while (written < target)
        {
            game++;
            int seatCount = rng.Next(2, 10);
            long smallBlind = rng.Next(1, 51);
            long bigBlind = smallBlind * rng.Next(1, 4);
            var engine = new PokerEngine(new TableConfig { SeatCount = seatCount, SmallBlind = smallBlind, BigBlind = bigBlind }, new SeededRandom(1000 + game));
            var occupied = Enumerable.Range(0, seatCount).Where(_ => rng.Next(4) != 0).ToList();
            if (occupied.Count < 2) occupied = new List<int> { 0, seatCount - 1 };
            foreach (int s in occupied)
            {
                long stack = rng.Next(5) == 0 ? rng.Next(1, (int)bigBlind * 3 + 1) : bigBlind * rng.Next(5, 200);
                engine.SeatPlayer(s, $"p{s}", $"p{s}", false, stack);
            }

            for (int h = 0; h < 6 && written < target && engine.CountFundedPlayers() >= 2; h++)
            {
                var t = engine.Table;
                var before = t.Seats.Select(p => (p.IsOccupied && p.Status != PlayerStatus.Busted) ? p.Stack : -1L).ToArray();
                int buttonBefore = t.ButtonSeat;
                var holes = new Dictionary<int, int[]>();
                var board = new List<int>();
                var steps = new List<string>();
                var awards = new List<string>();
                int button = -1, sbSeat = -1, bbSeat = -1;
                bool sawAllIn = false;
                void OnEvent(PokerEvent e)
                {
                    switch (e)
                    {
                        case HandStartedEvent hs: button = hs.ButtonSeat; sbSeat = hs.SmallBlindSeat; bbSeat = hs.BigBlindSeat; break;
                        case HoleCardsDealtEvent hc: holes[hc.Seat] = new[] { hc.Card0.Index, hc.Card1.Index }; break;
                        case CommunityDealtEvent cd: board.AddRange(cd.NewCards.Select(c => c.Index)); break;
                        case PotAwardedEvent pa: awards.Add($"[{pa.Seat},{pa.Amount}]"); break;
                    }
                }
                engine.Events += OnEvent;
                engine.StartHand();
                while (engine.HandInProgress)
                {
                    int seat = engine.AwaitingActionSeat;
                    var l = engine.CurrentLegalActions;
                    // Sometimes try an illegal action first: the C# engine must reject it (and so
                    // must the Rust one), leaving the hand unchanged.
                    if (rng.Next(8) == 0 && Illegal(rng, l, out var bad))
                    {
                        bool rejected = false;
                        try { engine.SubmitAction(seat, bad); } catch (InvalidOperationException) { rejected = true; }
                        if (!rejected) throw new Exception($"C# accepted an action chosen as illegal: {bad}");
                        illegalTried++;
                        steps.Add($"[{seat},{B(l.CanFold)},{B(l.CanCheck)},{B(l.CanCall)},{l.CallAmount},{B(l.CanBet)},{B(l.CanRaise)},{l.MinRaiseTo},{l.MaxRaiseTo},{B(l.CanAllIn)},{(int)bad.Type},{bad.Amount},1]");
                    }
                    var a = Choose(rng, l);
                    if (a.Type == ActionType.AllIn) sawAllIn = true;
                    steps.Add($"[{seat},{B(l.CanFold)},{B(l.CanCheck)},{B(l.CanCall)},{l.CallAmount},{B(l.CanBet)},{B(l.CanRaise)},{l.MinRaiseTo},{l.MaxRaiseTo},{B(l.CanAllIn)},{(int)a.Type},{a.Amount},0]");
                    engine.SubmitAction(seat, a);
                }
                engine.Events -= OnEvent;
                var after = t.Seats.Select(p => p.IsOccupied ? p.Stack : -1L).ToArray();

                int inHandAtEnd = t.Seats.Count(p => p.IsInHand);
                if (inHandAtEnd > 1) showdowns++;
                if (awards.Count > 1) splits++;
                if (sawAllIn || t.Seats.Any(p => p.Status == PlayerStatus.AllIn)) allIns++;
                if (holes.Count == 2) headsUp++;
                if (SidePotCalculator.Build(t.Seats).Count > 1 || awards.Count > 2) sidePots++;

                sb.Append("{");
                sb.Append($"\"seatCount\":{seatCount},\"sb\":{smallBlind},\"bb\":{bigBlind},\"buttonBefore\":{buttonBefore},");
                sb.Append($"\"before\":[{string.Join(",", before)}],\"button\":{button},\"sbSeat\":{sbSeat},\"bbSeat\":{bbSeat},");
                sb.Append($"\"holes\":[{string.Join(",", Enumerable.Range(0, seatCount).Select(s => holes.TryGetValue(s, out var c) ? $"[{c[0]},{c[1]}]" : "null"))}],");
                sb.Append($"\"board\":[{string.Join(",", board)}],");
                sb.Append($"\"steps\":[{string.Join(",", steps)}],");
                sb.Append($"\"awards\":[{string.Join(",", awards)}],");
                sb.Append($"\"after\":[{string.Join(",", after)}]");
                sb.Append("}");
                written++;
                sb.Append(written < target ? ",\n" : "\n");
            }
        }
        sb.Append("]\n");
        return (sb.ToString(), $"hands={written} games={game} showdowns={showdowns} multiAward={splits} sidePotHands={sidePots} allInHands={allIns} headsUp={headsUp} illegalTried={illegalTried}");
    }

    static int B(bool b) => b ? 1 : 0;

    // An action the legal set forbids: a check facing a bet, a call or raise with nothing to call,
    // a bet or raise outside [min, max], an all-in when barred.
    static bool Illegal(Random rng, LegalActions l, out PlayerAction a)
    {
        var options = new List<PlayerAction>();
        if (!l.CanCheck) options.Add(PlayerAction.Check());
        if (!l.CanCall) options.Add(PlayerAction.Call());
        if (!l.CanBet) options.Add(PlayerAction.Bet(l.MaxRaiseTo));
        if (!l.CanRaise) options.Add(PlayerAction.Raise(l.MaxRaiseTo));
        if (l.CanBet && l.MinRaiseTo > 1) options.Add(PlayerAction.Bet(l.MinRaiseTo - 1));
        if (l.CanRaise && l.MinRaiseTo > 1) options.Add(PlayerAction.Raise(l.MinRaiseTo - 1));
        if (l.CanBet) options.Add(PlayerAction.Bet(l.MaxRaiseTo + 1));
        if (l.CanRaise) options.Add(PlayerAction.Raise(l.MaxRaiseTo + 1));
        if (!l.CanAllIn) options.Add(PlayerAction.AllIn());
        a = options.Count > 0 ? options[rng.Next(options.Count)] : default;
        return options.Count > 0;
    }

    // ------------------------------------------------------------------ replay of an on-chain hand

    // Replays one hand played by the on-chain program through this C# engine and prints the final
    // stacks and awards. Input JSON: seatCount, sb, bb, button, stacks (per seat, -1 = not dealt in),
    // holes (per seat, [c0,c1] or null), board (5 cards), actions ([seat, type, amount], blinds
    // excluded). The C# engine shuffles with an IRandom; this one is fed the swap choices that make
    // its Fisher-Yates produce a deck that deals exactly the on-chain cards (C# deals two cards to
    // each seat in seat order, then burn/flop/burn/turn/burn/river).
    static string Replay(string json)
    {
        var doc = System.Text.Json.JsonDocument.Parse(json).RootElement;
        int seatCount = doc.GetProperty("seatCount").GetInt32();
        long sbAmt = doc.GetProperty("sb").GetInt64(), bbAmt = doc.GetProperty("bb").GetInt64();
        int button = doc.GetProperty("button").GetInt32();
        var stacks = doc.GetProperty("stacks").EnumerateArray().Select(x => x.GetInt64()).ToArray();
        var holes = doc.GetProperty("holes").EnumerateArray().Select(x => x.ValueKind == System.Text.Json.JsonValueKind.Null ? null : x.EnumerateArray().Select(c => c.GetInt32()).ToArray()).ToArray();
        var board = doc.GetProperty("board").EnumerateArray().Select(x => x.GetInt32()).ToArray();

        // The deck C# must deal: holes in seat order, then burn, 3, burn, 1, burn, 1, then the rest.
        var target = new List<int>();
        for (int s = 0; s < seatCount; s++) if (stacks[s] > 0) target.AddRange(holes[s]);
        var rest = Enumerable.Range(0, 52).Where(c => !target.Contains(c) && !board.Contains(c)).ToList();
        int r = 0;
        target.Add(rest[r++]); target.AddRange(board.Take(3)); target.Add(rest[r++]); target.Add(board[3]); target.Add(rest[r++]); target.Add(board[4]);
        target.AddRange(rest.Skip(r));
        // Inverse Fisher-Yates: the j chosen at each step i (51..1) that yields `target`.
        var arr = Enumerable.Range(0, 52).ToList();
        var picks = new Queue<int>();
        for (int i = 51; i >= 1; i--)
        {
            int j = arr.IndexOf(target[i]);
            picks.Enqueue(j);
            (arr[i], arr[j]) = (arr[j], arr[i]);
        }

        var engine = new PokerEngine(new TableConfig { SeatCount = seatCount, SmallBlind = sbAmt, BigBlind = bbAmt }, new ScriptedRandom(picks));
        for (int s = 0; s < seatCount; s++) if (stacks[s] > 0) engine.SeatPlayer(s, $"p{s}", $"p{s}", false, stacks[s]);
        engine.Table.ButtonSeat = (button - 1 + seatCount) % seatCount; // so the button moves onto `button`
        var awards = new List<string>();
        engine.Events += e => { if (e is PotAwardedEvent pa) awards.Add($"[{pa.Seat},{pa.Amount}]"); };
        engine.StartHand();
        string problem = engine.Table.ButtonSeat != button ? $"button {engine.Table.ButtonSeat} != {button}" : null;
        foreach (var a in doc.GetProperty("actions").EnumerateArray())
        {
            int seat = a[0].GetInt32();
            if (!engine.HandInProgress || engine.AwaitingActionSeat != seat) { problem ??= $"seat {seat} wasn't awaited (awaiting {engine.AwaitingActionSeat})"; break; }
            try { engine.SubmitAction(seat, new PlayerAction((ActionType)a[1].GetInt32(), a[2].GetInt64())); }
            catch (Exception ex) { problem ??= $"seat {seat}: {ex.Message}"; break; }
        }
        if (engine.HandInProgress) problem ??= "hand still in progress after the actions";
        var final = engine.Table.Seats.Select(p => p.IsOccupied ? p.Stack : -1L);
        var holesDealt = engine.Table.Seats.Select(p => p.HoleCards.Count == 2 ? $"[{p.HoleCards[0].Index},{p.HoleCards[1].Index}]" : "null");
        return $"{{\"final\":[{string.Join(",", final)}],\"awards\":[{string.Join(",", awards)}],\"board\":[{string.Join(",", engine.Community.Select(c => c.Index))}],\"holes\":[{string.Join(",", holesDealt)}],\"problem\":{(problem == null ? "null" : "\"" + problem.Replace("\"", "'") + "\"")}}}";
    }

    sealed class ScriptedRandom : IRandom
    {
        private readonly Queue<int> _picks;
        public ScriptedRandom(Queue<int> picks) => _picks = picks;
        public int Next(int maxExclusive) => _picks.Dequeue();
    }

    // A random legal action: mostly check/call, regular bets and raises (min, max, or in between),
    // some folds and shoves.
    static PlayerAction Choose(Random rng, LegalActions l)
    {
        for (int tries = 0; tries < 50; tries++)
        {
            int roll = rng.Next(100);
            if (roll < 12 && l.CanFold && !l.CanCheck) return PlayerAction.Fold();
            if (roll < 55)
            {
                if (l.CanCheck) return PlayerAction.Check();
                if (l.CanCall) return PlayerAction.Call();
            }
            if (roll < 85 && (l.CanBet || l.CanRaise))
            {
                long amt = rng.Next(3) switch
                {
                    0 => l.MinRaiseTo,
                    1 => l.MaxRaiseTo,
                    _ => l.MinRaiseTo + (long)(rng.NextDouble() * (l.MaxRaiseTo - l.MinRaiseTo)),
                };
                return l.CanBet ? PlayerAction.Bet(amt) : PlayerAction.Raise(amt);
            }
            if (l.CanAllIn) return PlayerAction.AllIn();
        }
        return l.CanCheck ? PlayerAction.Check() : PlayerAction.Fold();
    }
}
