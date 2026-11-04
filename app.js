/* 공부 기록 사이트.
 * 글은 비공개 저장소에 있고, 이 페이지는 사용자의 토큰으로 GitHub API 를 불러 읽고 쓴다.
 * 쓰기는 모두 Git Data API(blob → tree → commit → ref) 한 번의 커밋으로 처리한다.
 * index.json 은 저장소의 tools/build_index.py 와 같은 형식으로 고쳐 쓴다(Actions 가 다시 만들어도 diff 가 없게).
 */
"use strict";

// ?api= 는 로컬 시험(test/mock_github.py)에서만 받는다. 배포된 페이지에서 받으면 링크 하나로 토큰이 다른 서버로 갈 수 있다.
const API = (() => {
  const local = (h) => ["localhost", "127.0.0.1", "[::1]"].includes(h);
  const v = new URLSearchParams(location.search).get("api");
  try { if (v && local(location.hostname) && local(new URL(v).hostname)) return v.replace(/\/+$/, ""); } catch {}
  return "https://api.github.com";
})();
/* 상단 패널에 보이는 내 정보. 여기만 고치면 된다. */
const PROFILE = {
  name: "박진형",
  handle: "secretj",
  role: "Backend Developer",
  tagline: "백엔드 개발자 · PHP · Go · Java/Spring · MariaDB · Redis · Elasticsearch · RabbitMQ",
  links: [
    ["GitHub", "https://github.com/secretj"],
    ["이력서", "https://jinhyeong.hichecky.com"],
  ],
};
const CFG_KEY = "study-notes.cfg";
const DEFAULT_CFG = {owner: "secretj", repo: "study-notes", branch: "main"};
const HIDDEN_DIRS = ["tools", "_raw", ".github"];
const GROUP_ORDER = ["언어", "프레임워크", "설계", "기초", "도구", "프로젝트·업무", "기타"];
const GROUP_COLOR = {"언어": "--go", "프레임워크": "--file", "설계": "--p8", "기초": "--db", "도구": "--py", "프로젝트·업무": "--java", "기타": "--line-2"};
const DEFAULT_TOPICS = { // tools/build_index.py 의 DEFAULT_TOPICS 와 같게
  "go": ["Go 학습", "언어"], "java-basics": ["JAVA 기본 지식", "언어"], "csharp-basics": ["실무형 C# 기초", "언어"],
  "comp2200-c": ["COMP2200: C 언매니지드 프로그래밍", "언어"], "spring": ["Spring 공부", "프레임워크"],
  "spring-advanced": ["스프링 핵심원리 고급편", "프레임워크"], "codeigniter4": ["CodeIgniter4", "프레임워크"],
  "ddd": ["도메인 주도 개발 (DDD)", "설계"], "traffic-experience": ["트래픽 경험", "설계"], "cs": ["CS 지식", "기초"],
  "network": ["네트워크", "기초"], "comp3500-algorithm": ["COMP3500: 알고리듬 및 자료구조 (Java)", "기초"],
  "oracle": ["오라클 ORACLE", "기초"], "info-processing-engineer": ["정보처리기사", "기초"], "github": ["Github", "도구"],
  "jenkins": ["젠킨스 Jenkins", "도구"], "project-nplit": ["프로젝트 NPLIT", "프로젝트·업무"],
  "dreamsys-training": ["드림시스 업무 교육", "프로젝트·업무"],
};
/* 태그 색: 이름을 해시해서 늘 같은 색을 고른다. [글자, 바탕, 테두리] */
const TAG_PALETTE = [
  ["#0a6fb5", "#e8f2fb", "#c4dcf2"], ["#0b7f8f", "#e4f6f8", "#bde6ec"], ["#1f7a44", "#e8f6ee", "#c2e5d0"],
  ["#5b7a12", "#f1f7e2", "#d7e8b0"], ["#8a6400", "#fbf3dc", "#efdca2"], ["#a8501a", "#fdeee6", "#f4cdb5"],
  ["#b0302a", "#fdecea", "#f3c4c0"], ["#a8337a", "#fbe9f3", "#efc1dc"], ["#6a2fa0", "#f3ecf9", "#dccbee"],
  ["#3e4fb0", "#eceffb", "#c9d0f1"], ["#4b5d73", "#eef2f6", "#d0d9e3"],
];
/* 많이 쓴 태그부터 팔레트를 차례로 준다(상위 11개는 서로 다른 색). 목록에 없는 태그는 이름 해시로 고른다. */
let tagColorIdx = new Map();
function rebuildTagColors() {
  const count = new Map();
  for (const p of S.index.pages) for (const t of p.tags) count.set(t, (count.get(t) || 0) + 1);
  const order = [...count.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([t]) => t);
  tagColorIdx = new Map(order.map((t, i) => [t, i % TAG_PALETTE.length]));
}
function tagStyle(tag) {
  let i = tagColorIdx.get(tag);
  if (i == null) {
    let h = 5381;
    for (const ch of tag.toLowerCase()) h = ((h << 5) + h + ch.codePointAt(0)) >>> 0;
    i = h % TAG_PALETTE.length;
  }
  const [c, b, d] = TAG_PALETTE[i];
  return `style="--tc:${c};--tb:${b};--td:${d}"`;
}
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const MIME = {png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon", pdf: "application/pdf"};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

const S = {
  cfg: null,
  headSha: null,
  files: new Map(),     // path -> {sha, size}
  index: {topics: {}, pages: []},
  tab: "topic",
  open: new Set(JSON.parse(localStorage.getItem("study-notes.open") || "[]")),
  current: null,        // 보고 있는 파일 경로
  editing: null,        // {path, sha, isNew}
  blobCache: new Map(), // sha -> objectURL
  textCache: new Map(), // sha -> text
};

/* ---------------- GitHub API ---------------- */

async function gh(path, opts = {}) {
  const {owner, repo, token} = S.cfg;
  const url = path.startsWith("http") ? path : `${API}/repos/${owner}/${repo}${path}`;
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? {"Content-Type": "application/json"} : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg += " " + ((await res.json()).message || ""); } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const authed = () => !!S.cfg?.token;
const rawURL = (path) => `https://raw.githubusercontent.com/${S.cfg.owner}/${S.cfg.repo}/${encodeURIComponent(S.cfg.branch)}/${encPath(path)}`;

/* 토큰이 있으면 API 로 전체 파일 목록을, 없으면 공개 raw 의 index.json 으로 글 목록만 읽는다. */
async function loadTree() {
  if (!authed()) {
    const res = await fetch(rawURL("index.json"), {cache: "no-cache"});
    if (!res.ok) throw Object.assign(new Error(`${res.status} index.json`), {status: res.status});
    S.index = await res.json();
    S.index.topics ||= {};
    S.index.pages ||= [];
    S.headSha = null;
    S.files = new Map(S.index.pages.map((p) => [p.path, {sha: null, size: null}]));
    rebuildTagColors();
    return;
  }
  const ref = await gh(`/git/ref/heads/${encodeURIComponent(S.cfg.branch)}`);
  const commit = await gh(`/git/commits/${ref.object.sha}`);
  const tree = await gh(`/git/trees/${commit.tree.sha}?recursive=1`);
  S.headSha = ref.object.sha;
  S.files = new Map();
  for (const e of tree.tree) if (e.type === "blob") S.files.set(e.path, {sha: e.sha, size: e.size});
  if (tree.truncated) toast("파일이 너무 많아 목록 일부가 빠졌어요", true);
  const idx = S.files.get("index.json");
  S.index = idx ? JSON.parse(await blobText(idx.sha)) : {topics: {}, pages: []};
  S.index.topics ||= {};
  S.index.pages ||= [];
  rebuildTagColors();
}

async function blobBytes(sha) {
  const b = await gh(`/git/blobs/${sha}`);
  const bin = atob(b.content.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function fileBytes(path) {
  const f = S.files.get(path);
  if (authed()) {
    if (!f) return null;
    return blobBytes(f.sha);
  }
  const res = await fetch(rawURL(path));
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

const decodeText = (bytes) => new TextDecoder("utf-8", {ignoreBOM: true}).decode(bytes);

async function blobText(sha) {
  if (S.textCache.has(sha)) return S.textCache.get(sha);
  const t = decodeText(await blobBytes(sha));
  S.textCache.set(sha, t);
  return t;
}

async function fileText(path) {
  const key = authed() ? S.files.get(path)?.sha : `raw:${path}`;
  if (key && S.textCache.has(key)) return S.textCache.get(key);
  const bytes = await fileBytes(path);
  if (!bytes) throw Object.assign(new Error(`404 ${path}`), {status: 404});
  const t = decodeText(bytes);
  if (key) S.textCache.set(key, t);
  return t;
}

async function blobURL(path) {
  const key = authed() ? S.files.get(path)?.sha : `raw:${path}`;
  if (!key) return null;
  if (S.blobCache.has(key)) return S.blobCache.get(key);
  const ext = path.split(".").pop().toLowerCase();
  let data = await fileBytes(path);
  if (!data) return null;
  if (ext === "svg") data = DOMPurify.sanitize(new TextDecoder().decode(data), {USE_PROFILES: {svg: true, svgFilters: true}});
  const url = URL.createObjectURL(new Blob([data], {type: MIME[ext] || "application/octet-stream"}));
  S.blobCache.set(key, url);
  return url;
}

function b64FromBytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64FromText = (t) => b64FromBytes(new TextEncoder().encode(t));

/* changes: [{path, text}|{path, base64}|{path, sha}|{path, delete:true}]
 * 한 번의 커밋으로 만든다. index.json 은 바뀐 .md 를 보고 함께 고친다. */
async function commit(changes, message) {
  busy(true);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ref = await gh(`/git/ref/heads/${encodeURIComponent(S.cfg.branch)}`);
      const head = await gh(`/git/commits/${ref.object.sha}`);
      const all = [...changes];
      const top = await gh(`/git/trees/${head.tree.sha}`);
      const idxEntry = top.tree.find((e) => e.path === "index.json");
      const base = idxEntry ? JSON.parse(await blobText(idxEntry.sha)) : {topics: {}, pages: []};
      const idx = await nextIndex(all, base);
      if (idx) all.push({path: "index.json", text: idx});
      const tree = [];
      for (const c of all) {
        if (c.topic) continue; // 주제 이름만 바꾸는 항목 (index.json 에만 반영)
        if (c.delete) { tree.push({path: c.path, mode: "100644", type: "blob", sha: null}); continue; }
        let sha = c.sha;
        if (!sha) {
          const blob = await gh("/git/blobs", {method: "POST", body: {content: c.base64 ?? b64FromText(c.text), encoding: "base64"}});
          sha = blob.sha;
        }
        tree.push({path: c.path, mode: "100644", type: "blob", sha});
      }
      const t = await gh("/git/trees", {method: "POST", body: {base_tree: head.tree.sha, tree}});
      const cm = await gh("/git/commits", {method: "POST", body: {message, tree: t.sha, parents: [ref.object.sha]}});
      try {
        await gh(`/git/refs/heads/${encodeURIComponent(S.cfg.branch)}`, {method: "PATCH", body: {sha: cm.sha, force: false}});
      } catch (e) {
        if (e.status === 422 && attempt === 0) continue; // 그사이 다른 커밋이 들어왔다 → 한 번 더
        throw e;
      }
      await loadTree();
      return;
    }
  } finally { busy(false); }
}

/* ---------------- index.json (tools/build_index.py 와 같은 규칙) ---------------- */

const pyStr = (t) => (t === true ? "True" : t === false ? "False" : t === null ? "None" : String(t)); // 파이썬 str() 과 같게

function parseFrontMatter(text) {
  text = text.replace(/\r\n?/g, "\n"); // 파이썬 universal newline 과 같게
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  const meta = {};
  if (m) {
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
      if (k === "tags") {
        try { meta.tags = v.startsWith("[") ? JSON.parse(v).map(pyStr) : v.split(",").map((s) => s.trim()).filter(Boolean); }
        catch { meta.tags = v.replace(/^[[\]]+|[[\]]+$/g, "").split(",").filter((s) => s.trim()).map((s) => s.trim().replace(/^["']+|["']+$/g, "")); }
      } else if (k === "title" && v.startsWith('"')) {
        try { meta.title = JSON.parse(v); } catch { meta.title = v.replace(/^"+|"+$/g, ""); }
      } else meta[k] = v;
    }
  }
  if (!("title" in meta)) {
    const h = text.match(/^# (.+)$/m);
    if (h) meta.title = h[1].trim();
  }
  return {meta, body: m ? text.slice(m[0].length) : text};
}

const isPage = (p) => p.endsWith(".md") && p.includes("/") && !HIDDEN_DIRS.includes(p.split("/")[0]) && !p.startsWith(".");
const stem = (p) => p.split("/").pop().replace(/\.[^.]+$/, "");
const sortKey = (p) => p.replace(/\.md$/, "").split("/");
function cmpParts(a, b) {
  const x = sortKey(a), y = sortKey(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length - y.length;
}

async function nextIndex(changes, base) {
  const touched = changes.filter((c) => c.path.endsWith(".md") || c.topic);
  if (!touched.length) return null;
  const pages = new Map((base.pages || []).map((p) => [p.path, p]));
  for (const c of changes) {
    if (!isPage(c.path)) continue;
    if (c.delete) { pages.delete(c.path); continue; }
    let text = c.text;
    if (text == null && c.base64 != null) text = decodeText(Uint8Array.from(atob(c.base64), (ch) => ch.charCodeAt(0)));
    if (text == null && c.sha) text = await blobText(c.sha);
    const {meta} = parseFrontMatter(text);
    pages.set(c.path, {path: c.path, title: meta.title || stem(c.path), date: meta.date || "", tags: meta.tags || []});
  }
  const list = [...pages.values()].sort((a, b) => cmpParts(a.path, b.path));
  const extra = Object.assign({}, ...changes.filter((c) => c.topic).map((c) => c.topic));
  const topics = {};
  for (const folder of [...new Set(list.map((p) => p.path.split("/")[0]))].sort()) {
    const d = DEFAULT_TOPICS[folder];
    topics[folder] = extra[folder] || (base.topics || {})[folder] || (d ? {name: d[0], group: d[1]} : {name: folder, group: "기타"});
  }
  return JSON.stringify({topics, pages: list}, null, 2) + "\n";
}

/* ---------------- 공통 UI ---------------- */

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (err ? " err" : "");
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), err ? 6000 : 2600);
}
function busy(on) {
  const s = $("#status");
  s.classList.toggle("busy", on);
  s.textContent = on ? "저장 중" : "";
}
async function guard(fn) {
  try { await fn(); }
  catch (e) {
    console.error(e);
    busy(false);
    toast(e.status === 401 ? "토큰이 만료됐거나 틀렸어요. 로그아웃 후 다시 로그인해 주세요." : e.status === 403 || e.status === 404 ? `권한이 없거나 찾을 수 없어요 (${e.message})` : `실패했어요: ${e.message}`, true);
  }
}

/* 모달: fields = [{name, label, value, type, options, hint, list, when}] → 값 객체, 취소면 null
 * when(값 객체) 가 false 면 그 칸을 숨기고 필수 검사에서도 뺀다. onOpen(body) 는 열린 직후 한 번 부른다. */
function modal({title, html = "", fields = [], ok = "확인", danger = false, onOpen = null, read = null}) {
  return new Promise((resolve) => {
    const d = $("#modal");
    $("#modal-title").textContent = title;
    const body = $("#modal-body");
    body.innerHTML = html;
    for (const f of fields) {
      const lab = document.createElement("label");
      lab.innerHTML = `${esc(f.label)}${f.hint ? ` <span class="hint">${esc(f.hint)}</span>` : ""}`;
      let el;
      if (f.type === "select") {
        el = document.createElement("select");
        for (const [v, t] of f.options) el.add(new Option(t, v, false, v === f.value));
      } else if (f.type === "checkbox") {
        lab.className = "check";
        el = document.createElement("input");
        el.type = "checkbox";
        el.checked = !!f.value;
        lab.prepend(el);
      } else {
        el = document.createElement("input");
        el.type = f.type || "text";
        el.value = f.value ?? "";
        if (f.list) el.setAttribute("list", f.list);
        if (f.required) el.required = true;
        if (f.type === "password") el.autocomplete = "off";
      }
      el.name = f.name;
      if (f.type !== "checkbox") lab.append(el);
      body.append(lab);
      f.lab = lab;
      f.el = el;
    }
    const values = () => Object.fromEntries(fields.map((f) => [f.name, f.type === "checkbox" ? f.el.checked : f.el.value.trim()]));
    const sync = () => {
      const v = values();
      for (const f of fields) {
        if (!f.when) continue;
        const show = !!f.when(v);
        f.lab.hidden = !show;
        f.el.required = !!f.required && show;
      }
    };
    body.oninput = body.onchange = sync;
    sync();
    const okBtn = $("#modal-ok");
    okBtn.textContent = ok;
    okBtn.className = "btn " + (danger ? "danger" : "primary");
    d.onclose = () => {
      if (d.returnValue !== "ok") return resolve(null);
      const out = values();
      if (read) Object.assign(out, read(body));
      resolve(out);
    };
    d.returnValue = "";
    d.showModal();
    if (onOpen) onOpen(body);
    const first = body.querySelector("label:not([hidden]) input:not([type=checkbox]),label:not([hidden]) select");
    if (first) first.focus();
  });
}
const confirmBox = (title, html, ok = "확인", danger = false) => modal({title, html, ok, danger}).then((v) => v !== null);

/* ---------------- 탐색 데이터 ---------------- */

const pageOf = (path) => S.index.pages.find((p) => p.path === path);
const topicName = (folder) => S.index.topics[folder]?.name || folder;
const topicGroup = (folder) => S.index.topics[folder]?.group || "기타";
const groupColor = (g) => `var(${GROUP_COLOR[g] || "--line-2"})`;
/* 주제 순서: topics[폴더].order 가 작은 것부터, 같으면 이름순. order 가 없으면 0 으로 보고 맨 앞에 둔다
 * (새 주제는 max+1 을 받아 맨 뒤로 간다). build_index.py 의 README 도 같은 규칙 */
const topicOrder = (folder) => S.index.topics[folder]?.order ?? 0;
const cmpTopic = (a, b) => topicOrder(a) - topicOrder(b) || topicName(a).localeCompare(topicName(b), "ko");
const nextOrder = () => Math.max(0, ...Object.values(S.index.topics).map((t) => t.order || 0)) + 1;
/* 폴더 표시 이름: 주제면 주제 이름, 글과 짝인 폴더(02-X/ ↔ 02-X.md)면 그 글 제목, 아니면 번호를 뗀 폴더 이름 */
function folderLabel(dir) {
  if (!dir.includes("/")) return topicName(dir);
  return pageOf(dir + ".md")?.title || prettyName(dir.split("/").pop());
}
/* 경로의 상위 폴더들을 링크로 잇는다. 글과 짝인 폴더는 그 글로 간다 */
function crumbs(path, self = false) {
  const parts = path.split("/");
  const out = [];
  for (let i = 1; i < parts.length + (self ? 1 : 0); i++) {
    const dir = parts.slice(0, i).join("/");
    const href = pageOf(dir + ".md") ? `#/p/${encPath(dir + ".md")}` : `#/f/${encPath(dir)}`;
    out.push(`<a href="${href}">${esc(folderLabel(dir))}</a>`);
  }
  return out.join(`<span class="sep">/</span>`);
}
const prettyName = (name) => name.replace(/\.md$/, "").replace(/^\d{2,}-/, "");

function visiblePaths() {
  const hidden = !$("#show-hidden").checked;
  return [...S.files.keys()].filter((p) => {
    if (!hidden) return true;
    const top = p.split("/")[0];
    if (!p.includes("/") || HIDDEN_DIRS.includes(top) || top.startsWith(".")) return false;
    return !p.split("/").includes("images");
  });
}

/* 경로 목록 → 트리. "02-X.md" 와 같은 이름의 폴더 "02-X/" 는 그 글의 하위 글로 붙인다. */
function buildTree(paths) {
  const root = {name: "", path: "", dirs: new Map(), files: []};
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (!node.dirs.has(name)) node.dirs.set(name, {name, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: []});
      node = node.dirs.get(name);
    }
    node.files.push(p);
  }
  return root;
}

function matchesSearch(p) {
  const q = $("#search").value.trim().toLowerCase();
  if (!q) return true;
  const pg = pageOf(p);
  return p.toLowerCase().includes(q) || (pg && (pg.title.toLowerCase().includes(q) || pg.tags.some((t) => t.toLowerCase().includes(q))));
}

/* ---------------- 사이드바 ---------------- */

function renderNav() {
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
  const home = route().kind === "home";
  $$(".topnav [data-jump]").forEach((b) => b.classList.toggle("on", b.dataset.jump === "home" ? home : !home && b.dataset.jump === S.tab));
  const nav = $("#nav");
  nav.innerHTML = "";
  if (S.tab === "topic") nav.append(renderTopicTree());
  if (S.tab === "tag") nav.append(renderTagNav());
  if (S.tab === "year") nav.append(renderYearNav());
  $("#count-badge").textContent = `글 ${S.index.pages.length}개${authed() ? "" : " · 보기 전용"}`;
  $("#tag-list").innerHTML = allTags().map(([t]) => `<option value="${esc(t)}">`).join("");
  $("#group-list").innerHTML = GROUP_ORDER.map((g) => `<option value="${esc(g)}">`).join("");
  const on = nav.querySelector(".row.on");
  if (on) on.scrollIntoView({block: "nearest"});
}

function renderTopicTree() {
  const frag = document.createDocumentFragment();
  const searching = !!$("#search").value.trim();
  const paths = visiblePaths().filter((p) => !searching || matchesSearch(p));
  const tree = buildTree(paths);
  const groups = new Map();
  for (const [name, node] of tree.dirs) {
    const g = HIDDEN_DIRS.includes(name) || name.startsWith(".") ? "숨긴 폴더" : topicGroup(name);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(node);
  }
  const order = [...groups.keys()].sort((a, b) => (GROUP_ORDER.indexOf(a) + 99) % 99 - (GROUP_ORDER.indexOf(b) + 99) % 99);
  for (const g of order) {
    const h = document.createElement("div");
    h.className = "grp-h";
    h.textContent = g;
    frag.append(h);
    const ul = document.createElement("ul");
    for (const node of groups.get(g).sort((a, b) => cmpTopic(a.name, b.name))) {
      ul.append(renderDir(node, 0, searching));
    }
    frag.append(ul);
  }
  if (tree.files.length && $("#show-hidden").checked) {
    const ul = document.createElement("ul");
    tree.files.forEach((f) => ul.append(renderFile(f, null, searching)));
    frag.append(ul);
  }
  if (!paths.length) frag.append(Object.assign(document.createElement("div"), {className: "empty", textContent: "찾는 글이 없어요"}));
  return frag;
}

function renderDir(node, depth, searching) {
  const li = document.createElement("li");
  li.className = "node";
  const open = searching || S.open.has(node.path) || (S.current || "").startsWith(node.path + "/");
  const count = [...S.files.keys()].filter((p) => p.startsWith(node.path + "/") && isPage(p)).length;
  const label = depth === 0 ? topicName(node.name) : prettyName(node.name);
  const row = document.createElement("div");
  row.className = "row folder";
  row.innerHTML = `<span class="tw ${open ? "open" : ""}">▶</span>${depth === 0 ? `<span class="dot" style="background:${groupColor(topicGroup(node.name))}"></span>` : ""}<span class="lbl" title="${esc(node.path)}">${esc(label)}</span><span class="cnt">${count || ""}</span><button class="more" aria-label="폴더 메뉴">⋯</button>`;
  row.onclick = (e) => {
    if (e.target.closest(".more")) return folderMenu(e, node.path);
    if (S.open.has(node.path)) S.open.delete(node.path); else S.open.add(node.path);
    localStorage.setItem("study-notes.open", JSON.stringify([...S.open]));
    renderNav();
  };
  li.append(row);
  if (open) li.append(renderChildren(node, depth, searching));
  return li;
}

function renderChildren(node, depth, searching) {
  const ul = document.createElement("ul");
  const subdirs = new Map(node.dirs);
  const files = [...node.files].sort(cmpParts);
  for (const f of files) {
    const sub = f.endsWith(".md") ? subdirs.get(stem(f)) : null;
    if (sub) subdirs.delete(stem(f));
    ul.append(renderFile(f, sub, searching, depth + 1));
  }
  for (const d of [...subdirs.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) ul.append(renderDir(d, depth + 1, searching));
  return ul;
}

function renderFile(path, subdir, searching, depth = 1) {
  const li = document.createElement("li");
  li.className = "node";
  const pg = pageOf(path);
  const isMd = path.endsWith(".md");
  const open = subdir && (searching || S.open.has(subdir.path) || (S.current || "").startsWith(subdir.path + "/"));
  const row = document.createElement("div");
  row.className = "row" + (S.current === path ? " on" : "");
  row.innerHTML = `${subdir ? `<span class="tw ${open ? "open" : ""}">▶</span>` : `<span class="file">${isMd ? "" : IMG_EXT.test(path) ? "▣" : "□"}</span>`}<span class="lbl" title="${esc(path)}">${esc(pg ? pg.title : prettyName(path.split("/").pop()))}</span>`;
  row.onclick = (e) => {
    if (subdir && e.target.closest(".tw")) {
      if (S.open.has(subdir.path)) S.open.delete(subdir.path); else S.open.add(subdir.path);
      localStorage.setItem("study-notes.open", JSON.stringify([...S.open]));
      return renderNav();
    }
    go(`#/p/${encPath(path)}`);
  };
  li.append(row);
  if (open) li.append(renderChildren(subdir, depth, searching));
  return li;
}

function allTags() {
  const m = new Map();
  for (const p of S.index.pages) for (const t of p.tags) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
}
function allYears() {
  const m = new Map();
  for (const p of S.index.pages) {
    const y = p.date ? p.date.slice(0, 4) : "날짜 없음";
    m.set(y, (m.get(y) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

function navList(items, hrefOf, active, dot = false) {
  const ul = document.createElement("ul");
  for (const [key, n] of items) {
    const li = document.createElement("li");
    li.className = "node";
    li.innerHTML = `<div class="row ${active === key ? "on" : ""}">${dot ? `<span class="dot tagdot" ${tagStyle(key)}></span>` : `<span class="file"></span>`}<span class="lbl">${esc(key)}</span><span class="cnt">${n}</span></div>`;
    li.firstChild.onclick = () => go(hrefOf(key));
    ul.append(li);
  }
  return ul;
}
function renderTagNav() {
  const q = $("#search").value.trim().toLowerCase();
  const items = allTags().filter(([t]) => !q || t.toLowerCase().includes(q));
  const r = route();
  return items.length ? navList(items, (t) => `#/t/${encodeURIComponent(t)}`, r.kind === "t" ? r.arg : null, true)
    : Object.assign(document.createElement("div"), {className: "empty", textContent: "태그가 없어요"});
}
function renderYearNav() {
  const r = route();
  const ul = navList(allYears(), (y) => `#/y/${encodeURIComponent(y)}`, r.kind === "y" ? r.arg : null);
  ul.querySelectorAll(".file").forEach((s) => (s.textContent = ""));
  return ul;
}

/* ---------------- 메뉴 ---------------- */

function popMenu(e, items) {
  e.stopPropagation();
  document.querySelector(".menu")?.remove();
  const m = document.createElement("div");
  m.className = "menu";
  for (const [label, fn, cls] of items) {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = () => { m.remove(); guard(fn); };
    m.append(b);
  }
  document.body.append(m);
  const r = e.target.getBoundingClientRect();
  m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 8) + "px";
  m.style.top = Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8) + "px";
  setTimeout(() => document.addEventListener("click", () => m.remove(), {once: true}));
}

function folderMenu(e, folder) {
  const top = !folder.includes("/");
  popMenu(e, [
    ["여기에 새 글", () => newPage(folder)],
    ["여기에 하위 폴더", () => newTopic(folder)],
    ["여기에 파일 올리기", () => pickUpload(folder)],
    ...(top ? [["주제 이름·묶음 바꾸기", () => editTopic(folder)], ["주제 순서 바꾸기", reorderTopics]] : []),
    ["폴더 이름 바꾸기", () => renamePath(folder, true)],
    ["폴더 삭제", () => deletePath(folder, true), "danger"],
  ]);
}

/* ---------------- 라우팅 ---------------- */

const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
function route() {
  const m = (location.hash.slice(1) || "/").match(/^\/(p|t|y|f)\/(.+)$/);
  if (!m) return {kind: "home"};
  try {
    return {kind: m[1], arg: m[1] === "p" || m[1] === "f" ? m[2].split("/").map(decodeURIComponent).join("/") : decodeURIComponent(m[2])};
  } catch { return {kind: "home"}; }
}
async function go(hash) {
  if (S.editing && !(await leaveEditor())) return;
  S.editing = null;
  if (location.hash === hash) render(); else location.hash = hash;
  $("#sidebar").classList.remove("open");
}

async function render() {
  const r = route();
  S.current = r.kind === "p" ? r.arg : null;
  if (r.kind === "y") S.tab = "year";
  if (r.kind === "t") S.tab = "tag";
  renderNav();
  $("#editor").hidden = true;
  $("#screen").hidden = false;
  const screen = $("#screen");
  window.scrollTo(0, 0);
  if (r.kind === "home") return renderHome(screen);
  if (r.kind === "t") return renderList(screen, `태그`, r.arg, S.index.pages.filter((p) => p.tags.includes(r.arg)));
  if (r.kind === "y") return renderList(screen, `연도`, r.arg, S.index.pages.filter((p) => (p.date ? p.date.slice(0, 4) : "날짜 없음") === r.arg), true);
  if (r.kind === "f") return renderList(screen, topicGroup(r.arg.split("/")[0]), folderLabel(r.arg), S.index.pages.filter((p) => p.path.startsWith(r.arg + "/")), false, r.arg);
  if (r.kind === "p") return renderFileView(screen, r.arg);
}

/* ---------------- 홈 ---------------- */

function renderHome(el) {
  const pages = S.index.pages;
  const tags = allTags(), years = allYears();
  const topics = Object.entries(S.index.topics);
  const recent = [...pages].filter((p) => p.date).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 6);
  const maxY = Math.max(1, ...years.map((y) => y[1]));
  const groupsAll = [...GROUP_ORDER, ...new Set(topics.map(([, t]) => t.group || "기타").filter((g) => !GROUP_ORDER.includes(g)))];
  const byGroup = groupsAll.map((g) => [g, topics.filter(([, t]) => (t.group || "기타") === g).sort(([a], [b]) => cmpTopic(a, b))]).filter(([, l]) => l.length);
  const now = studyingNow();
  const act = monthlyActivity(12);
  const maxA = Math.max(1, ...act.map((a) => a.n));
  const last = act.filter((a) => a.n).length;
  el.innerHTML = `
    <section class="hero">
      <div class="hero-top">
        <div class="avatar">${esc(PROFILE.handle[0].toUpperCase())}</div>
        <div class="hero-id">
          <div class="kicker">${esc(PROFILE.role)} · @${esc(PROFILE.handle)}</div>
          <h1>${esc(PROFILE.name)}<small>의 공부 기록</small></h1>
          <p class="tagline">${esc(PROFILE.tagline)}</p>
          <div class="hero-links">${PROFILE.links.map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>`).join("")}</div>
        </div>
        ${now ? `<div class="now"><div class="l">지금 공부 중</div><b>${esc(now.tag)}</b><a href="#/p/${encPath(now.page.path)}">최근: ${esc(now.page.title)}</a></div>` : ""}
      </div>
      <div class="hero-stats">
        <div class="hs"><b>${pages.length}</b><span>글</span></div>
        <div class="hs"><b>${topics.length}</b><span>주제</span></div>
        <div class="hs"><b>${tags.length}</b><span>태그</span></div>
        <div class="hs"><b>${yearSpan()}</b><span>년째 기록</span></div>
        <div class="spark" title="최근 12개월 동안 쓴 글 수">
          <div class="bars">${act.map((a) => `<i class="${a.n ? "on" : ""}" style="height:${Math.max(3, (a.n / maxA) * 42)}px" title="${a.key} · ${a.n}개"></i>`).join("")}</div>
          <span>최근 12개월 · ${last}개월 동안 썼어요</span>
        </div>
      </div>
    </section>
    <section class="band">
      <div class="sec-head"><div class="num">01</div><h2>최근 글</h2></div>
      <div class="list">${recent.map(listItem).join("") || `<div class="empty">아직 글이 없어요</div>`}</div>
    </section>
    <section class="band alt">
      <div class="sec-head"><div class="num">02</div><h2>주제</h2><button class="btn small ghost" id="h-order">순서 바꾸기</button></div>
      ${byGroup.map(([g, list]) => `
        <div class="grp-h">${esc(g)}</div>
        <div class="cards">${list.map(([folder, t]) => {
          const ps = pages.filter((p) => p.path.startsWith(folder + "/"));
          const last = ps.map((p) => p.date).filter(Boolean).sort().pop();
          return `<a class="card" href="#/f/${encPath(folder)}" style="--c:${groupColor(t.group)}"><div class="g">${esc(t.group)}</div><h3>${esc(t.name)}</h3><div class="s">글 ${ps.length}개${last ? ` · 마지막 ${esc(last)}` : ""}</div></a>`;
        }).join("")}</div>`).join("")}
    </section>
    <section class="band">
      <div class="sec-head"><div class="num">03</div><h2>태그</h2></div>
      <div class="cloud">${tags.map(([t, n]) => `<a class="chip lg t" ${tagStyle(t)} href="#/t/${encodeURIComponent(t)}">${esc(t)} <b>${n}</b></a>`).join("")}</div>
    </section>
    <section class="band alt">
      <div class="sec-head"><div class="num">04</div><h2>연도</h2></div>
      <div class="years">${years.map(([y, n]) => `<a class="yr" href="#/y/${encodeURIComponent(y)}"><span class="y">${esc(y)}</span><span class="bar" style="width:${Math.max(2, (n / maxY) * 100)}%"></span><span class="n">${n}개</span></a>`).join("")}</div>
    </section>`;
  $("#h-order").onclick = () => guard(reorderTopics);
}

/* 최근 90일(없으면 가장 최근 글)에서 가장 많이 단 태그 */
function studyingNow() {
  const dated = S.index.pages.filter((p) => p.date).sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!dated.length) return null;
  const since = new Date(Date.now() - 90 * 864e5).toLocaleDateString("sv-SE");
  const recent = dated.filter((p) => p.date >= since);
  const pool = recent.length ? recent : dated.slice(0, 1);
  const count = new Map();
  for (const p of pool) for (const t of p.tags) count.set(t, (count.get(t) || 0) + 1);
  const tag = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!tag) return null;
  return {tag, page: pool.find((p) => p.tags.includes(tag))};
}

function yearSpan() {
  const ys = S.index.pages.map((p) => parseInt(p.date, 10)).filter((y) => y > 1900);
  return ys.length ? new Date().getFullYear() - Math.min(...ys) + 1 : 0;
}

function monthlyActivity(months) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = months - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
    out.push({key, n: S.index.pages.filter((p) => p.date.startsWith(key)).length});
  }
  return out;
}

function listItem(p) {
  const folder = p.path.split("/")[0];
  return `<a class="li" href="#/p/${encPath(p.path)}">
    <span class="tt">${esc(p.title)}</span>
    <span class="dt">${esc(p.date || "")}</span>
    <span class="sub"><span>${esc(topicName(folder))}${p.path.split("/").length > 2 ? ` / ${esc(p.path.split("/").slice(1, -1).map((d, i, a) => folderLabel([folder, ...a.slice(0, i + 1)].join("/"))).join(" / "))}` : ""}</span>${p.tags.map((t) => `<span class="tg" ${tagStyle(t)}>${esc(t)}</span>`).join("")}</span>
  </a>`;
}

function renderList(el, eyebrow, title, pages, byMonth = false, folder = null) {
  const sorted = [...pages].sort((a, b) => (folder ? cmpParts(a.path, b.path) : (a.date || "") < (b.date || "") ? 1 : -1));
  let body;
  if (byMonth) {
    const groups = new Map();
    for (const p of sorted) {
      const k = p.date ? `${Number(p.date.slice(5, 7))}월` : "날짜 없음";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    body = [...groups].map(([k, l]) => `<div class="month-h">${esc(k)}</div><div class="list">${l.map(listItem).join("")}</div>`).join("");
  } else body = `<div class="list">${sorted.map(listItem).join("") || `<div class="empty">글이 없어요</div>`}</div>`;
  el.innerHTML = `
    <header class="doc">
      <div class="eyebrow">${folder?.includes("/") ? crumbs(folder) : esc(eyebrow)}</div>
      <h1>${esc(title)}</h1>
      <p class="lead">글 ${pages.length}개</p>
      ${folder ? `<div class="toolbar"><button class="btn" id="l-new">여기에 새 글</button><button class="btn" id="l-sub">하위 폴더</button><button class="btn" id="l-up">파일 올리기</button>${folder.includes("/") ? "" : `<button class="btn" id="l-topic">이름·묶음 바꾸기</button>`}</div>` : ""}
    </header>
    ${body}`;
  if (folder) {
    $("#l-new").onclick = () => guard(() => newPage(folder));
    $("#l-up").onclick = () => pickUpload(folder);
    $("#l-sub").onclick = () => guard(() => newTopic(folder));
    $("#l-topic")?.addEventListener("click", () => guard(() => editTopic(folder)));
  }
}

/* ---------------- 글 보기 ---------------- */

async function renderFileView(el, path) {
  const f = S.files.get(path);
  if (!f) {
    el.innerHTML = `<header class="doc"><div class="eyebrow">없는 파일</div><h1>찾을 수 없어요</h1><p class="lead">${esc(path)} 이(가) 지워졌거나 이름이 바뀌었어요.</p></header>`;
    return;
  }
  const folder = path.split("/")[0];
  const ghUrl = `https://github.com/${S.cfg.owner}/${S.cfg.repo}/blob/${S.cfg.branch}/${encPath(path)}`;
  const tools = `<div class="toolbar">
      ${path.endsWith(".md") ? `<button class="btn" id="v-edit">수정</button><button class="btn" id="v-child">하위 글 쓰기</button>` : ""}
      <button class="btn" id="v-rename">이름·위치 바꾸기</button>
      <button class="btn danger" id="v-delete">삭제</button>
      <a class="btn ghost" href="${ghUrl}" target="_blank" rel="noopener">GitHub에서 보기</a>
    </div>`;
  if (!path.endsWith(".md")) {
    const url = await blobURL(path);
    const isImg = IMG_EXT.test(path);
    el.innerHTML = `<header class="doc"><div class="eyebrow">${esc(topicName(folder))}</div><h1>${esc(path.split("/").pop())}</h1>
      <dl class="meta"><div class="r"><dt>경로</dt><dd>${esc(path)}</dd></div><div class="r"><dt>크기</dt><dd>${f.size != null ? `${(f.size / 1024).toFixed(1)} KB` : "-"}</dd></div></dl>${tools}</header>
      <article class="prose">${isImg ? `<img src="${url}" alt="">` : `<p><a href="${url}" download="${esc(path.split("/").pop())}">내려받기</a></p>`}</article>`;
    bindFileTools(path);
    return;
  }
  el.innerHTML = `<header class="doc"><div class="eyebrow">${esc(topicName(folder))}</div><h1>불러오는 중…</h1></header>`;
  const text = await fileText(path);
  if (S.current !== path) return;
  const {meta, body} = parseFrontMatter(text);
  const title = meta.title || stem(path);
  const tags = meta.tags || [];
  const content = body.replace(new RegExp(`^\\s*# ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n`), "");
  el.innerHTML = `
    <header class="doc">
      <div class="eyebrow">${crumbs(path)}</div>
      <h1>${esc(title)}</h1>
      <dl class="meta">
        ${meta.date ? `<div class="r"><dt>작성일</dt><dd><a href="#/y/${esc(encodeURIComponent(meta.date.slice(0, 4)))}">${esc(meta.date)}</a></dd></div>` : ""}
        ${tags.length ? `<div class="r"><dt>태그</dt><dd>${tags.map((t) => `<a class="chip t" ${tagStyle(t)} href="#/t/${encodeURIComponent(t)}">${esc(t)}</a>`).join("")}</dd></div>` : ""}
        ${/^https?:\/\//.test(meta.source || "") ? `<div class="r"><dt>원본</dt><dd><a href="${esc(meta.source)}" target="_blank" rel="noopener">노션에서 보기</a></dd></div>` : ""}
      </dl>
      ${tools}
    </header>
    <div class="doc-wrap"><article class="prose" id="doc"></article><nav class="otoc" id="otoc"></nav></div>`;
  const art = $("#doc");
  await renderMarkdown(art, content, path);
  buildOutline(art);
  bindFileTools(path);
}

function bindFileTools(path) {
  $("#v-edit")?.addEventListener("click", () => guard(async () => { if (await ensureAuth()) await openEditor(path); }));
  $("#v-child")?.addEventListener("click", () => guard(() => newPage(path.replace(/\.md$/, ""))));
  $("#v-rename").onclick = () => guard(() => renamePath(path, false));
  $("#v-delete").onclick = () => guard(() => deletePath(path, false));
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function resolvePath(base, rel) {
  const parts = base.split("/").slice(0, -1);
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

async function renderMarkdown(el, md, path) {
  const html = marked.parse(md, {gfm: true, breaks: false});
  el.innerHTML = DOMPurify.sanitize(html, {ADD_TAGS: ["details", "summary"], ADD_ATTR: ["open", "target"]});
  let n = 0;
  for (const h of el.querySelectorAll("h1,h2,h3,h4")) h.id = `h-${++n}`;
  for (const a of el.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (/^(https?:|mailto:)/.test(href)) { a.target = "_blank"; a.rel = "noopener"; continue; }
    if (href.startsWith("#")) continue;
    const target = resolvePath(path, safeDecode(href.split("#")[0]));
    if (S.files.has(target)) a.setAttribute("href", `#/p/${encPath(target)}`);
    else { a.classList.add("missing"); a.title = "저장소에 없는 파일"; }
  }
  await Promise.all([...el.querySelectorAll("img")].map(async (img) => {
    const src = img.getAttribute("src") || "";
    if (/^(https?:|data:|blob:)/.test(src)) return;
    const target = resolvePath(path, safeDecode(src));
    img.removeAttribute("src");
    img.classList.add("loading");
    img.loading = "lazy";
    try {
      const url = await blobURL(target);
      if (url) img.src = url; else img.alt = `없는 이미지: ${target}`;
    } catch { img.alt = `불러오지 못한 이미지: ${target}`; }
    img.classList.remove("loading");
  }));
}

function buildOutline(art) {
  const nav = $("#otoc");
  const hs = [...art.querySelectorAll("h2,h3")];
  if (hs.length < 3) { nav.remove(); art.parentElement.classList.add("no-toc"); return; }
  nav.innerHTML = `<div class="h">이 글의 목차</div>` + hs.map((h) => `<a href="#" data-id="${h.id}" class="${h.tagName === "H3" ? "l3" : ""}">${esc(h.textContent)}</a>`).join("");
  nav.onclick = (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    e.preventDefault();
    document.getElementById(a.dataset.id).scrollIntoView({behavior: "smooth"});
  };
  const links = new Map([...nav.querySelectorAll("a")].map((a) => [a.dataset.id, a]));
  const io = new IntersectionObserver((ents) => {
    for (const en of ents) if (en.isIntersecting) {
      links.forEach((a) => a.classList.remove("on"));
      links.get(en.target.id)?.classList.add("on");
    }
  }, {rootMargin: "-60px 0px -70% 0px"});
  hs.forEach((h) => io.observe(h));
}

/* ---------------- 편집 ---------------- */

const today = () => new Date().toLocaleDateString("sv-SE");
const splitTags = (s) => [...new Set(s.split(",").map((t) => t.trim()).filter(Boolean))];

function composeDoc(title, date, tags, body, source) {
  const fm = ["---", `title: ${JSON.stringify(title)}`];
  if (date) fm.push(`date: ${date}`);
  fm.push(`tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`); // tools/build_index.py 의 json.dumps 와 같은 모양
  if (source) fm.push(`source: ${source}`);
  fm.push("---", "", `# ${title}`, "");
  return fm.join("\n") + "\n" + body.replace(/^\s+/, "");
}

async function openEditor(path, preset = null) {
  let meta = {}, body = "", sha = null;
  if (preset) ({meta, body} = preset);
  else {
    sha = S.files.get(path).sha;
    ({meta, body} = parseFrontMatter(await fileText(path)));
    const title = meta.title || stem(path);
    body = body.replace(new RegExp(`^\\s*# ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n`), "");
  }
  S.editing = {path, sha, isNew: !!preset, source: meta.source || "", orig: null};
  $("#editor-path").textContent = (preset ? "새 글 · " : "수정 · ") + path;
  $("#e-title").value = meta.title || stem(path);
  $("#e-date").value = meta.date || "";
  $("#e-tags").value = (meta.tags || []).join(", ");
  $("#source").value = body.replace(/^\n+/, "");
  S.editing.orig = snapshot();
  $("#screen").hidden = true;
  $("#editor").hidden = false;
  window.scrollTo(0, 0);
  updatePreview();
  $("#source").focus();
}

const snapshot = () => [$("#e-title").value, $("#e-date").value, $("#e-tags").value, $("#source").value].join("\u0000");
const dirty = () => S.editing && snapshot() !== S.editing.orig;

let previewTimer;
function updatePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => S.editing && renderMarkdown($("#preview"), $("#source").value, S.editing.path), 200);
}

async function leaveEditor() {
  if (dirty() && !(await confirmBox("저장하지 않고 나갈까요?", "<p>고친 내용이 사라져요.</p>", "나가기", true))) return false;
  S.editing = null;
  $("#editor").hidden = true;
  $("#screen").hidden = false;
  return true;
}

async function saveEditor() {
  const ed = S.editing;
  const title = $("#e-title").value.trim() || stem(ed.path);
  const text = composeDoc(title, $("#e-date").value, splitTags($("#e-tags").value), $("#source").value, ed.source);
  await loadTree();
  const now = S.files.get(ed.path);
  if (ed.isNew && now) {
    if (!(await confirmBox("같은 이름의 파일이 이미 있어요", `<p><code>${esc(ed.path)}</code> 을(를) 덮어쓸까요?</p>`, "덮어쓰기", true))) return;
  } else if (!ed.isNew && now && now.sha !== ed.sha) {
    if (!(await confirmBox("다른 곳에서 먼저 고쳤어요", "<p>편집을 시작한 뒤 이 글이 바뀌었어요. 내 내용으로 덮어쓸까요?</p>", "덮어쓰기", true))) return;
  }
  await commit([{path: ed.path, text}], `${ed.isNew ? "새 글" : "수정"}: ${ed.path}`);
  S.editing = null;
  toast("저장했어요");
  go(`#/p/${encPath(ed.path)}`);
}

/* 폴더 바로 아래 글·폴더 이름의 다음 번호 (02-X.md 와 짝 폴더 02-X/ 는 같은 번호) */
function nextNum(folder) {
  const pre = folder ? folder + "/" : "";
  const nums = [...S.files.keys()].filter((p) => p.startsWith(pre))
    .map((p) => parseInt(p.slice(pre.length).split("/")[0], 10)).filter((n) => !isNaN(n));
  return String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, "0");
}
const safeName = (t, dflt) => t.replace(/[\\/:*?"<>|#%]/g, "-").replace(/\s+/g, " ").trim().slice(0, 60) || dflt;

/* 파일 이름: 폴더 안 다음 번호 + 제목 */
function nextFileName(folder, title) {
  return `${folder}/${nextNum(folder)}-${safeName(title, "새 글")}.md`;
}

function folderOptions() {
  const dirs = new Set();
  for (const p of S.files.keys()) {
    const parts = p.split("/");
    if (!isPage(p)) continue;
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs].filter((d) => !d.split("/").includes("images")).sort(cmpParts)
    .map((d) => [d, d.split("/").map((_, i, a) => folderLabel(a.slice(0, i + 1).join("/"))).join(" / ")]);
}

function currentFolder() {
  const r = route();
  if (r.kind === "f") return r.arg;
  if (r.kind === "p") return r.arg.split("/").slice(0, -1).join("/");
  return folderOptions()[0]?.[0] || "";
}

async function newPage(folder) {
  if (!(await ensureAuth())) return;
  folder ||= currentFolder();
  const options = folderOptions();
  if (folder && !options.some(([d]) => d === folder)) options.push([folder, folder.split("/").map((_, i, a) => folderLabel(a.slice(0, i + 1).join("/"))).join(" / ")]);
  const v = await modal({
    title: "새 글",
    fields: [
      {name: "folder", label: "넣을 곳", type: "select", options, value: folder},
      {name: "title", label: "제목", required: true},
      {name: "tags", label: "태그", hint: "쉼표로 구분", list: "tag-list"},
      {name: "date", label: "날짜", type: "date", value: today()},
    ],
    ok: "쓰기 시작",
  });
  if (!v || !v.title) return;
  const path = nextFileName(v.folder, v.title);
  await openEditor(path, {meta: {title: v.title, date: v.date, tags: splitTags(v.tags)}, body: ""});
}

/* 새 주제(맨 위 폴더) 또는 하위 폴더. 깃은 빈 폴더를 못 담아서 첫 글을 같이 만든다 */
async function newTopic(parent = "") {
  if (!(await ensureAuth())) return;
  const top = (v) => !v.parent;
  const v = await modal({
    title: "새 주제·폴더",
    html: "<p>상위 폴더를 고르면 그 안에 하위 폴더를 만들어요. 깊이 제한은 없어요. 첫 글을 같이 만들어야 폴더가 생겨요.</p>",
    fields: [
      {name: "parent", label: "상위 폴더", type: "select", options: [["", "(맨 위 — 새 주제)"], ...folderOptions()], value: parent},
      {name: "name", label: "이름", required: true},
      {name: "folder", label: "폴더 이름", hint: "영어 소문자·숫자·- (예: kotlin)", required: true, when: top},
      {name: "group", label: "묶음", list: "group-list", value: "기타", when: top},
      {name: "title", label: "첫 글 제목", required: true},
    ],
    ok: "만들기",
  });
  if (!v || !v.name || !v.title) return;
  let folder;
  if (v.parent) {
    folder = `${v.parent}/${nextNum(v.parent)}-${safeName(v.name, "새 폴더")}`;
  } else {
    folder = v.folder.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
    if (!folder) return toast("폴더 이름이 필요해요 (영어 소문자·숫자·-)", true);
    if (HIDDEN_DIRS.includes(folder)) return toast("쓸 수 없는 폴더 이름이에요", true);
  }
  if ([...S.files.keys()].some((p) => p.startsWith(folder + "/"))) return toast("이미 있는 폴더예요", true);
  const path = `${folder}/01-${safeName(v.title, "새 글")}.md`;
  const changes = [{path, text: composeDoc(v.title, today(), [], "")}];
  if (!v.parent) changes.push({path: "__topic__", topic: {[folder]: {name: v.name, group: v.group || "기타", order: nextOrder()}}});
  await commit(changes, v.parent ? `새 폴더: ${folder}` : `새 주제: ${v.name}`);
  if (v.parent) S.open.add(v.parent);
  toast(v.parent ? "폴더를 만들었어요" : "주제를 만들었어요");
  go(`#/p/${encPath(path)}`);
}

async function editTopic(folder) {
  if (!(await ensureAuth())) return;
  const t = S.index.topics[folder] || {name: folder, group: "기타"};
  const v = await modal({
    title: "주제 이름·묶음",
    fields: [{name: "name", label: "주제 이름", value: t.name, required: true}, {name: "group", label: "묶음", value: t.group, list: "group-list"}],
  });
  if (!v || !v.name) return;
  const group = v.group || "기타";
  const order = group === t.group && t.order != null ? t.order : nextOrder();
  await commit([{path: "__topic__", topic: {[folder]: {name: v.name, group, order}}}], `주제 이름: ${folder} → ${v.name}`);
  toast("바꿨어요");
  render();
}

/* 주제 순서: 묶음 안에서 ↑↓ 로 옮기고, 확인하면 모든 주제에 order 를 1부터 다시 매긴다 */
async function reorderTopics() {
  if (!(await ensureAuth())) return;
  const folders = Object.keys(S.index.topics);
  const groups = [...GROUP_ORDER, ...new Set(folders.map(topicGroup).filter((g) => !GROUP_ORDER.includes(g)))]
    .map((g) => [g, folders.filter((f) => topicGroup(f) === g).sort(cmpTopic)]).filter(([, l]) => l.length);
  const html = `<p>같은 묶음 안에서 순서를 바꿔요. 다른 묶음으로 옮기려면 「주제 이름·묶음 바꾸기」를 쓰세요.</p>
    <div class="reorder">${groups.map(([g, l]) => `<div class="ro-g"><div class="ro-h">${esc(g)}</div><ol>${l.map((f) => `
      <li data-folder="${esc(f)}"><span class="dot" style="background:${groupColor(g)}"></span><span class="lbl">${esc(topicName(f))}</span>
        <button type="button" class="btn small ghost" data-mv="-1" aria-label="위로">↑</button><button type="button" class="btn small ghost" data-mv="1" aria-label="아래로">↓</button></li>`).join("")}</ol></div>`).join("")}</div>`;
  const v = await modal({
    title: "주제 순서", html, ok: "저장",
    onOpen: (body) => body.querySelector(".reorder").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mv]");
      if (!b) return;
      const li = b.closest("li");
      if (b.dataset.mv === "-1" && li.previousElementSibling) li.previousElementSibling.before(li);
      if (b.dataset.mv === "1" && li.nextElementSibling) li.nextElementSibling.after(li);
      b.focus();
    }),
    read: (body) => ({order: [...body.querySelectorAll(".reorder li")].map((li) => li.dataset.folder)}),
  });
  if (!v) return;
  const topic = {};
  v.order.forEach((f, i) => { topic[f] = {name: topicName(f), group: topicGroup(f), order: i + 1}; });
  if (v.order.every((f) => S.index.topics[f].order === topic[f].order)) return toast("바뀐 순서가 없어요");
  await commit([{path: "__topic__", topic}], "주제 순서 바꾸기");
  toast("순서를 바꿨어요");
  render();
}

