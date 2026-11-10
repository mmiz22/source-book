/* Source Book — GitHub storage layer.
   Replaces the Claude runtime (window.claude) with a private GitHub repository:
   data lives in db/*.json, uploaded files in files/<id>. Sign-in is a GitHub
   fine-grained access token kept only in this browser. */
(() => {
const OWNER = "mmiz22", REPO = "source-book-data", BRANCH = "main";
const API = window.SB_API_BASE || "https://api.github.com";
const TOKEN_KEY = "sb-gh-token";
const SHARDED = { quotes: 32, suppliers: 8, docs: 4 };            // collections split across several files
const ONEFILE = ["samples", "settings", "ptypes", "rfqs", "inbox", "storefinds"];

let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch {}

/* ---------- small helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
function hdr(extra) { return Object.assign({ Authorization: "Bearer " + token, "X-GitHub-Api-Version": "2022-11-28" }, extra || {}); }
async function gh(path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: hdr(opts.headers) });
  if (!r.ok) { const e = new Error("GitHub " + r.status + " " + path); e.status = r.status; try { e.body = await r.text(); } catch {} throw e; }
  return r;
}
function b64encodeUtf8(str) { const bytes = new TextEncoder().encode(str); return b64encodeBytes(bytes); }
function b64encodeBytes(bytes) { let s = ""; const CH = 0x8000; for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH)); return btoa(s); }
function rid(n = 20) { const a = "abcdefghijklmnopqrstuvwxyz0123456789"; let s = ""; const v = crypto.getRandomValues(new Uint8Array(n)); for (const x of v) s += a[x % a.length]; return s; }
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function fileFor(col, id) {
  if (SHARDED[col]) return `db/${col}/${String(hash(id) % SHARDED[col]).padStart(2, "0")}.json`;
  return `db/${col}.json`;
}
function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }

/* ---------- sign-in screen ---------- */
function signInScreen(msg) {
  return new Promise(resolve => {
    const wrap = document.createElement("div");
    wrap.id = "gh-signin";
    wrap.innerHTML = `<div class="ghs-card">
      <div class="ghs-title">Source Book</div>
      <p>Sign in with your GitHub access token to open your private Source Book data.</p>
      ${msg ? `<p class="ghs-err">${msg}</p>` : ""}
      <label for="ghs-tok">GitHub access token</label>
      <input id="ghs-tok" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…">
      <button id="ghs-go" type="button">Sign in</button>
      <p class="ghs-small">The token stays in this browser only. Create one at github.com → Settings → Developer settings → Fine-grained tokens, with access to <b>${REPO}</b> and <b>Contents: Read and write</b>.</p>
    </div>`;
    document.body.append(wrap);
    const go = async () => {
      const v = wrap.querySelector("#ghs-tok").value.trim(); if (!v) return;
      token = v;
      try { await gh(`/repos/${OWNER}/${REPO}`); try { localStorage.setItem(TOKEN_KEY, v); } catch {} wrap.remove(); resolve(); }
      catch (e) { wrap.remove(); token = null; resolve(signInScreen(e.status === 401 ? "That token wasn't accepted. Check it and try again." : e.status === 404 ? `That token can't see ${REPO}. Give it access to that repository.` : "Couldn't reach GitHub. Check your connection.")); }
    };
    wrap.querySelector("#ghs-go").onclick = go;
    wrap.querySelector("#ghs-tok").onkeydown = e => { if (e.key === "Enter") go(); };
  });
}
const css = document.createElement("style");
css.textContent = `#gh-signin{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:var(--bg,#f5f2ec);padding:16px}
.ghs-card{max-width:420px;width:100%;background:var(--card,#fff);border:1px solid var(--line,#ddd);border-radius:14px;padding:22px;font:15px/1.45 system-ui,sans-serif;color:var(--ink,#222)}
.ghs-title{font:600 24px Georgia,serif;margin-bottom:6px}.ghs-card label{display:block;font-weight:600;margin:12px 0 6px}
.ghs-card input{width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--line,#ccc);border-radius:8px;font:14px ui-monospace,monospace}
.ghs-card button{margin-top:12px;width:100%;padding:11px;border:0;border-radius:8px;background:#1f5f4a;color:#fff;font-weight:600;font-size:15px;cursor:pointer}
.ghs-err{color:#b3261e}.ghs-small{font-size:12.5px;opacity:.75}
#gh-status{position:fixed;left:12px;bottom:12px;z-index:9000;font:12px system-ui,sans-serif;background:#222;color:#fff;padding:6px 10px;border-radius:8px;opacity:.85;display:none}
#gh-signout{margin-left:8px;color:#9fd;cursor:pointer;text-decoration:underline}`;
document.head.append(css);
const status = document.createElement("div"); status.id = "gh-status";
function setStatus(t, sticky) { if (!document.body.contains(status)) document.body.append(status); status.textContent = t; status.style.display = t ? "block" : "none"; if (!sticky && t) { clearTimeout(setStatus._t); setStatus._t = setTimeout(() => status.style.display = "none", 2500); } }

/* ---------- service worker for files (_blob/<id>) ---------- */
async function setupSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    const c = await caches.open("sb-auth");
    await c.put("auth", new Response(JSON.stringify({ token, owner: OWNER, repo: REPO, branch: BRANCH, api: API })));
    if (!navigator.serviceWorker.controller) {
      // first visit: the worker isn't controlling this page yet; reload once so images load through it
      if (!sessionStorage.getItem("sb-sw-reload")) { sessionStorage.setItem("sb-sw-reload", "1"); location.reload(); await sleep(10000); }
    }
  } catch (e) { console.warn("service worker", e); }
}

