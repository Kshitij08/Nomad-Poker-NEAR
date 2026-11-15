#!/usr/bin/env node
// Makes an agent a NEAR-AI agent: seals the pro's plain-words strategy to the dealer's key (read from the table)
// and stores only the ciphertext with set_private_strategy. Signs as the pro (key from the WSL keychain).
//
//   node scripts/near-ai-agent.ts --agent nomad-b --pro pro-b.nomad-poker.testnet --text "Play tight early..."
//   node scripts/near-ai-agent.ts --agent nomad-b --pro pro-b.nomad-poker.testnet --file my-strategy.txt [--model ...]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { account, attempt, view, EXPLORER } from "./lib.mjs";
import { sealStrategy, DEFAULT_MODEL } from "../feeder/src/nearai.ts";

const { values: a } = parseArgs({ options: { agent: { type: "string" }, pro: { type: "string" }, text: { type: "string" }, file: { type: "string" }, model: { type: "string", default: DEFAULT_MODEL } } });
if (!a.agent || !a.pro || !(a.text || a.file)) throw new Error("--agent, --pro and --text or --file are required");
const text = a.text ?? readFileSync(a.file!, "utf8").trim();

const key = (await view("get_strategy_key")) as string | null;
if (!key) throw new Error("the table has no dealer strategy key yet");
const sealed = sealStrategy(text, key, a.agent);
const r = await attempt(await account(a.pro), "set_private_strategy", { agent_id: a.agent, model: a.model, eph: sealed.eph, ct: sealed.ct }, { gas: "30" });
if (r.failure) throw new Error(`refused: ${r.failure}`);
console.log(`${a.agent} is a NEAR-AI agent on ${a.model} (strategy v${r.value}); ${sealed.ct.length / 2} sealed bytes; ${EXPLORER}${r.tx}`);