/* ---------------- 이름 바꾸기·삭제·올리기 ---------------- */

function underPath(path, isDir) {
  return isDir ? [...S.files.keys()].filter((p) => p.startsWith(path + "/")) : [path];
}

async function renamePath(path, isDir) {
  if (!(await ensureAuth())) return;
  const sub = !isDir && path.endsWith(".md") ? path.replace(/\.md$/, "") : null;
  const hasSub = sub && [...S.files.keys()].some((p) => p.startsWith(sub + "/"));
  const v = await modal({
    title: isDir ? "폴더 이름 바꾸기" : "이름·위치 바꾸기",
    html: "<p>경로를 바꾸면 그 위치로 옮겨져요. 다른 글에서 이 파일을 가리키던 링크는 자동으로 바뀌지 않아요.</p>",
    fields: [{name: "to", label: "새 경로", value: path, required: true}],
    ok: "바꾸기",
  });
  if (!v || !v.to || v.to === path) return;
  const to = v.to.replace(/^\/+|\/+$/g, "");
  if (!isDir && path.endsWith(".md") && !to.endsWith(".md")) return toast("글 파일은 .md 로 끝나야 해요", true);
  const moves = underPath(path, isDir).map((p) => [p, to + p.slice(path.length)]);
  if (hasSub) {
    const toSub = to.replace(/\.md$/, "");
    for (const p of underPath(sub, true)) moves.push([p, toSub + p.slice(sub.length)]);
  }
  const clash = moves.find(([, n]) => S.files.has(n));
  if (clash) return toast(`이미 있는 경로예요: ${clash[1]}`, true);
  const changes = [];
  for (const [from, dest] of moves) {
    changes.push({path: dest, sha: S.files.get(from).sha}, {path: from, delete: true});
  }
  if (isDir && !path.includes("/") && !to.includes("/") && S.index.topics[path]) {
    changes.push({path: "__topic__", topic: {[to]: S.index.topics[path]}});
  }
  await commit(changes, `옮기기: ${path} → ${to}`);
  toast("옮겼어요");
  go(isDir ? `#/f/${encPath(to)}` : `#/p/${encPath(to)}`);
}

