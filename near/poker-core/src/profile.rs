//! An agent's strategy: the Nomad app's Strategy tab settings (`packages/engine/src/agents/agentStrategyState.ts`).
//!
//! Five numbers, each in hundredths so they are exact everywhere (the app's editor snaps to two decimals):
//!
//! | Field | App name | Range | Meaning |
//! | --- | --- | --- | --- |
//! | `fold_below` | Fold below (Calling bets) | 10 to 55 | Gives up weaker hands facing a bet; lower calls more. |
//! | `raise_above` | Raise above (Hands it plays) | 45 to 90 | Bets or raises for value above this; lower plays more hands. |
//! | `aggression` | Aggression (Raise vs call) | 10 to 95 | With a good hand, how often it raises instead of calling. |
//! | `bluff_chance` | Bluff chance | 0 to 25 | How often it bets a weak hand. |
//! | `raise_size` | Raise size | 30 to 120 | Bet size on top of the minimum, as a share of the pot. |
//!
//! Plus `position_weight` (0 to 100: how much a late seat loosens play and an early one tightens it) and optional
//! per-street overrides `streets` ([preflop, flop, turn, river], each null or its own five numbers). The ranges are the
//! engine's `BotProfile.clamped`.
//!
//! The first agents had two numbers, `{tight, aggro}`. They still parse ([`AnyProfile`]) and play as the v2 profile
//! [`Profile::from_legacy`] maps them to.

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

pub const MIN: [u8; 5] = [10, 45, 10, 0, 30];
pub const MAX: [u8; 5] = [55, 90, 95, 25, 120];
const NAMES: [&str; 5] = ["fold_below", "raise_above", "aggression", "bluff_chance", "raise_size"];
pub const MAX_STYLE_LEN: usize = 24;

/// One set of the five numbers (hundredths).
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Numbers {
    pub fold_below: u8,
    pub raise_above: u8,
    pub aggression: u8,
    pub bluff_chance: u8,
    pub raise_size: u8,
}

impl Numbers {
    pub const fn new(v: [u8; 5]) -> Self {
        Numbers { fold_below: v[0], raise_above: v[1], aggression: v[2], bluff_chance: v[3], raise_size: v[4] }
    }
    pub fn as_array(&self) -> [u8; 5] {
        [self.fold_below, self.raise_above, self.aggression, self.bluff_chance, self.raise_size]
    }
    pub fn validate(&self) -> Result<(), String> {
        for (i, v) in self.as_array().iter().enumerate() {
            if *v < MIN[i] || *v > MAX[i] {
                return Err(format!("{} must be {} to {} (hundredths), got {v}", NAMES[i], MIN[i], MAX[i]));
            }
        }
        Ok(())
    }
}

/// A v2 strategy profile.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Profile {
    pub fold_below: u8,
    pub raise_above: u8,
    pub aggression: u8,
    pub bluff_chance: u8,
    pub raise_size: u8,
    /// 0 to 100.
    #[cfg_attr(feature = "serde", serde(default))]
    pub position_weight: u8,
    /// Empty (no overrides) or exactly four entries: [preflop, flop, turn, river], null to play the main numbers.
    #[cfg_attr(feature = "serde", serde(default))]
    pub streets: Vec<Option<Numbers>>,
    /// The app's style name ("Autopilot", "Custom", ...), for display only; it does not change play.
    #[cfg_attr(feature = "serde", serde(default, skip_serializing_if = "Option::is_none"))]
    pub style: Option<String>,
}

/// What a request or record may carry: a v2 profile or a first-generation `{tight, aggro}` one.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize), serde(untagged))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AnyProfile {
    V2(Profile),
    Legacy { tight: u8, aggro: u8 },
}

impl AnyProfile {
    pub fn into_v2(self) -> Profile {
        match self {
            AnyProfile::V2(p) => p,
            AnyProfile::Legacy { tight, aggro } => Profile::from_legacy(tight, aggro),
        }
    }
}

/// The app's STRATEGY_PRESETS and STRATEGY_PRESET_STREETS, in hundredths.
pub const PRESETS: [(&str, [u8; 5]); 4] = [
    ("Autopilot", [35, 58, 45, 3, 60]),
    ("Guardian", [40, 60, 25, 2, 45]),
    ("Trapper", [30, 52, 15, 0, 60]),
    ("Daredevil", [22, 52, 75, 8, 90]),
];
const AUTOPILOT_PRE: [u8; 5] = [10, 55, 60, 5, 60];
const AUTOPILOT_POST: [u8; 5] = [50, 70, 45, 0, 50];

impl Profile {
    pub fn new(main: [u8; 5]) -> Self {
        let n = Numbers::new(main);
        Profile {
            fold_below: n.fold_below,
            raise_above: n.raise_above,
            aggression: n.aggression,
            bluff_chance: n.bluff_chance,
            raise_size: n.raise_size,
            position_weight: 0,
            streets: vec![],
            style: None,
        }
    }