/* ---------- data store ---------- */
const store = new Map();          // col -> Map(id -> data)
const shas = new Map();           // path -> blob sha
const listeners = new Map();      // col -> Set(cb)  and "col/id" -> Set(cb)
const pending = new Map();        // path -> Map("col/id" -> data|null)
let loaded = false;

function col(c) { if (!store.has(c)) store.set(c, new Map()); return store.get(c); }
function snapCol(c) {
  const docs = [...col(c).entries()].map(([id, d]) => ({ id, exists: true, data: () => clone(d) }));
  return { docs, size: docs.length, empty: !docs.length, forEach: f => docs.forEach(f) };
}
function snapDoc(c, id) { const d = col(c).get(id); return { id, exists: d !== undefined, data: () => clone(d) }; }
function emit(c, id) {
  (listeners.get(c) || []).forEach(cb => { try { cb(snapCol(c)); } catch (e) { console.error(e); } });
  if (id) (listeners.get(c + "/" + id) || []).forEach(cb => { try { cb(snapDoc(c, id)); } catch (e) { console.error(e); } });
}

async function readBlob(sha) {
  const cache = await caches.open("sb-data");
  const key = "https://sb.cache/blob/" + sha;
  const hit = await cache.match(key);
  if (hit) return hit.text();
  const r = await gh(`/repos/${OWNER}/${REPO}/git/blobs/${sha}`, { headers: { Accept: "application/vnd.github.raw" } });
  const t = await r.text();
  try { await cache.put(key, new Response(t)); } catch {}
  return t;
}
async function loadAll() {
  setStatus("Loading your Source Book…", true);
  const t = await (await gh(`/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`)).json();
  const paths = [];
  for (const e of t.tree || []) { if (e.type === "blob") { shas.set(e.path, e.sha); if (e.path.startsWith("db/") && e.path.endsWith(".json")) paths.push(e.path); } }
  let i = 0;
  const worker = async () => {
    while (i < paths.length) {
      const p = paths[i++];
      const txt = await readBlob(shas.get(p));
      const c = p.startsWith("db/") ? p.slice(3).split("/")[0].replace(/\.json$/, "") : null;
      const obj = JSON.parse(txt || "{}");
      for (const [id, d] of Object.entries(obj)) col(c).set(id, d);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  loaded = true;
  setStatus("");
  for (const c of store.keys()) emit(c);
}

/* writes: batch per file, merge with the latest copy on GitHub, retry on conflict */
const saving = new Map();
function queueWrite(c, id, data) {
  const p = fileFor(c, id);
  if (!pending.has(p)) pending.set(p, new Map());
  pending.get(p).set(c + "/" + id, data === null ? null : clone(data));
  if (!saving.get(p)) { saving.set(p, true); setTimeout(() => flush(p), 400); }
}
async function fetchFile(p) {
  try {
    const r = await gh(`/repos/${OWNER}/${REPO}/contents/${encodeURI(p)}?ref=${BRANCH}`, { headers: { Accept: "application/vnd.github.object+json" } });
    const j = await r.json();
    let txt;
    if (j.content && j.encoding === "base64") txt = new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\n/g, "")), ch => ch.charCodeAt(0)));
    else txt = await readBlob(j.sha);
    return { sha: j.sha, obj: JSON.parse(txt || "{}") };
  } catch (e) { if (e.status === 404) return { sha: null, obj: {} }; throw e; }
}
async function flush(p) {
  const ops = pending.get(p); pending.delete(p);
  if (!ops || !ops.size) { saving.set(p, false); return; }
  setStatus("Saving…", true);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { sha, obj } = await fetchFile(p);
      for (const [key, d] of ops) { const id = key.slice(key.indexOf("/") + 1); if (d === null) delete obj[id]; else obj[id] = d; }
      const body = { message: `Update ${p}`, content: b64encodeUtf8(JSON.stringify(obj)), branch: BRANCH };
      if (sha) body.sha = sha;
      const r = await gh(`/repos/${OWNER}/${REPO}/contents/${encodeURI(p)}`, { method: "PUT", body: JSON.stringify(body) });
      const j = await r.json(); shas.set(p, j.content?.sha);
      setStatus("Saved");
      break;
    } catch (e) {
      if ((e.status === 409 || e.status === 422) && attempt < 4) { await sleep(600 * (attempt + 1)); continue; }
      console.error(e); setStatus("Couldn't save to GitHub — your last change may not be stored. Reload and try again.", true);
      break;
    }
  }
  saving.set(p, false);
  if (pending.has(p)) { saving.set(p, true); setTimeout(() => flush(p), 50); }
}