async function deletePath(path, isDir) {
  if (!(await ensureAuth())) return;
  const sub = !isDir && path.endsWith(".md") ? path.replace(/\.md$/, "") : null;
  const subFiles = sub ? underPath(sub, true) : [];
  const list = underPath(path, isDir);
  const fields = subFiles.length ? [{name: "withSub", label: `하위 글·파일 ${subFiles.length}개도 같이 지우기`, type: "checkbox", value: true}] : [];
  const v = await modal({
    title: isDir ? "폴더 삭제" : "삭제",
    html: `<p><code>${esc(path)}</code>${isDir ? ` 안의 파일 ${list.length}개를` : " 을(를)"} 지울까요? GitHub 기록(커밋)에는 남아서 나중에 되살릴 수 있어요.</p>`,
    fields, ok: "삭제", danger: true,
  });
  if (!v) return;
  const targets = [...list, ...(v.withSub ? subFiles : [])];
  await commit(targets.map((p) => ({path: p, delete: true})), `삭제: ${path}${targets.length > 1 ? ` (${targets.length}개)` : ""}`);
  toast("지웠어요");
  const parent = path.split("/").slice(0, -1).join("/");
  go(parent && [...S.files.keys()].some((p) => p.startsWith(parent + "/")) ? `#/f/${encPath(parent)}` : "#/");
}

