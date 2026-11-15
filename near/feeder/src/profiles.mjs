// The Nomad app's four playstyles as v2 strategy profiles (STRATEGY_PRESETS in packages/engine/src/agents, in
// hundredths), as poker_core::profile::Profile::preset defines them.
const n = ([fold_below, raise_above, aggression, bluff_chance, raise_size]) => ({ fold_below, raise_above, aggression, bluff_chance, raise_size });

export const AUTOPILOT = { ...n([35, 58, 45, 3, 60]), position_weight: 0, streets: [n([10, 55, 60, 5, 60]), n([50, 70, 45, 0, 50]), n([50, 70, 45, 0, 50]), n([50, 70, 45, 0, 50])], style: "Autopilot" };
export const GUARDIAN = { ...n([40, 60, 25, 2, 45]), position_weight: 0, streets: [], style: "Guardian" };
export const TRAPPER = { ...n([30, 52, 15, 0, 60]), position_weight: 0, streets: [], style: "Trapper" };
export const DAREDEVIL = { ...n([22, 52, 75, 8, 90]), position_weight: 0, streets: [], style: "Daredevil" };
export const PRESETS = [AUTOPILOT, GUARDIAN, TRAPPER, DAREDEVIL];
