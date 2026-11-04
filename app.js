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
const CFG_KEY = "study-notes.cfg";
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

async function loadTree() {
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
}

async function blobBytes(sha) {
  const b = await gh(`/git/blobs/${sha}`);
  const bin = atob(b.content.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function blobText(sha) {
  if (S.textCache.has(sha)) return S.textCache.get(sha);
  const t = new TextDecoder("utf-8", {ignoreBOM: true}).decode(await blobBytes(sha));
  S.textCache.set(sha, t);
  return t;
}

async function blobURL(path) {
  const f = S.files.get(path);
  if (!f) return null;
  if (S.blobCache.has(f.sha)) return S.blobCache.get(f.sha);
  const ext = path.split(".").pop().toLowerCase();
  let data = await blobBytes(f.sha);
  if (ext === "svg") data = DOMPurify.sanitize(new TextDecoder().decode(data), {USE_PROFILES: {svg: true, svgFilters: true}});
  const url = URL.createObjectURL(new Blob([data], {type: MIME[ext] || "application/octet-stream"}));
  S.blobCache.set(f.sha, url);
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
    if (text == null && c.base64 != null) text = new TextDecoder("utf-8", {ignoreBOM: true}).decode(Uint8Array.from(atob(c.base64), (ch) => ch.charCodeAt(0)));
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
    toast(e.status === 401 ? "토큰이 만료됐거나 틀렸어요. 나가기 후 다시 들어와 주세요." : e.status === 403 || e.status === 404 ? `권한이 없거나 찾을 수 없어요 (${e.message})` : `실패했어요: ${e.message}`, true);
  }
}

/* 모달: fields = [{name, label, value, type, options, hint, list}] → 값 객체, 취소면 null */
function modal({title, html = "", fields = [], ok = "확인", danger = false}) {
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
      }
      el.name = f.name;
      if (f.type !== "checkbox") lab.append(el);
      body.append(lab);
    }
    const okBtn = $("#modal-ok");
    okBtn.textContent = ok;
    okBtn.className = "btn " + (danger ? "danger" : "primary");
    d.onclose = () => {
      if (d.returnValue !== "ok") return resolve(null);
      const out = {};
      for (const f of fields) {
        const el = body.querySelector(`[name="${f.name}"]`);
        out[f.name] = f.type === "checkbox" ? el.checked : el.value.trim();
      }
      resolve(out);
    };
    d.returnValue = "";
    d.showModal();
    const first = body.querySelector("input:not([type=checkbox]),select");
    if (first) first.focus();
  });
}
const confirmBox = (title, html, ok = "확인", danger = false) => modal({title, html, ok, danger}).then((v) => v !== null);

/* ---------------- 탐색 데이터 ---------------- */