let uploadFolder = "";
function pickUpload(folder = currentFolder()) {
  uploadFolder = folder;
  $("#file-input").value = "";
  $("#file-input").click();
}

async function uploadFiles(files, folder) {
  if (!(await ensureAuth())) return;
  files = [...files];
  if (!files.length) return;
  const v = await modal({
    title: "파일 올리기",
    html: `<div class="files">${files.map((f) => `${esc(f.name)} <span class="hint">${(f.size / 1024).toFixed(0)} KB</span>`).join("<br>")}</div><p class="hint">그림은 그 주제의 <code>images/</code> 폴더에, 나머지는 고른 폴더에 올려요. 같은 이름이 있으면 덮어써요.</p>`,
    fields: [{name: "folder", label: "올릴 곳", type: "select", options: folderOptions(), value: folder}],
    ok: `${files.length}개 올리기`,
  });
  if (!v) return;
  if (!v.folder) return toast("올릴 폴더를 골라 주세요", true);
  const changes = [];
  for (const f of files) {
    if (f.size > 50 * 1024 * 1024) { toast(`${f.name}: 50MB 넘는 파일은 못 올려요`, true); continue; }
    const bytes = new Uint8Array(await f.arrayBuffer());
    const dir = IMG_EXT.test(f.name) ? `${v.folder.split("/")[0]}/images` : v.folder;
    changes.push({path: `${dir}/${f.name.replace(/[\\/:*?"<>|#%]/g, "-")}`, base64: b64FromBytes(bytes)});
  }
  if (!changes.length) return;
  await commit(changes, `올리기: ${changes.map((c) => c.path).join(", ")}`.slice(0, 200));
  toast(`${changes.length}개 올렸어요`);
  go(changes.length === 1 ? `#/p/${encPath(changes[0].path)}` : `#/f/${encPath(v.folder)}`);
}

