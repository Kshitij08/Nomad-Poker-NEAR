#!/usr/bin/env bash
# Deploys the internal test WebGL build (PerWebGLBuild.BuildStaging -> Builds/WebGL-agentsv2: the staging Photon universe,
# the internal test Coins API, the new test program and per-api-v3) to its own temporary Vercel project,
# nomad-poker-agentsv2-test (https://nomad-poker-agentsv2-test.vercel.app). Never the live site or the older test sites:
# the staging folder is linked to that project alone. Checks that the served wasm matches the build.
# Run from git-bash: bash per/ops/deploy-agentsv2-site.sh [build checkout, default ../Poker-android]
set -e
REPO=/c/Kshitij/Work/X2C/web3/GitHub/Poker
BUILD=${1:-/c/Kshitij/Work/X2C/web3/GitHub/Poker-android}/Builds/WebGL-agentsv2
PROJECT=nomad-poker-agentsv2-test
S=$REPO/per/ops/agentsv2-site/staging
[ -f "$BUILD/index.html" ] || { echo "no build at $BUILD"; exit 1; }
mkdir -p "$S"
find "$S" -mindepth 1 -maxdepth 1 ! -name .vercel -exec rm -rf {} +
cp -r "$BUILD/." "$S/"
cp "$REPO/per/ops/test-site/vercel.json" "$REPO/per/client-web/rollup-wallet.html" "$REPO/per/client-web/rollup-wallet.js" "$S/"
# The template's service worker serves Build/ files cache-first under a cache named after the product, version and data
# file, which don't change between builds: returning players kept the old build. Name the cache after this build's
# wasm, so the new sw.js replaces the old one and its activate step deletes the old cache.
BUILD_ID=$(cat "$BUILD"/Build/*.wasm* | sha256sum | cut -c1-12)
sed -i -E "s/^(const CACHE_NAME = \"[^\"]*)\";/\1-$BUILD_ID\";/" "$S/sw.js"
grep -q "$BUILD_ID" "$S/sw.js" || { echo "sw.js cache name not updated"; exit 1; }
cd "$S"
if [ ! -f .vercel/project.json ]; then npx --yes vercel@latest link --yes --project "$PROJECT" >/dev/null; fi
grep -q "\"projectName\":\"$PROJECT\"" .vercel/project.json || { echo "staging folder is linked to another project"; exit 1; }
for try in 1 2; do
  OUT=$(npx --yes vercel@latest deploy --prod --yes 2>&1 || true)
  echo "$OUT" | grep -q "Aliased" && break
  echo "deploy attempt $try failed:"; echo "$OUT" | grep -E "\"status\"|Error|error|message" | head -5
done
echo "$OUT" | grep -q "Aliased" || { echo "$OUT" | tail -20; echo "DEPLOY FAILED"; exit 1; }
echo "$OUT" | grep -E "Aliased"
WASM=$(cd "$BUILD/Build" && ls *.wasm*)
WANT=$(stat -c%s "$BUILD/Build/$WASM")
for i in 1 2 3 4 5 6; do
  GOT=$(curl -sI "https://$PROJECT.vercel.app/Build/$WASM?v=$(date +%s)" | grep -i content-length | tr -dc 0-9)
  [ "$WANT" = "$GOT" ] && break; sleep 10
done
echo "wasm built $WANT, served $GOT"
if [ "$WANT" = "$GOT" ]; then echo "AGENTSV2 TEST SITE UPDATED: https://$PROJECT.vercel.app"; else echo "MISMATCH"; exit 1; fi