const pageOf = (path) => S.index.pages.find((p) => p.path === path);
const topicName = (folder) => S.index.topics[folder]?.name || folder;
const topicGroup = (folder) => S.index.topics[folder]?.group || "기타";
const groupColor = (g) => `var(${GROUP_COLOR[g] || "--line-2"})`;
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
  const nav = $("#nav");
  nav.innerHTML = "";
  if (S.tab === "topic") nav.append(renderTopicTree());
  if (S.tab === "tag") nav.append(renderTagNav());
  if (S.tab === "year") nav.append(renderYearNav());
  $("#count-badge").textContent = `${S.index.pages.length}`;
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
    for (const node of groups.get(g).sort((a, b) => topicName(a.name).localeCompare(topicName(b.name), "ko"))) {
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

function navList(items, hrefOf, active) {
  const ul = document.createElement("ul");
  for (const [key, n] of items) {
    const li = document.createElement("li");
    li.className = "node";
    li.innerHTML = `<div class="row ${active === key ? "on" : ""}"><span class="file">#</span><span class="lbl">${esc(key)}</span><span class="cnt">${n}</span></div>`;
    li.firstChild.onclick = () => go(hrefOf(key));
    ul.append(li);
  }
  return ul;
}
function renderTagNav() {
  const q = $("#search").value.trim().toLowerCase();
  const items = allTags().filter(([t]) => !q || t.toLowerCase().includes(q));
  const r = route();
  return items.length ? navList(items, (t) => `#/t/${encodeURIComponent(t)}`, r.kind === "t" ? r.arg : null)
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
    ["여기에 파일 올리기", () => pickUpload(folder)],
    ...(top ? [["주제 이름·묶음 바꾸기", () => editTopic(folder)]] : []),
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
  if (r.kind === "f") return renderList(screen, topicGroup(r.arg.split("/")[0]), r.arg.includes("/") ? prettyName(r.arg.split("/").pop()) : topicName(r.arg), S.index.pages.filter((p) => p.path.startsWith(r.arg + "/")), false, r.arg);
  if (r.kind === "p") return renderFileView(screen, r.arg);
}

/* ---------------- 홈 ---------------- */

function renderHome(el) {
  const pages = S.index.pages;
  const tags = allTags(), years = allYears();
  const topics = Object.entries(S.index.topics);
  const recent = [...pages].filter((p) => p.date).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 6);
  const maxY = Math.max(1, ...years.map((y) => y[1]));
  const byGroup = GROUP_ORDER.map((g) => [g, topics.filter(([, t]) => (t.group || "기타") === g)]).filter(([, l]) => l.length);
  el.innerHTML = `
    <header class="doc">
      <div class="eyebrow">Study notes</div>
      <h1>공부 기록</h1>
      <p class="lead">공부하면서 정리한 글을 주제·태그·연도로 모아 봐요. 왼쪽 목록에서 고르거나, 위의 <b>새 글</b> 로 바로 써요.</p>
      <div class="stats">
        <div class="stat"><b>${pages.length}</b><span>글</span></div>
        <div class="stat"><b>${topics.length}</b><span>주제</span></div>
        <div class="stat"><b>${tags.length}</b><span>태그</span></div>
        <div class="stat"><b>${years.filter(([y]) => /^\d/.test(y)).length}</b><span>연도</span></div>
      </div>
    </header>
    <section class="band">
      <div class="sec-head"><div class="num">01</div><h2>최근 글</h2></div>
      <div class="list">${recent.map(listItem).join("") || `<div class="empty">아직 글이 없어요</div>`}</div>
    </section>
    <section class="band alt">
      <div class="sec-head"><div class="num">02</div><h2>주제</h2></div>
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
      <div class="cloud">${tags.map(([t, n]) => `<a class="chip lg" href="#/t/${encodeURIComponent(t)}">${esc(t)} <b>${n}</b></a>`).join("")}</div>
    </section>
    <section class="band alt">
      <div class="sec-head"><div class="num">04</div><h2>연도</h2></div>
      <div class="years">${years.map(([y, n]) => `<a class="yr" href="#/y/${encodeURIComponent(y)}"><span class="y">${esc(y)}</span><span class="bar" style="width:${Math.max(2, (n / maxY) * 100)}%"></span><span class="n">${n}개</span></a>`).join("")}</div>
    </section>`;
}