    /// A preset by the app's name (case-insensitive): Autopilot, Guardian, Trapper or Daredevil.
    pub fn preset(name: &str) -> Option<Profile> {
        let (style, v) = PRESETS.iter().find(|(n, _)| n.eq_ignore_ascii_case(name))?;
        let mut p = Profile::new(*v);
        p.style = Some(style.to_string());
        if *style == "Autopilot" {
            let post = Some(Numbers::new(AUTOPILOT_POST));
            p.streets = vec![Some(Numbers::new(AUTOPILOT_PRE)), post, post, post];
        }
        Some(p)
    }

    /// The v2 profile a first-generation `{tight, aggro}` agent plays (each 0 to 100): tighter folds more and raises
    /// only stronger hands; more aggressive raises more often, bluffs more and bets bigger.
    pub fn from_legacy(tight: u8, aggro: u8) -> Profile {
        let (t, a) = (tight.min(100) as u32, aggro.min(100) as u32);
        let mut p = Profile::new([
            (10 + t * 45 / 100) as u8,
            (50 + t * 30 / 100) as u8,
            (10 + a * 85 / 100) as u8,
            (a * 8 / 100) as u8,
            (40 + a / 2) as u8,
        ]);
        p.style = Some("Classic".into());
        p
    }

    /// The nearest `{tight, aggro}` for views written before v2.
    pub fn legacy_view(&self) -> (u8, u8) {
        let t = (self.fold_below.saturating_sub(10) as u32 * 100 / 45).min(100) as u8;
        let a = (self.aggression.saturating_sub(10) as u32 * 100 / 85).min(100) as u8;
        (t, a)
    }

    pub fn main(&self) -> Numbers {
        Numbers { fold_below: self.fold_below, raise_above: self.raise_above, aggression: self.aggression, bluff_chance: self.bluff_chance, raise_size: self.raise_size }
    }

    /// The numbers it plays on a street (0 preflop .. 3 river): the street's own if set, else the main ones.
    pub fn street(&self, street: u8) -> Numbers {
        self.streets.get(street as usize).copied().flatten().unwrap_or_else(|| self.main())
    }

    pub fn validate(&self) -> Result<(), String> {
        self.main().validate()?;
        if self.position_weight > 100 {
            return Err("position_weight must be 0 to 100".into());
        }
        if !self.streets.is_empty() && self.streets.len() != 4 {
            return Err("streets: none, or four entries [preflop, flop, turn, river] (null to use the main numbers)".into());
        }
        for (i, s) in self.streets.iter().enumerate() {
            if let Some(n) = s {
                n.validate().map_err(|e| format!("streets[{i}]: {e}"))?;
            }
        }
        if let Some(s) = &self.style {
            if s.len() > MAX_STYLE_LEN || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b" -_'.".contains(&b)) {
                return Err(format!("style: up to {MAX_STYLE_LEN} letters, digits, spaces or -_'."));
            }
        }
        Ok(())
    }

    /// The numbers that decide play, as bytes (the style label is left out): main five, position weight, then each
    /// street as 0 (main numbers) or 1 and its five.
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut b = self.main().as_array().to_vec();
        b.push(self.position_weight);
        for s in 0..4u8 {
            match self.streets.get(s as usize).copied().flatten() {
                Some(n) => {
                    b.push(1);
                    b.extend_from_slice(&n.as_array());
                }
                None => b.push(0),
            }
        }
        b
    }

    /// The same profile with all-null street overrides dropped, so equal strategies compare equal.
    pub fn normalized(mut self) -> Profile {
        if self.streets.iter().all(Option::is_none) {
            self.streets.clear();
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_and_legacy_profiles_are_valid() {
        for (name, _) in PRESETS {
            Profile::preset(name).unwrap().validate().unwrap();
        }
        assert!(Profile::preset("autopilot").unwrap().streets.len() == 4);
        assert!(Profile::preset("nobody").is_none());
        for t in 0..=100u8 {
            for a in (0..=100u8).step_by(5) {
                let p = Profile::from_legacy(t, a);
                p.validate().unwrap();
                let (t2, a2) = p.legacy_view();
                assert!(t.abs_diff(t2) <= 3 && a.abs_diff(a2) <= 3, "{t},{a} -> {t2},{a2}");
            }
        }
    }

    #[test]
    fn out_of_range_values_are_refused() {
        let mut p = Profile::preset("Guardian").unwrap();
        p.raise_size = 121;
        assert!(p.validate().unwrap_err().contains("raise_size"));
        let mut p = Profile::preset("Guardian").unwrap();
        p.streets = vec![None, None];
        assert!(p.validate().is_err());
        let mut p = Profile::preset("Guardian").unwrap();
        p.streets = vec![None, Some(Numbers::new([5, 50, 50, 0, 50])), None, None];
        assert!(p.validate().unwrap_err().contains("streets[1]"));
        let mut p = Profile::preset("Guardian").unwrap();
        p.position_weight = 101;
        assert!(p.validate().is_err());
        let mut p = Profile::preset("Guardian").unwrap();
        p.style = Some("<script>".into());
        assert!(p.validate().is_err());
    }

    #[test]
    fn street_overrides_apply_only_where_set() {
        let p = Profile::preset("Autopilot").unwrap();
        assert_eq!(p.street(0).as_array(), AUTOPILOT_PRE);
        assert_eq!(p.street(3).as_array(), AUTOPILOT_POST);
        let g = Profile::preset("Guardian").unwrap();
        assert_eq!(g.street(2), g.main());
    }
}