/* 편집 중 이미지: 바로 올리고 본문에 링크를 넣는다 */
function relPath(fromFile, target) {
  const a = fromFile.split("/").slice(0, -1), b = target.split("/");
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}
async function insertImages(files) {
  files = [...files].filter((f) => IMG_EXT.test(f.name));
  if (!files.length || !S.editing) return;
  const topic = S.editing.path.split("/")[0];
  const changes = [];
  for (const f of files) {
    const name = `${Date.now().toString(36)}-${f.name.replace(/[\\/:*?"<>|#%\s]/g, "-")}`;
    changes.push({path: `${topic}/images/${name}`, base64: b64FromBytes(new Uint8Array(await f.arrayBuffer()))});
  }
  await commit(changes, `이미지 올리기: ${S.editing.path}`);
  const ta = $("#source");
  const md = changes.map((c) => `![](${relPath(S.editing.path, c.path).split("/").map(encodeURIComponent).join("/")})`).join("\n\n");
  const pos = ta.selectionStart;
  ta.setRangeText(`\n${md}\n`, pos, ta.selectionEnd, "end");
  updatePreview();
  toast("이미지를 넣었어요");
}

/* ---------------- 시작 ---------------- */

function loadCfg() {
  try { return {...DEFAULT_CFG, ...(JSON.parse(localStorage.getItem(CFG_KEY)) || {})}; } catch { return {...DEFAULT_CFG}; }
}
const saveCfg = () => localStorage.setItem(CFG_KEY, JSON.stringify(S.cfg));

