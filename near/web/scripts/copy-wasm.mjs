// Puts poker-core's WebAssembly build (../poker-wasm) where the app serves it: public/poker_wasm.wasm.
// Rebuilds it when cargo is available; otherwise keeps the committed copy, so hosts without Rust still build.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const crate = fileURLToPath(new URL("../../poker-wasm/", import.meta.url));
const built = `${crate}target/wasm32-unknown-unknown/release/poker_wasm.wasm`;
const served = fileURLToPath(new URL("../public/poker_wasm.wasm", import.meta.url));

try {
  execFileSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"], { cwd: crate, stdio: "inherit" });
  copyFileSync(built, served);
  console.log("poker_wasm.wasm rebuilt");
} catch (e) {
  if (!existsSync(served)) throw new Error("cargo is unavailable and public/poker_wasm.wasm is missing");
  console.log("cargo unavailable: using the committed public/poker_wasm.wasm");
}
