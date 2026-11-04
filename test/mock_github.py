#!/usr/bin/env python3
"""로컬 시험용 GitHub API 흉내. 사이트가 쓰는 Git Data API 엔드포인트만 구현한다.

사용: mock_github.py <글 저장소 경로> [포트=8765]
  - 저장소의 git HEAD 파일로 시작한다(작업 트리는 건드리지 않는다).
  - 토큰은 'test-token' 만 받는다.
  - 사이트 주소에 ?api=http://localhost:8765 를 붙여 연다.
  - GET /__state : 지금 파일 목록(경로 → blob sha), GET /__file?path= : 파일 내용
"""
import base64, hashlib, json, re, subprocess, sys, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

REPO, PORT = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 8765
blobs, trees, commits = {}, {}, {}


def put_blob(data):
    sha = hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()
    blobs[sha] = data
    return sha


def seed():
    files = {}
    names = subprocess.run(["git", "-C", REPO, "ls-files", "-z"], capture_output=True, check=True).stdout.split(b"\0")
    for n in filter(None, names):
        data = subprocess.run(["git", "-C", REPO, "show", b"HEAD:" + n], capture_output=True, check=True).stdout
        files[n.decode()] = put_blob(data)
    t = uuid.uuid4().hex + "00000000"
    trees[t] = files
    c = uuid.uuid4().hex + "11111111"
    commits[c] = {"tree": t, "parents": []}
    return c


HEAD = {"sha": seed()}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, X-GitHub-Api-Version")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")

    def reply(self, code, obj=None, raw=None):
        body = raw if raw is not None else json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def route(self, method):
        u = urlparse(self.path)
        if u.path == "/__state":
            return self.reply(200, {"head": HEAD["sha"], "files": trees[commits[HEAD["sha"]]["tree"]]})
        if u.path == "/__file":
            p = parse_qs(u.query)["path"][0]
            sha = trees[commits[HEAD["sha"]]["tree"]].get(p)
            return self.reply(200 if sha else 404, raw=blobs[sha] if sha else b"{}")
        if self.headers.get("Authorization") != "Bearer test-token":
            return self.reply(401, {"message": "Bad credentials"})
        m = re.match(r"^/repos/[^/]+/[^/]+(/.*)$", u.path)
        if not m:
            return self.reply(404, {"message": "Not Found"})
        p = m.group(1)
        body = {}
        if method in ("POST", "PATCH"):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if method == "GET" and p == "/git/ref/heads/main":
            return self.reply(200, {"object": {"sha": HEAD["sha"], "type": "commit"}})
        if method == "GET" and p.startswith("/git/commits/"):
            c = commits.get(p.rsplit("/", 1)[1])
            return self.reply(200, {"sha": p.rsplit("/", 1)[1], "tree": {"sha": c["tree"]}}) if c else self.reply(404, {"message": "Not Found"})
        if method == "GET" and p.startswith("/git/trees/"):
            files = trees.get(p.rsplit("/", 1)[1])
            if files is None:
                return self.reply(404, {"message": "Not Found"})
            out, dirs = [], set()
            for path, sha in sorted(files.items()):
                parts = path.split("/")
                for i in range(1, len(parts)):
                    dirs.add("/".join(parts[:i]))
                out.append({"path": path, "mode": "100644", "type": "blob", "sha": sha, "size": len(blobs[sha])})
            out += [{"path": d, "mode": "040000", "type": "tree", "sha": "0" * 40} for d in sorted(dirs)]
            return self.reply(200, {"sha": p.rsplit("/", 1)[1], "tree": out, "truncated": False})
        if method == "GET" and p.startswith("/git/blobs/"):
            data = blobs.get(p.rsplit("/", 1)[1])
            if data is None:
                return self.reply(404, {"message": "Not Found"})
            b64 = base64.b64encode(data).decode()
            return self.reply(200, {"content": "\n".join(b64[i:i + 60] for i in range(0, len(b64), 60)), "encoding": "base64", "size": len(data)})
        if method == "POST" and p == "/git/blobs":
            return self.reply(201, {"sha": put_blob(base64.b64decode(body["content"]))})
        if method == "POST" and p == "/git/trees":
            files = dict(trees[body["base_tree"]])
            for e in body["tree"]:
                if e.get("sha") is None:
                    if e["path"] not in files:
                        return self.reply(422, {"message": f"GitRPC::BadObjectState {e['path']}"})
                    del files[e["path"]]
                else:
                    if e["sha"] not in blobs:
                        return self.reply(422, {"message": "tree.sha is not a valid blob"})
                    files[e["path"]] = e["sha"]
            t = uuid.uuid4().hex + "00000000"
            trees[t] = files
            return self.reply(201, {"sha": t})
        if method == "POST" and p == "/git/commits":
            c = uuid.uuid4().hex + "11111111"
            commits[c] = {"tree": body["tree"], "parents": body["parents"], "message": body["message"]}
            print("commit:", body["message"], flush=True)
            return self.reply(201, {"sha": c})
        if method == "PATCH" and p == "/git/refs/heads/main":
            c = commits.get(body["sha"])
            if not c or (not body.get("force") and c["parents"] != [HEAD["sha"]]):
                return self.reply(422, {"message": "Update is not a fast forward"})
            HEAD["sha"] = body["sha"]
            return self.reply(200, {"object": {"sha": body["sha"]}})
        return self.reply(404, {"message": "Not Found " + p})

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PATCH(self):
        self.route("PATCH")


print(f"mock GitHub API on :{PORT}, {len(trees[commits[HEAD['sha']]['tree']])} files", flush=True)
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