function authError(e) {
  return {
    401: "토큰이 틀렸거나 만료·폐기됐어요. 새 토큰을 넣어 주세요.",
    403: "토큰에 권한이 부족해요. 토큰 설정에서 Contents 를 Read and write 로 바꿔 주세요.",
    404: `이 토큰으로는 ${S.cfg.owner}/${S.cfg.repo} 가 안 보여요. 토큰 설정의 Repository access 에 이 저장소(사이트 코드 저장소가 아닌 글 저장소)가 들어 있는지 확인해 주세요.`,
  }[e.status];
}

function updateAuthUI() {
  $("#btn-logout").textContent = authed() ? "로그아웃" : "로그인";
  $("#show-hidden").closest("label").hidden = !authed();
  if (!authed()) $("#show-hidden").checked = false;
}

function clearCaches() {
  S.blobCache.forEach((u) => URL.revokeObjectURL(u));
  S.blobCache.clear();
  S.textCache.clear();
}

/* 쓰기 전에 부른다. 토큰이 없으면 입력받아 확인하고, 실패하면 보기 전용으로 남는다. */
async function ensureAuth() {
  if (authed()) return true;
  const v = await modal({
    title: "로그인",
    html: `<p>쓰고 고치고 지우려면 GitHub 토큰이 필요해요. 토큰은 이 브라우저에만 저장돼요.</p>
      <details class="help"><summary>토큰 만드는 법</summary><ol>
        <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Fine-grained token 만들기</a>를 열어요.</li>
        <li>Repository access 에서 <b>Only select repositories</b> → <code>${esc(S.cfg.owner)}/${esc(S.cfg.repo)}</code> 하나만 골라요. 사이트 코드 저장소(<code>study-notes-site</code>)가 아니에요.</li>
        <li>Permissions → Repository permissions → <b>Contents: Read and write</b> 만 줘요.</li>
      </ol></details>`,
    fields: [{name: "token", label: "GitHub 토큰", type: "password", required: true}],
    ok: "로그인",
  });
  if (!v || !v.token) return false;
  S.cfg = {...S.cfg, token: v.token};
  try {
    await loadTree();
  } catch (e) {
    const why = authError(e);
    S.cfg = {...S.cfg, token: undefined};
    await loadTree().catch(() => {});
    updateAuthUI();
    toast(why ? `로그인하지 못했어요 (${e.status}). ${why}` : `로그인하지 못했어요: ${e.message}`, true);
    return false;
  }
  saveCfg();
  clearCaches();
  updateAuthUI();
  renderNav();
  toast("로그인했어요");
  return true;
}

