#!/usr/bin/env bash
# Deploys Builds/WebGL-per to the TEST Vercel project poker-per-m8-test (https://poker-per-m8-test.vercel.app),
# never the live one: the staging folder's .vercel/project.json pins that project. Adds the rollup-wallet page and
# vercel.json, then checks that the served wasm matches the build. Run from git-bash: bash per/ops/deploy-test-site.sh
set -e
REPO=/c/Kshitij/Work/X2C/web3/GitHub/Poker
S=$REPO/per/ops/test-site/staging
mkdir -p "$S/.vercel"
echo '{"projectId":"prj_8tTnqKAzAWBrRGD1YXMbxMD1WOeg","orgId":"team_TrLIPGDqLN7AK4Y02qyBlYkx","projectName":"poker-per-m8-test"}' > "$S/.vercel/project.json"
find "$S" -mindepth 1 -maxdepth 1 ! -name .vercel -exec rm -rf {} +
cp -r "$REPO/Builds/WebGL-per/." "$S/"
cp "$REPO/per/ops/test-site/vercel.json" "$REPO/per/client-web/rollup-wallet.html" "$REPO/per/client-web/rollup-wallet.js" "$S/"
cd "$S"
# Once (11 Oct) the deploy printed nothing and the site kept the old build: show the whole tail, and fail on no alias.
OUT=$(npx --yes vercel@latest deploy --prod --yes 2>&1 || true)
echo "$OUT" | grep -E "Aliased|readyState|Error|error" || { echo "$OUT" | tail -20; echo "DEPLOY FAILED"; exit 1; }
WANT=$(stat -c%s "$REPO/Builds/WebGL-per/Build/WebGL-per.wasm.unityweb")
for i in 1 2 3 4 5 6; do
  GOT=$(curl -sI "https://poker-per-m8-test.vercel.app/Build/WebGL-per.wasm.unityweb?v=$(date +%s)" | grep -i content-length | tr -dc 0-9)
  [ "$WANT" = "$GOT" ] && break; sleep 10
done
echo "wasm built $WANT, served $GOT"
if [ "$WANT" = "$GOT" ]; then echo "TEST SITE UPDATED"; else echo "MISMATCH"; exit 1; fi
