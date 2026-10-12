#!/usr/bin/env bash
# Deploys Builds/WebGL-per to the LIVE site www.nomadpoker.fun (Vercel project poker-build-public), as
# deploy-test-site.sh does for the test site, plus what the live page carries: the name "Nomad Poker", a version
# bump that also renames the service worker's cache (so returning players fetch the new build), and Vercel Web
# Analytics. Rollback: npx vercel rollback <previous deployment url> (the previous one is printed first).
# Run from git-bash: bash per/ops/deploy-live-site.sh <version>   (the live page was version 3 before 13 Oct 2026)
set -e
VERSION=${1:?usage: deploy-live-site.sh <version>}
REPO=/c/Kshitij/Work/X2C/web3/GitHub/Poker
S=$REPO/per/ops/live-site/staging
echo "current live deployment (rollback target):"
npx --yes vercel@latest ls poker-build-public --prod 2>&1 | grep -oE "https://poker-build-public-[a-z0-9]+-[a-z0-9-]+\.vercel\.app" | head -1
mkdir -p "$S/.vercel"
echo '{"projectId":"prj_8aKV6PcoParw4GJCICvHa1Dlalc1","orgId":"team_TrLIPGDqLN7AK4Y02qyBlYkx","projectName":"poker-build-public"}' > "$S/.vercel/project.json"
find "$S" -mindepth 1 -maxdepth 1 ! -name .vercel -exec rm -rf {} +
cp -r "$REPO/Builds/WebGL-per/." "$S/"
cp "$REPO/per/ops/test-site/vercel.json" "$REPO/per/client-web/rollup-wallet.html" "$REPO/per/client-web/rollup-wallet.js" "$S/"
cd "$S"
# The live page's name and version (the project's product name is "Pokers").
sed -i 's/"Pokers"/"Nomad Poker"/g; s/>Pokers</>Nomad Poker</g; s/content="Pokers"/content="Nomad Poker"/g' index.html manifest.json
sed -i "s/productVersion: \"[0-9]*\"/productVersion: \"$VERSION\"/; s/register(\"sw.js[^\"]*\")/register(\"sw.js?v=$VERSION\")/" index.html
sed -i "s/^const CACHE_NAME = .*/const CACHE_NAME = \"Nomad Poker-$VERSION-WebGL-per.data.unityweb\";/" sw.js
# Vercel Web Analytics, as the live page had it.
grep -q "_vercel/insights" index.html || sed -i 's#</body>#    <script>\n      window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };\n    </script>\n    <script defer src="/_vercel/insights/script.js"></script>\n  </body>#' index.html
grep -c "Nomad Poker" index.html manifest.json sw.js
for try in 1 2; do
  OUT=$(npx --yes vercel@latest deploy --prod --yes 2>&1 || true)
  echo "$OUT" | grep -q "Aliased" && break
  echo "deploy attempt $try failed:"; echo "$OUT" | grep -E "\"status\"|Error|error|message" | head -5
done
echo "$OUT" | grep -q "Aliased" || { echo "$OUT" | tail -20; echo "DEPLOY FAILED"; exit 1; }
echo "$OUT" | grep -E "Aliased|Production:"
WANT=$(stat -c%s "$REPO/Builds/WebGL-per/Build/WebGL-per.wasm.unityweb")
for i in 1 2 3 4 5 6; do
  GOT=$(curl -sI "https://www.nomadpoker.fun/Build/WebGL-per.wasm.unityweb?v=$(date +%s)" | grep -i content-length | tr -dc 0-9)
  [ "$WANT" = "$GOT" ] && break; sleep 10
done
echo "wasm built $WANT, served $GOT"
if [ "$WANT" = "$GOT" ]; then echo "LIVE SITE UPDATED"; else echo "MISMATCH"; exit 1; fi