function listItem(p) {
  const folder = p.path.split("/")[0];
  return `<a class="li" href="#/p/${encPath(p.path)}">
    <span class="tt">${esc(p.title)}</span>
    <span class="dt">${esc(p.date || "")}</span>
    <span class="sub"><span>${esc(topicName(folder))}</span>${p.tags.map((t) => `<span class="tg">${esc(t)}</span>`).join("")}</span>
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
      <div class="eyebrow">${esc(eyebrow)}</div>
      <h1>${esc(title)}</h1>
      <p class="lead">글 ${pages.length}개</p>
      ${folder ? `<div class="toolbar"><button class="btn" id="l-new">이 주제에 새 글</button><button class="btn" id="l-up">파일 올리기</button>${folder.includes("/") ? "" : `<button class="btn" id="l-topic">이름·묶음 바꾸기</button>`}</div>` : ""}
    </header>
    ${body}`;
  if (folder) {
    $("#l-new").onclick = () => guard(() => newPage(folder));
    $("#l-up").onclick = () => pickUpload(folder);
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
      ${path.endsWith(".md") ? `<button class="btn" id="v-edit">수정</button>` : ""}
      <button class="btn" id="v-rename">이름·위치 바꾸기</button>
      <button class="btn danger" id="v-delete">삭제</button>
      <a class="btn ghost" href="${ghUrl}" target="_blank" rel="noopener">GitHub에서 보기</a>
    </div>`;
  if (!path.endsWith(".md")) {
    const url = await blobURL(path);
    const isImg = IMG_EXT.test(path);
    el.innerHTML = `<header class="doc"><div class="eyebrow">${esc(topicName(folder))}</div><h1>${esc(path.split("/").pop())}</h1>
      <dl class="meta"><div class="r"><dt>경로</dt><dd>${esc(path)}</dd></div><div class="r"><dt>크기</dt><dd>${(f.size / 1024).toFixed(1)} KB</dd></div></dl>${tools}</header>
      <article class="prose">${isImg ? `<img src="${url}" alt="">` : `<p><a href="${url}" download="${esc(path.split("/").pop())}">내려받기</a></p>`}</article>`;
    bindFileTools(path);
    return;
  }
  el.innerHTML = `<header class="doc"><div class="eyebrow">${esc(topicName(folder))}</div><h1>불러오는 중…</h1></header>`;
  const text = await blobText(f.sha);
  if (S.current !== path) return;
  const {meta, body} = parseFrontMatter(text);
  const title = meta.title || stem(path);
  const tags = meta.tags || [];
  const content = body.replace(new RegExp(`^\\s*# ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n`), "");
  el.innerHTML = `
    <header class="doc">
      <div class="eyebrow"><a href="#/f/${encPath(folder)}">${esc(topicName(folder))}</a></div>
      <h1>${esc(title)}</h1>
      <dl class="meta">
        ${meta.date ? `<div class="r"><dt>작성일</dt><dd><a href="#/y/${esc(encodeURIComponent(meta.date.slice(0, 4)))}">${esc(meta.date)}</a></dd></div>` : ""}
        ${tags.length ? `<div class="r"><dt>태그</dt><dd>${tags.map((t) => `<a class="chip" href="#/t/${encodeURIComponent(t)}">${esc(t)}</a>`).join("")}</dd></div>` : ""}
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
  $("#v-edit")?.addEventListener("click", () => guard(() => openEditor(path)));
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
    const f = S.files.get(path);
    sha = f.sha;
    ({meta, body} = parseFrontMatter(await blobText(f.sha)));
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

/* 파일 이름: 폴더 안 다음 번호 + 제목 */
function nextFileName(folder, title) {
  const nums = [...S.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/"))
    .map((p) => parseInt(p.split("/").pop(), 10)).filter((n) => !isNaN(n));
  const n = String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, "0");
  const safe = title.replace(/[\\/:*?"<>|#%]/g, "-").replace(/\s+/g, " ").trim().slice(0, 60) || "새 글";
  return `${folder}/${n}-${safe}.md`;
}

function folderOptions() {
  const dirs = new Set();
  for (const p of S.files.keys()) {
    const parts = p.split("/");
    if (!isPage(p)) continue;
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs].filter((d) => !d.split("/").includes("images")).sort(cmpParts)
    .map((d) => [d, d.includes("/") ? `${topicName(d.split("/")[0])} / ${d.split("/").slice(1).map(prettyName).join(" / ")}` : topicName(d)]);
}

function currentFolder() {
  const r = route();
  if (r.kind === "f") return r.arg;
  if (r.kind === "p") return r.arg.split("/").slice(0, -1).join("/");
  return folderOptions()[0]?.[0] || "";
}

async function newPage(folder = currentFolder()) {
  const v = await modal({
    title: "새 글",
    fields: [
      {name: "folder", label: "주제", type: "select", options: folderOptions(), value: folder},
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

async function newTopic() {
  const v = await modal({
    title: "새 주제",
    html: "<p>주제는 폴더 하나예요. 첫 글을 같이 만들어야 폴더가 생겨요.</p>",
    fields: [
      {name: "name", label: "주제 이름", required: true},
      {name: "folder", label: "폴더 이름", hint: "영어 소문자·숫자·- (예: kotlin)", required: true},
      {name: "group", label: "묶음", list: "group-list", value: "기타"},
      {name: "title", label: "첫 글 제목", required: true},
    ],
    ok: "만들기",
  });
  if (!v) return;
  const folder = v.folder.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  if (!folder || !v.title) return toast("폴더 이름과 첫 글 제목이 필요해요", true);
  if ([...S.files.keys()].some((p) => p.startsWith(folder + "/"))) return toast("이미 있는 폴더예요", true);
  const path = `${folder}/01-${v.title.replace(/[\\/:*?"<>|#%]/g, "-").trim().slice(0, 60)}.md`;
  await commit([{path, text: composeDoc(v.title, today(), [], "")}, {path: "__topic__", topic: {[folder]: {name: v.name, group: v.group || "기타"}}}], `새 주제: ${v.name}`);
  toast("주제를 만들었어요");
  go(`#/p/${encPath(path)}`);
}

async function editTopic(folder) {
  const t = S.index.topics[folder] || {name: folder, group: "기타"};
  const v = await modal({
    title: "주제 이름·묶음",
    fields: [{name: "name", label: "주제 이름", value: t.name, required: true}, {name: "group", label: "묶음", value: t.group, list: "group-list"}],
  });
  if (!v || !v.name) return;
  await commit([{path: "__topic__", topic: {[folder]: {name: v.name, group: v.group || "기타"}}}], `주제 이름: ${folder} → ${v.name}`);
  toast("바꿨어요");
  render();
}

/* ---------------- 이름 바꾸기·삭제·올리기 ---------------- */

function underPath(path, isDir) {
  return isDir ? [...S.files.keys()].filter((p) => p.startsWith(path + "/")) : [path];
}

async function renamePath(path, isDir) {
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
  try { return JSON.parse(localStorage.getItem(CFG_KEY)); } catch { return null; }
}

async function start() {
  S.cfg = loadCfg();
  if (!S.cfg?.token) return showLogin();
  $("#login").hidden = true;
  $("#app").hidden = false;
  try { await loadTree(); }
  catch (e) {
    const why = {
      401: "토큰이 틀렸거나 만료·폐기됐어요. 새 토큰을 넣어 주세요.",
      403: "토큰에 권한이 부족해요. 토큰 설정에서 Contents 를 Read and write 로 바꿔 주세요.",
      404: "이 토큰으로는 저장소가 안 보여요. 토큰 설정의 Repository access 를 'Only select repositories' 로 바꾸고 이 저장소를 골라 주세요. 저장소 이름·브랜치도 확인해 주세요.",
    }[e.status];
    if (why) return showLogin(`들어가지 못했어요 (${e.status}). ${why}`);
    throw e;
  }
  render();
}

function showLogin(err) {
  $("#app").hidden = true;
  $("#login").hidden = false;
  const cfg = loadCfg() || {};
  $("#f-repo").value = cfg.owner ? `${cfg.owner}/${cfg.repo}` : "secretj/study-notes";
  $("#f-branch").value = cfg.branch || "main";
  $("#login-error").hidden = !err;
  if (err) $("#login-error").textContent = err;
}

$("#login-form").onsubmit = async (e) => {
  e.preventDefault();
  const [owner, repo] = $("#f-repo").value.trim().split("/");
  if (!owner || !repo) return showLogin("저장소는 owner/repo 형식으로 적어 주세요.");
  localStorage.setItem(CFG_KEY, JSON.stringify({owner, repo, branch: $("#f-branch").value.trim() || "main", token: $("#f-token").value.trim()}));
  $("#f-token").value = "";
  guard(start);
};
$("#btn-logout").onclick = async () => {
  if (S.editing && !(await leaveEditor())) return;
  localStorage.removeItem(CFG_KEY);
  S.blobCache.forEach((u) => URL.revokeObjectURL(u));
  S.blobCache.clear();
  S.textCache.clear();
  location.hash = "";
  showLogin();
};

$$(".tabs button").forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; renderNav(); }));
$("#search").oninput = () => renderNav();
$("#show-hidden").onchange = () => renderNav();
$("#btn-menu").onclick = () => $("#sidebar").classList.toggle("open");
$("#btn-new-page").onclick = () => guard(() => newPage());
$("#btn-new-topic").onclick = () => guard(newTopic);
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
