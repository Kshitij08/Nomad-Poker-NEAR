"""Runs the Windows staging game server on this laptop (internal testing, docs/AGENTS_V2.md): the staging Photon
universe (AppVersion 1.0-agentsv2-test, ours alone), the internal test Coins API (Railway project poker-agents-v2-test), and that
service's own internal API key, read from Railway and passed to the server's environment (never printed).
Live players and the live API are never touched: staging builds can't see live Photon rooms, and the server only talks
to the test API.
Usage: python per/ops/run-local-staging-server.py [path to Poker.exe]"""
import json, os, shutil, subprocess, sys

PROJECT = "7fd95b97-3374-40e3-bcdc-a8c566338aea"  # poker-agents-v2-test
SERVICE = "coins-api"
BACKEND = "https://coins-api-production-0786.up.railway.app"
EXE = sys.argv[1] if len(sys.argv) > 1 else r"C:\Kshitij\Work\X2C\web3\GitHub\Poker-android\Builds\LocalServer\Poker.exe"

railway = shutil.which("railway.cmd") or shutil.which("railway.exe") or shutil.which("railway")
out = subprocess.run([railway, "variables", "-p", PROJECT, "-e", "production", "-s", SERVICE, "--json"], capture_output=True, text=True)
key = json.loads(out.stdout).get("INTERNAL_API_KEY")
if not key: sys.exit("No INTERNAL_API_KEY on the test coins-api service.")

APP_VERSION = "1.0-agentsv2-test"  # PokerMatchmaking.StagingAppVersion: our own Photon universe
env = dict(os.environ, POKER_INTERNAL_API_KEY=key, POKER_BACKEND_URL=BACKEND, POKER_APP_VERSION=APP_VERSION)
log = os.path.join(os.path.dirname(EXE), "server.log")
args = [EXE, "-batchmode", "-nographics", "-server", "-free", "-session", "poker-free",
        "-appVersion", APP_VERSION, "-backendUrl", BACKEND, "-logFile", log]
print(f"Starting staging server: {EXE}\n  backend {BACKEND}\n  log {log}")
sys.exit(subprocess.call(args, env=env))
