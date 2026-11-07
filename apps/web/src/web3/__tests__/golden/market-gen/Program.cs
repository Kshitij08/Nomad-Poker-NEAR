using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Poker.Per.Generated;

// Golden vectors for web/src/web3/__tests__/solCopy.test.ts (the copied marketplace SOL strategy).
static class Program
{
    // ---------------------------------------------------------------- AgentStrategyState (the parts ApplyAll stores)
    const int BrainClassic = 0, BrainSmart = 2;
    static float[] Values = new float[5];
    static float PositionWeight;
    static int Brain = BrainSmart;
    static float[][] Streets = new float[4][];
    static bool HasStreets { get { foreach (var s in Streets) if (s != null) return true; return false; } }

    // NomadStrategyPanel.cs AgentStrategyState.ApplyAll (without Save / Changed).
    static void ApplyAll(int style, float[] values, float positionWeight, int brain, float[][] streets)
    {
        Values = (float[])values.Clone();
        PositionWeight = Math.Clamp(positionWeight, 0f, 1f);
        Brain = brain == BrainSmart ? BrainSmart : BrainClassic;
        Streets = new float[4][];
        for (int i = 0; streets != null && i < 4 && i < streets.Length; i++)
            Streets[i] = streets[i] != null && streets[i].Length >= 5 ? (float[])streets[i].Clone() : null;
    }

    // ---------------------------------------------------------------- NomadUiHost.Market.cs (verbatim)
    static float[] ValuesOf(JObject p) => new[]
    {
        (float)p["foldBelow"], (float)p["raiseAbove"], (float)p["aggression"], (float)p["bluffChance"], (float)p["raiseFractionOfPot"],
    };

    static void ApplyProfile(JObject p)
    {
        var streets = new float[4][];
        string[] keys = { "preflop", "flop", "turn", "river" };
        var st = p["streets"] as JObject;
        for (int i = 0; st != null && i < 4; i++)
            if (st[keys[i]] is JObject o) streets[i] = ValuesOf(o);
        float pw = p["positionWeight"]?.Type == JTokenType.Float || p["positionWeight"]?.Type == JTokenType.Integer ? (float)p["positionWeight"] : 0f;
        int brain = p["brain"]?.Type == JTokenType.Integer && (int)p["brain"] == 2 ? BrainSmart : BrainClassic;
        ApplyAll(3, ValuesOf(p), pw, brain, streets);
    }

    // ---------------------------------------------------------------- NomadUiHost.Onchain.cs SolProfile (verbatim)
    static JObject SolProfile(float[] v)
    {
        var p = new JObject { ["foldBelow"] = v[0], ["raiseAbove"] = v[1], ["aggression"] = v[2], ["bluffChance"] = v[3], ["raiseFractionOfPot"] = v[4] };
        if (PositionWeight > 0f) p["positionWeight"] = PositionWeight;
        if (Brain == BrainSmart) p["brain"] = 2;
        if (HasStreets)
        {
            string[] keys = { "preflop", "flop", "turn", "river" };
            var streets = new JObject();
            for (int i = 0; i < 4; i++)
            {
                var s = Streets[i];
                if (s != null) streets[keys[i]] = new JObject { ["foldBelow"] = s[0], ["raiseAbove"] = s[1], ["aggression"] = s[2], ["bluffChance"] = s[3], ["raiseFractionOfPot"] = s[4] };
            }
            p["streets"] = streets;
        }
        return p;
    }

    sealed class SolCopy { public string Id, Name, Creator; public int CreatorFeeBps, PlatformFeeBps; }

    static string Pct(int bps) => (bps / 100.0).ToString("0.#", CultureInfo.InvariantCulture);

    static string Hex(byte[] b) => BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
    static byte[] Fill(byte v) { var b = new byte[32]; for (int i = 0; i < 32; i++) b[i] = v; return b; }

