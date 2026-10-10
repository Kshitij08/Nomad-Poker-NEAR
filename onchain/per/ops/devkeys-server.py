# Local test-key server for browser checks: serves ONLY p1.json and p2.json (devnet test keys) from per/ops/devkeys
# (gitignored) on 127.0.0.1:8791, to pages from http://localhost:8790 opened with ?devWallet=p1. Never deployed;
# delete the copied keys after a run.
import http.server, os, re
DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "devkeys")
ALLOWED = {"p1", "p2"}


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        m = re.fullmatch(r"/([a-z0-9]{1,16})\.json", self.path)
        name = m.group(1) if m else None
        if name not in ALLOWED or not os.path.exists(os.path.join(DIR, name + ".json")):
            self.send_response(404)
            self.send_header("Access-Control-Allow-Origin", "http://localhost:8790")
            self.end_headers()
            return
        body = open(os.path.join(DIR, name + ".json"), "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "http://localhost:8790")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", 8791), H).serve_forever()