function setPath(obj, key, val) {
  if (!key.includes(".")) { obj[key] = val; return; }
  const parts = key.split("."); let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (typeof o[parts[i]] !== "object" || o[parts[i]] === null) o[parts[i]] = {}; o = o[parts[i]]; }
  o[parts[parts.length - 1]] = val;
}
function stripDeletes(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return o;
  for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === "object" && v.__delete__ === true) delete o[k]; else stripDeletes(v); }
  return o;
}

function docRef(c, id) {
  return {
    id, path: c + "/" + id,
    async get() { await ready; return snapDoc(c, id); },
    async set(data, opts) {
      await ready; checkWrite();
      const cur = col(c).get(id);
      const next = opts && opts.merge && cur ? Object.assign(clone(cur), clone(data)) : clone(data);
      stripDeletes(next); col(c).set(id, next); emit(c, id); queueWrite(c, id, next);
    },
    async update(patch) {
      await ready; checkWrite();
      const cur = col(c).get(id);
      if (cur === undefined) { const e = new Error("Document not found"); e.code = "not-found"; throw e; }
      const next = clone(cur);
      for (const [k, v] of Object.entries(clone(patch))) {
        if (v && typeof v === "object" && v.__delete__ === true) { if (!k.includes(".")) delete next[k]; else setPath(next, k, undefined); }
        else setPath(next, k, v);
      }
      stripDeletes(next); col(c).set(id, next); emit(c, id); queueWrite(c, id, next);
    },
    async delete() { await ready; checkWrite(); col(c).delete(id); emit(c, id); queueWrite(c, id, null); },
    onSnapshot(cb, err) {
      const k = c + "/" + id; if (!listeners.has(k)) listeners.set(k, new Set()); listeners.get(k).add(cb);
      ready.then(() => cb(snapDoc(c, id)), e => err && err(e));
      return () => listeners.get(k).delete(cb);
    }
  };
}
function checkWrite() { if (!loaded) { const e = new Error("Still loading"); e.code = "unavailable"; throw e; } }
const db = {
  collection(c) {
    return {
      doc(id) { return docRef(c, id || rid()); },
      onSnapshot(cb, err) {
        if (!listeners.has(c)) listeners.set(c, new Set()); listeners.get(c).add(cb);
        ready.then(() => cb(snapCol(c)), e => err && err(e));
        return () => listeners.get(c).delete(cb);
      },
      async get() { await ready; return snapCol(c); }
    };
  },
  doc(path) { const i = path.indexOf("/"); return docRef(path.slice(0, i), path.slice(i + 1)); }
};