async function start() {
  S.cfg = loadCfg();
  $("#app").hidden = false;
  try { await loadTree(); }
  catch (e) {
    if (!authed() || !authError(e)) throw e;
    toast(`저장된 토큰으로 들어가지 못해 보기 전용으로 열었어요. ${authError(e)}`, true);
    S.cfg = {...S.cfg, token: undefined};
    saveCfg();
    await loadTree();
  }
  updateAuthUI();
  render();
}

$("#btn-logout").onclick = () => guard(async () => {
  if (!authed()) { if (await ensureAuth()) render(); return; }
  if (S.editing && !(await leaveEditor())) return;
  S.cfg = {...S.cfg, token: undefined};
  saveCfg();
  clearCaches();
  await loadTree();
  updateAuthUI();
  toast("로그아웃했어요. 계속 읽을 수는 있어요.");
  render();
});

$$(".topnav button").forEach((b) => (b.onclick = () => {
  S.tab = b.dataset.jump;
  renderNav();
  if (innerWidth <= 900) $("#sidebar").classList.add("open");
}));
$("#brand-mono").textContent = PROFILE.handle[0].toUpperCase();
$("#brand-name").textContent = PROFILE.handle;
document.title = `${PROFILE.name}의 공부 기록`;
$$(".tabs button").forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; renderNav(); }));
$("#search").oninput = () => renderNav();
$("#show-hidden").onchange = () => renderNav();
$("#btn-menu").onclick = () => $("#sidebar").classList.toggle("open");
$("#btn-new-page").onclick = () => guard(() => newPage());
$("#btn-new-topic").onclick = () => guard(() => newTopic());
$("#btn-order").onclick = () => guard(reorderTopics);
$("#btn-upload").onclick = () => pickUpload();
$("#file-input").onchange = (e) => guard(() => uploadFiles(e.target.files, uploadFolder));
$("#btn-insert-image").onclick = () => { $("#image-input").value = ""; $("#image-input").click(); };
$("#image-input").onchange = (e) => guard(() => insertImages(e.target.files));
$("#btn-save").onclick = () => guard(saveEditor);
$("#btn-cancel").onclick = async () => { const p = S.editing?.path; if (await leaveEditor()) go(S.files.has(p) ? `#/p/${encPath(p)}` : "#/"); };
["#source", "#e-title"].forEach((s) => $(s).addEventListener("input", updatePreview));
$("#source").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); guard(saveEditor); }
  if (e.key === "Tab") { e.preventDefault(); e.target.setRangeText("  ", e.target.selectionStart, e.target.selectionEnd, "end"); }
});
let lastHash = location.hash;
window.addEventListener("hashchange", async () => {
  if (S.editing) {
    if (dirty() && !(await confirmBox("저장하지 않고 나갈까요?", "<p>고친 내용이 사라져요.</p>", "나가기", true))) {
      history.replaceState(null, "", lastHash || "#/");
      return;
    }
    S.editing = null;
  }
  lastHash = location.hash;
  guard(render);
});
window.addEventListener("beforeunload", (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ""; } });

/* 끌어다 놓기: 편집 중이면 본문에 이미지, 아니면 지금 폴더에 올리기 */
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files") || $("#app").hidden) return;
  dragDepth++;
  $("#drop-target").textContent = S.editing ? "이 글 (이미지)" : currentFolder() || "폴더";
  $("#drop").hidden = false;
});
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#drop").hidden = true; } });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("#drop").hidden = true;
  if ($("#app").hidden || !e.dataTransfer?.files.length) return;
  if (S.editing) guard(() => insertImages(e.dataTransfer.files));
  else guard(() => uploadFiles(e.dataTransfer.files, currentFolder()));
});

guard(start);