    static void Main(string[] args)
    {
        var o = new JObject();

        // agent_set with a copied strategy's terms, and with none (the player's own strategy / stop).
        var sets = new JArray();
        void Set(long expires, byte agent, long until, ulong stake, byte? creator, int cbps, int pbps)
        {
            var terms = creator == null ? new FeeTerms { Creator = new byte[32] }
                : new FeeTerms { Creator = Fill(creator.Value), CreatorFeeBps = (ushort)cbps, PlatformFeeBps = (ushort)pbps }; // PerAgent.Terms / NoTerms
            sets.Add(new JObject
            {
                ["expires"] = expires.ToString(CultureInfo.InvariantCulture), ["agentFill"] = agent, ["until"] = until.ToString(CultureInfo.InvariantCulture),
                ["stake"] = stake.ToString(CultureInfo.InvariantCulture), ["creatorFill"] = creator == null ? null : (JToken)creator.Value,
                ["creatorFeeBps"] = cbps, ["platformFeeBps"] = pbps,
                ["hex"] = Hex(Ix.AgentSet(expires, Fill(agent), until, stake, terms)),
            });
        }
        Set(1_850_000_000, 4, 1_860_000_000, 2_500_000, 8, 800, 200);
        Set(1_850_000_000, 4, 1_860_003_600, 25_000_000, 9, 1250, 250);
        Set(1_850_000_000, 4, 1_860_000_000, 2_500_000, null, 0, 0);
        Set(1_850_000_000, 0, 0, 0, null, 0, 0); // PerAgent.Stop
        o["agentSet"] = sets;

        // The dialogs' "{bps / 100.0:0.#}%".
        var pct = new JObject();
        for (int b = 0; b <= 2000; b++) pct[b.ToString(CultureInfo.InvariantCulture)] = Pct(b);
        foreach (int b in new[] { 2345, 2500, 5000, 9999, 10000, 65535 }) pct[b.ToString(CultureInfo.InvariantCulture)] = Pct(b);
        o["feePercent"] = pct;

        // A marketplace profile copied (ApplyProfile) and sent back to the Agent service (SolProfile), as Newtonsoft writes it.
        string[] inputs =
        {
            "{\"foldBelow\":0.35,\"raiseAbove\":0.58,\"aggression\":0.45,\"bluffChance\":0.03,\"raiseFractionOfPot\":0.6}",
            "{\"foldBelow\":0.3,\"raiseAbove\":0.7,\"aggression\":0.5,\"bluffChance\":0.1,\"raiseFractionOfPot\":0.5,\"positionWeight\":0.25,\"brain\":2," +
                "\"streets\":{\"preflop\":{\"foldBelow\":0.1,\"raiseAbove\":0.55,\"aggression\":0.6,\"bluffChance\":0.05,\"raiseFractionOfPot\":0.6}," +
                "\"river\":{\"foldBelow\":0.5,\"raiseAbove\":0.7,\"aggression\":0.45,\"bluffChance\":0,\"raiseFractionOfPot\":0.5}}}",
            "{\"foldBelow\":0,\"raiseAbove\":1,\"aggression\":0.123456789,\"bluffChance\":0.1,\"raiseFractionOfPot\":0.7,\"positionWeight\":1.5,\"brain\":1," +
                "\"streets\":{\"flop\":{\"foldBelow\":0.2,\"raiseAbove\":0.8,\"aggression\":0.33,\"bluffChance\":0.07,\"raiseFractionOfPot\":0.75}}}",
            "{\"foldBelow\":0.42,\"raiseAbove\":0.66,\"aggression\":0.9,\"bluffChance\":0.2,\"raiseFractionOfPot\":1.1,\"positionWeight\":0,\"brain\":2}",
        };
        var profiles = new JArray();
        foreach (var json in inputs)
        {
            ApplyProfile(JObject.Parse(json));
            profiles.Add(new JObject { ["input"] = json, ["solProfile"] = SolProfile(Values).ToString(Formatting.None) });
        }
        o["profiles"] = profiles;

        // Copy (ONCHAIN) and OnchainDeployOrStop's lines.
        var msgs = new JArray();
        foreach (var c in new[]
        {
            new SolCopy { Id = "0b7d9c4e-1f2a-4c3b-9d8e-7f6a5b4c3d2e", Name = "Tight & Steady", Creator = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR", CreatorFeeBps = 800, PlatformFeeBps = 200 },
            new SolCopy { Id = "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9", Name = "River Rat", Creator = "4Nd1mYzFjQ8Wq3n1s8Ho3yGkKfCZ1uHvTfJ2uGzRrJ9v", CreatorFeeBps = 1250, PlatformFeeBps = 250 },
        })
        {
            string _copiedName = c.Name, creatorName = "Alice";
            msgs.Add(new JObject
            {
                ["name"] = c.Name, ["creator"] = c.Creator, ["creatorFeeBps"] = c.CreatorFeeBps, ["platformFeeBps"] = c.PlatformFeeBps, ["creatorName"] = creatorName,
                ["ownTitle"] = "Running " + _copiedName,
                ["ownBody"] = $"Your next SOL Agent plays your own \"{_copiedName}\", with no fee. Its sessions build the record others need before they can copy it. Deploy it from Overview.",
                ["copyTitle"] = "Copying " + _copiedName,
                ["copyBody"] = $"Your next SOL Agent plays \"{_copiedName}\" by {creatorName}. Deploy it from Overview: your play key then agrees, on chain, " +
                    $"to pay {c.CreatorFeeBps / 100.0:0.#}% of new profit to the creator and {c.PlatformFeeBps / 100.0:0.#}% to Nomad whenever its seat cashes out, even if you take the seat back yourself (never on losses). Changing the sliders stops copying.",
                ["busy"] = $"Setting your Agent on chain with \"{c.Name}\"'s fees ({c.CreatorFeeBps / 100.0:0.#}% + {c.PlatformFeeBps / 100.0:0.#}% of new profit; your play key signs)…",
                ["deployedSuffix"] = $" It plays \"{c.Name}\"; the creator and Nomad get their share of new profit at each cash-out.",
            });
        }
        o["messages"] = msgs;

        string text = o.ToString(Formatting.Indented) + "\n";
        if (args.Length > 0) File.WriteAllText(args[0], text);
        else Console.Write(text);
    }
}