/* ---------- uploaded files ---------- */
const assets = {
  async upload(blob) {
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    setStatus("Uploading file…", true);
    await gh(`/repos/${OWNER}/${REPO}/contents/files/${id}`, { method: "PUT", body: JSON.stringify({ message: "Add file " + (blob.name || id), content: b64encodeBytes(bytes), branch: BRANCH }) });
    setStatus("Saved");
    try { const c = await caches.open("sb-files"); await c.put("https://sb.cache/file/" + id, new Response(blob, { headers: { "Content-Type": blob.type || "application/octet-stream" } })); } catch {}
    return { id, sizeBytes: bytes.length };
  }
};

/* ---------- downloads (CSV exports) ---------- */
const downloads = {
  async save({ filename, data, mimeType }) {
    const b = data instanceof Blob ? data : new Blob([data], { type: mimeType || "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = filename || "download";
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
};

/* ---------- boot ---------- */
let resolveReady, rejectReady;
const ready = new Promise((a, b) => { resolveReady = a; rejectReady = b; });
const started = (async () => {
  await new Promise(r => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", r) : r());
  if (!token) await signInScreen();
  else {
    try { await gh(`/repos/${OWNER}/${REPO}`); }
    catch (e) { if (e.status === 401 || e.status === 404) { try { localStorage.removeItem(TOKEN_KEY); } catch {} token = null; await signInScreen("Your saved sign-in stopped working. Sign in again."); } }
  }
  await setupSW();
  await loadAll();
  // sign-out link
  const so = document.createElement("span"); so.id = "gh-signout"; so.textContent = "Sign out";
  so.onclick = async () => { try { localStorage.removeItem(TOKEN_KEY); } catch {} try { await caches.delete("sb-auth"); } catch {} location.reload(); };
  const brand = document.querySelector(".brand"); if (brand) { const w = document.createElement("button"); w.className = "btn sm ghost"; w.textContent = "Sign out"; w.onclick = so.onclick; brand.append(w);
    const a = document.createElement("button"); a.className = "btn sm ghost"; a.id = "ai-btn"; a.textContent = aiKey() ? "⚡ Instant reading: on" : "⚡ Instant reading"; a.onclick = aiSettings; brand.append(a); }
})();
started.then(resolveReady, e => { console.error(e); setStatus("Couldn't load from GitHub: " + (e.message || e), true); rejectReady(e); });

window.addEventListener("beforeunload", e => { if (pending.size || [...saving.values()].some(Boolean)) { e.preventDefault(); e.returnValue = ""; } });

/* ---- Claude reading (instant): calls the Claude API straight from this browser with a key the user pastes in ---- */
const AI_KEY = "sb-claude-key";
const AI_API = window.SB_AI_BASE || "https://api.anthropic.com";
const AI_MODELS = { quick: "claude-haiku-5-5", default: "claude-sonnet-5-5" };
function aiKey() { try { return localStorage.getItem(AI_KEY) || ""; } catch { return ""; } }
function blobB64(b) { return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.onerror = no; r.readAsDataURL(b); }); }
function aiErr(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
function parseJson(t) {
  t = String(t || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.indexOf("["); const s = a < 0 ? b : b < 0 ? a : Math.min(a, b);
  if (s >= 0) { const close = t[s] === "{" ? "}" : "]"; const e = t.lastIndexOf(close); if (e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch {} } }
  throw aiErr("unreadable", "Claude's answer wasn't valid JSON");
}
const ai = {
  async limits() { return { images: { maxCount: 8, maxBytes: 4500000 }, tools: false }; },
  async json(prompt, opts = {}) {
    const key = aiKey(); if (!key) throw aiErr("not_granted", "No Claude API key on this device");
    const content = [];
    for (const img of (opts.images || [])) {
      if (!img) continue;
      const type = /^image\/(jpeg|png|gif|webp)$/.test(img.type || "") ? img.type : "image/jpeg";
      if (img.size > 4500000) throw aiErr("image_rejected", "Image too large");
      content.push({ type: "image", source: { type: "base64", media_type: type, data: await blobB64(img) } });
    }
    content.push({ type: "text", text: String(prompt) + "\n\nAnswer with valid JSON only. No explanation and no code fences." });
    let r;
    try {
      r = await fetch(AI_API + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: AI_MODELS[opts.modelTier] || AI_MODELS.default, max_tokens: 16000, messages: [{ role: "user", content }] }) });
    } catch (e) { throw aiErr("network", "Couldn't reach Claude"); }
    if (!r.ok) {
      let msg = ""; try { msg = (await r.json())?.error?.message || ""; } catch {}
      if (r.status === 401 || r.status === 403) throw aiErr("not_granted", msg || "The Claude API key was not accepted");
      if (r.status === 429) throw aiErr("rate_limited", msg);
      if (r.status === 413 || /too (large|long)|maximum/i.test(msg)) throw aiErr("prompt_too_large", msg);
      if (r.status === 400 && /image/i.test(msg)) throw aiErr("image_rejected", msg);
      if (r.status === 400 && /credit|billing|balance/i.test(msg)) throw aiErr("quota_exceeded", msg);
      throw aiErr("failed", msg || ("Claude error " + r.status));
    }
    const j = await r.json();
    const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    return parseJson(text);
  }
};
function aiSettings() {
  const has = !!aiKey();
  const wrap = document.createElement("div"); wrap.id = "gh-signin";
  wrap.innerHTML = `<div class="box"><h1 style="font-size:1.3rem">Instant reading</h1>
    <p>${has ? "Instant reading is <b>on</b> for this device. Cards, quote sheets and store photos are read by Claude right away." : "Paste a Claude API key to have cards, quote sheets and store photos read right away on this device. Without a key, uploads wait for the hourly reader."}</p>
    <label for="ai-key">Claude API key</label><input id="ai-key" type="password" autocomplete="off" spellcheck="false" placeholder="${has ? "A key is saved. Paste a new one to replace it" : "sk-ant-..."}">
    <button id="ai-save">Save and turn on</button>
    ${has ? '<button id="ai-off" style="background:#7a2e2e;margin-top:8px">Turn off and remove the key</button>' : ""}
    <button id="ai-cancel" style="background:transparent;color:inherit;border:1px solid #8886;margin-top:8px">Cancel</button>
    <p class="err" id="ai-err"></p>
    <p class="fine">The key stays in this browser only and is sent only to Claude. Create one at platform.claude.com → API keys. Usage is billed to that API account; Max, Ultra and Team plans include monthly API credits you can link to it.</p></div>`;
  document.body.append(wrap);
  const err = wrap.querySelector("#ai-err");
  wrap.querySelector("#ai-cancel").onclick = () => wrap.remove();
  const off = wrap.querySelector("#ai-off"); if (off) off.onclick = () => { try { localStorage.removeItem(AI_KEY); } catch {} location.reload(); };
  wrap.querySelector("#ai-save").onclick = async () => {
    const k = wrap.querySelector("#ai-key").value.trim(); if (!k) { err.textContent = "Paste the key first."; return; }
    err.textContent = "Checking…";
    try {
      const r = await fetch(AI_API + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": k, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: AI_MODELS.quick, max_tokens: 5, messages: [{ role: "user", content: "Say OK" }] }) });
      if (!r.ok) { let m = ""; try { m = (await r.json())?.error?.message || ""; } catch {} err.textContent = r.status === 401 ? "That key wasn't accepted. Check it and try again." : ("Claude said: " + (m || r.status)); return; }
    } catch (e) { err.textContent = "Couldn't reach Claude. Check your connection."; return; }
    try { localStorage.setItem(AI_KEY, k); } catch {}
    location.reload();
  };
}

window.claude = {
  use(name) {
    if (name === "db") return started.then(() => db);
    if (name === "assets") return started.then(() => assets);
    if (name === "downloads") return Promise.resolve(downloads);
    if (name === "sample") return started.then(() => { if (aiKey()) return ai; throw new Error("sample needs a Claude API key"); });
    return Promise.reject(new Error(name + " is not available in the GitHub version"));
  }
};
})();
