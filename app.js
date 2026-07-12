/* Reading Library — vanilla JS PWA
   Data: Supabase (cloud sync) with a localStorage mirror + offline write queue.
   No build step, no framework. */
(() => {
"use strict";

// ---------------------------------------------------------------- Supabase
const CFG = window.RL_CONFIG || {};
const SB_URL = (CFG.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = CFG.SUPABASE_ANON_KEY || "";
const SB_READY = SB_URL && SB_KEY && !SB_KEY.includes("PASTE");

async function sb(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

// ---------------------------------------------------------------- State
const LS = {
  books: "rl_books", goals: "rl_goals", pending: "rl_pending", recs: "rl_recs_cache",
};
const state = {
  books: load(LS.books, []),
  goals: load(LS.goals, []),
  pending: load(LS.pending, []),   // queued writes when offline/failed
  tab: "scan",
  sync: "off",                     // ok | off | bad
  query: "", filter: "all",
};
function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function persist() {
  localStorage.setItem(LS.books, JSON.stringify(state.books));
  localStorage.setItem(LS.goals, JSON.stringify(state.goals));
  localStorage.setItem(LS.pending, JSON.stringify(state.pending));
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "x" + Date.now() + Math.random().toString(16).slice(2));
const $ = (sel, el = document) => el.querySelector(sel);

// ---------------------------------------------------------------- Sync layer
async function pullAll() {
  if (!SB_READY) { state.sync = "off"; return; }
  try {
    const [books, goals] = await Promise.all([
      sb("books?select=*&order=created_at.desc"),
      sb("goals?select=*"),
    ]);
    state.books = books || [];
    state.goals = goals || [];
    state.sync = "ok";
    persist();
  } catch (e) {
    console.warn("pull failed", e);
    state.sync = "bad";
  }
}

// Optimistic upsert: update memory now, push to cloud, queue on failure.
async function upsertBook(book) {
  const i = state.books.findIndex((b) => b.id === book.id);
  if (i >= 0) state.books[i] = book; else state.books.unshift(book);
  persist(); render();
  await pushRow("books", book);
}
async function deleteBook(id) {
  state.books = state.books.filter((b) => b.id !== id);
  persist(); render();
  if (!SB_READY) return queueOp({ op: "delete", table: "books", id });
  try { await sb(`books?id=eq.${id}`, { method: "DELETE" }); }
  catch { queueOp({ op: "delete", table: "books", id }); }
}
async function upsertGoal(goal) {
  const i = state.goals.findIndex((g) => g.id === goal.id);
  if (i >= 0) state.goals[i] = goal; else state.goals.push(goal);
  persist(); render();
  await pushRow("goals", goal);
}
async function deleteGoal(id) {
  state.goals = state.goals.filter((g) => g.id !== id);
  persist(); render();
  if (!SB_READY) return queueOp({ op: "delete", table: "goals", id });
  try { await sb(`goals?id=eq.${id}`, { method: "DELETE" }); }
  catch { queueOp({ op: "delete", table: "goals", id }); }
}
async function pushRow(table, row) {
  if (!SB_READY) { state.sync = "off"; return queueOp({ op: "upsert", table, row }); }
  try {
    await sb(table, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row),
    });
    state.sync = "ok"; setSyncDot();
  } catch (e) {
    console.warn("push failed", e); state.sync = "bad"; setSyncDot();
    queueOp({ op: "upsert", table, row });
  }
}
function queueOp(op) { state.pending.push(op); persist(); }
async function flushPending() {
  if (!SB_READY || !state.pending.length || !navigator.onLine) return;
  const still = [];
  for (const p of state.pending) {
    try {
      if (p.op === "upsert")
        await sb(p.table, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(p.row) });
      else if (p.op === "delete")
        await sb(`${p.table}?id=eq.${p.id}`, { method: "DELETE" });
    } catch { still.push(p); }
  }
  state.pending = still; persist();
  state.sync = still.length ? "bad" : "ok"; setSyncDot();
}

// ---------------------------------------------------------------- Book lookup APIs
async function lookupISBN(isbn) {
  isbn = String(isbn).replace(/[^0-9Xx]/g, "");
  // Open Library first — reliable, free, good covers, rarely rate-limited.
  try {
    const o = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`).then((r) => r.json());
    const d = o[`ISBN:${isbn}`];
    if (d) return {
      title: d.title, authors: (d.authors || []).map((a) => a.name),
      isbn, cover_url: d.cover ? d.cover.medium || d.cover.large : null,
      genres: (d.subjects || []).slice(0, 4).map((s) => s.name), page_count: d.number_of_pages || null,
    };
  } catch {}
  // Google Books fallback (may be rate-limited on shared networks).
  try {
    const g = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`).then((r) => (r.ok ? r.json() : null));
    if (g && g.items && g.items[0]) return fromGoogle(g.items[0], isbn);
  } catch {}
  return null;
}
function fromGoogle(item, isbn) {
  const v = item.volumeInfo || {};
  let cover = v.imageLinks ? (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail) : null;
  if (cover) cover = cover.replace("http://", "https://").replace("&edge=curl", "");
  return {
    title: v.title || "Untitled",
    authors: v.authors || [],
    isbn: isbn || (v.industryIdentifiers && v.industryIdentifiers[0] && v.industryIdentifiers[0].identifier) || null,
    cover_url: cover,
    genres: (v.categories || []).slice(0, 4),
    page_count: v.pageCount || null,
  };
}
async function searchBooks(q, max = 12) {
  // Google Books gives the richest results; fall back to Open Library on failure/429.
  try {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=${max}`);
    if (r.ok) {
      const g = await r.json();
      if (g.items && g.items.length) return g.items.map((it) => fromGoogle(it));
    }
  } catch {}
  return searchOpenLibrary(q, max);
}
// Open Library search fallback. Translates Google-style qualifiers (inauthor:/subject:/intitle:).
async function searchOpenLibrary(q, max = 12) {
  let url;
  const m = /^(inauthor|subject|intitle):"?([^"]+)"?$/i.exec(q.trim());
  if (m) {
    const field = { inauthor: "author", subject: "subject", intitle: "title" }[m[1].toLowerCase()];
    url = `https://openlibrary.org/search.json?${field}=${encodeURIComponent(m[2])}&limit=${max}&fields=title,author_name,cover_i,isbn,subject,number_of_pages_median`;
  } else {
    url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=${max}&fields=title,author_name,cover_i,isbn,subject,number_of_pages_median`;
  }
  try {
    const j = await fetch(url).then((r) => r.json());
    return (j.docs || []).map((d) => ({
      title: d.title,
      authors: d.author_name || [],
      isbn: d.isbn ? d.isbn[0] : null,
      cover_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
      genres: (d.subject || []).slice(0, 4),
      page_count: d.number_of_pages_median || null,
    }));
  } catch { return []; }
}

// ---------------------------------------------------------------- Metadata normalization
// Turns messy imported filenames ("[Series 1] Author - Title (2015, Pub) - libgen.li")
// into clean, standardized entries with real covers, via authoritative Open Library data.
function flipName(a) {
  const m = /^([^,]+),\s*(.+)$/.exec(String(a || "").trim());  // "Last, First" -> "First Last"
  return (m ? `${m[2]} ${m[1]}` : String(a || "")).replace(/\s+/g, " ").trim();
}
function surnameOf(a) {
  const t = flipName(a).split(/\s+/).filter(Boolean);
  return (t[t.length - 1] || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function cleanDisplayTitle(raw, authors) {
  let s = String(raw || "");
  s = s.split(" -- ")[0];                                        // drop " -- metadata -- dumps"
  s = s.replace(/\s*[-–]\s*(?:libgen|z-?lib|annas?[- ]?archive)[^\s]*.*$/i, ""); // source tags
  s = s.replace(/^\s*(?:[\[(][^\])]*[\])]\s*)+/, "");            // leading [series]/(series) groups
  s = s.replace(/(?:\s*\([^)]*\)\s*)+$/g, "");                   // trailing (year/publisher/series) groups
  const names = [...new Set([...(authors || []).map(flipName), ...(authors || []).map((a) => String(a || "").trim())])].filter(Boolean);
  for (const a of names) {                                       // strip author name glued at start/end (any dash spacing)
    const e = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp("^\\s*" + e + "\\s*[-–:]\\s*", "i"), "");
    s = s.replace(new RegExp("\\s*[-–]\\s*" + e + "\\s*$", "i"), "");
  }
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, ""); // apostrophe/punctuation-insensitive
  const sn = names.map(surnameOf).filter(Boolean);
  let parts = s.split(/\s+[-–]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && sn.length) {                          // drop author-name segments
    while (parts.length > 1 && sn.some((x) => norm(parts[0]).includes(x))) parts.shift();
    while (parts.length > 1 && sn.some((x) => norm(parts[parts.length - 1]).includes(x))) parts.pop();
  }
  s = parts.join(" - ").replace(/\s*_\s*/g, ": ").replace(/\s{2,}/g, " ");
  s = s.replace(/^[\s:_–-]+|[\s:_–-]+$/g, "").trim();
  return s || String(raw || "").trim();
}
function queryTitle(t) {                                          // reduce to the core title for searching
  let s = t.split(/\s*[:(]/)[0].trim();                           // drop subtitle after ":"/"("
  s = s.replace(/\s*\b\d+[- ]book\s+(?:bundle|collection|box\s*set|set)\b.*$/i, "");
  s = s.replace(/\s*\b(?:collector'?s|special|deluxe|anniversary|illustrated|complete|revised|expanded)\s+edition\b.*$/i, "");
  s = s.replace(/\s*[-–]\s*$/, "").trim();
  return s || t;
}
const titleTokens = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
function titleOverlap(a, b) {
  const A = new Set(titleTokens(a)), B = titleTokens(b);
  if (!A.size || !B.length) return 0;
  let hit = 0; B.forEach((w) => { if (A.has(w)) hit++; });
  return hit / Math.max(A.size, B.length);
}
async function olDocs(title, author) {
  const p = new URLSearchParams({ limit: "5", fields: "title,author_name,cover_i,isbn,subject,number_of_pages_median" });
  if (title) p.set("title", title);
  if (author) p.set("author", author);
  try { return (await fetch(`https://openlibrary.org/search.json?${p}`).then((r) => r.json())).docs || []; }
  catch { return []; }
}
// Returns a patch of clean fields for a (possibly messy) book. Always standardizes the
// title/author strings; adopts canonical title + cover + genres when a confident match exists.
async function canonicalize(book) {
  const authors = (book.authors || []).map(flipName);
  const disp = cleanDisplayTitle(book.title, book.authors);
  const patch = { title: disp, authors };
  const wantAuthor = authors[0] || "";
  const mySn = surnameOf(authors[0] || "");
  let docs = await olDocs(queryTitle(disp), wantAuthor);
  // Open Library often splits a book across duplicate author spellings, only one of
  // which carries a cover. If no author-matched result has a cover, widen the search.
  const coveredMatch = (ds) => ds.some((d) => d.cover_i && (!mySn || (d.author_name || []).some((n) => surnameOf(n) === mySn)));
  if (!docs.length || !coveredMatch(docs)) docs = docs.concat(await olDocs(queryTitle(disp), ""));
  let best = null, bestScore = 0.6;                             // require a minimum confidence
  for (const d of docs) {
    const aMatch = mySn && (d.author_name || []).some((n) => surnameOf(n) === mySn) ? 1 : 0;
    const ov = titleOverlap(disp, d.title);
    if (!aMatch && ov < 0.5) continue;
    const score = aMatch * 1.5 + ov + (d.cover_i ? 0.7 : 0);   // strongly prefer an edition with a cover
    if (score > bestScore) { bestScore = score; best = d; }
  }
  if (best) {
    if (best.cover_i) patch.cover_url = `https://covers.openlibrary.org/b/id/${best.cover_i}-M.jpg`;
    if (best.isbn && best.isbn[0]) patch.isbn = best.isbn[0];
    if (best.subject && best.subject.length) patch.genres = best.subject.slice(0, 4);
    if (best.number_of_pages_median) patch.page_count = best.number_of_pages_median;
    // Prefer our cleaned title; only adopt the canonical one when it's a close,
    // non-omnibus match (guards against "Book1 / Book2 / Book3" bind-up editions).
    if (best.title && titleOverlap(disp, best.title) >= 0.8 && best.title.length <= disp.length + 15)
      patch.title = best.title;
    // Adopt canonical author names only when the author actually matched.
    if (mySn && (best.author_name || []).some((n) => surnameOf(n) === mySn)) patch.authors = best.author_name;
  }
  return patch;
}

// ---------------------------------------------------------------- Helpers
const authorStr = (b) => (b.authors && b.authors.length ? b.authors.join(", ") : "Unknown author");
function newBookFrom(data, extra = {}) {
  return {
    id: uid(), title: data.title || "Untitled", authors: data.authors || [],
    isbn: data.isbn || null, cover_url: data.cover_url || null, genres: data.genres || [],
    source: extra.source || "manual", format: extra.format || "physical",
    status: "unread", rating: null, page_count: data.page_count || null, pages_read: 0,
    date_started: null, date_finished: null, queue_pos: null, notes: null, ...extra,
  };
}
function dedupeKey(b) { return (b.isbn || (b.title + "|" + authorStr(b))).toLowerCase(); }
function existsAlready(data) {
  const k = dedupeKey(data);
  return state.books.some((b) => dedupeKey(b) === k);
}
function toast(msg) {
  let t = $("#toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600);
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Deterministic color from a title, so cover-less books get consistent generated art.
function hashHue(s) { let h = 0; s = String(s || ""); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
const coverGradient = (s) => { const h = hashHue(s); return `linear-gradient(150deg, hsl(${h} 43% 40%), hsl(${(h + 34) % 360} 47% 25%))`; };
const coverEl = (b) => b.cover_url
  ? `<img class="cover" src="${esc(b.cover_url)}" alt="" loading="lazy">`
  : `<div class="cover" style="background:${coverGradient(b.title)}">📖</div>`;
// A generated "book cover" (title + author on a colored spine) for books with no image.
const genCover = (b) => `<div class="gen" style="background:${coverGradient(b.title)}">
    <div class="gt">${esc(b.title)}</div><div class="ga">${esc(authorStr(b))}</div></div>`;
// Chunk a list into rows of 3, each row sitting on a wooden shelf ledge.
function shelfGrid(list, fn) {
  let out = "";
  for (let i = 0; i < list.length; i += 3)
    out += `<div class="shelf"><div class="shelf-row">${list.slice(i, i + 3).map(fn).join("")}</div><div class="shelf-ledge"></div></div>`;
  return out;
}
function bookTile(b) {
  const art = b.cover_url ? `<img src="${esc(b.cover_url)}" loading="lazy" alt="">` : genCover(b);
  const badge = b.rating ? `<div class="badge">★${b.rating}</div>` : "";
  const ribbon = b.status === "reading" ? `<div class="ribbon reading">Reading</div>`
    : b.status === "finished" ? `<div class="ribbon finished">✓ Read</div>` : "";
  return `<div class="tile" onclick="RL.openBook('${b.id}')">
    <div class="art">${art}${badge}${ribbon}</div>
    <div class="t">${esc(b.title)}</div><div class="a">${esc(authorStr(b))}</div>
  </div>`;
}

// ---------------------------------------------------------------- Render root
const app = document.getElementById("app");
function render() {
  app.innerHTML =
    header() +
    `<main>${views[state.tab] ? views[state.tab]() : ""}</main>` +
    tabbar();
  setSyncDot();
  if (state.tab === "scan") mountScanTab();
}
function header() {
  const sub = state.sync === "ok" ? "Synced" : state.sync === "bad" ? "Sync error — saved locally" : SB_READY ? "Connecting…" : "Local only";
  return `<div class="hdr">
    <div><h1>📚 Reading Library</h1><div class="sub"><span class="sync-dot ${syncClass()}"></span>${sub}</div></div>
    <button onclick="RL.openSettings()">⚙︎</button>
  </div>`;
}
function syncClass() { return state.sync === "ok" ? "sync-ok" : state.sync === "bad" ? "sync-bad" : "sync-off"; }
function setSyncDot() { const d = $(".sync-dot"); if (d) d.className = "sync-dot " + syncClass(); }

const TABS = [
  ["scan", "Scan", "📷"], ["library", "Library", "📚"], ["queue", "Queue", "📋"],
  ["stats", "Stats", "📊"], ["goals", "Goals", "🎯"], ["recs", "For You", "✨"],
];
function tabbar() {
  return `<nav class="tabbar">${TABS.map(([id, label, ic]) =>
    `<button class="${state.tab === id ? "on" : ""}" onclick="RL.go('${id}')"><span class="ic">${ic}</span>${label}</button>`
  ).join("")}</nav>`;
}

// ---------------------------------------------------------------- Views
const views = {};

// ---- Scan tab -----------------------------------------------------------
views.scan = () => `
  <div class="section-title">Add a book</div>
  <div class="card pad">
    <div id="reader"></div>
    <div class="scan-hint" id="scanHint">Point the camera at a book's barcode (UPC/ISBN).</div>
    <button class="btn" id="scanBtn" onclick="RL.toggleScan()">Start camera</button>
    <div class="btn-row">
      <button class="btn secondary" onclick="RL.manualSearch()">🔍 Search by title</button>
      <button class="btn secondary" onclick="RL.manualISBN()">⌨︎ Enter ISBN</button>
    </div>
  </div>
  <div class="section-title">Bulk import</div>
  <div class="card pad">
    <div class="btn-row" style="margin-top:0">
      <button class="btn secondary" onclick="RL.importKindle()">📥 Kindle CSV</button>
      <button class="btn secondary" onclick="RL.importNAS()">🗄️ NAS eBooks</button>
    </div>
    <p class="muted" style="font-size:13px;margin:10px 2px 0">Import your Kindle library export or a file list from the NAS. See the ⚙︎ menu for backup.</p>
  </div>`;

let scanner = null, scanning = false;
function mountScanTab() { /* scanner starts on button press for permissions */ }
async function toggleScan() {
  const btn = $("#scanBtn"), hint = $("#scanHint");
  if (scanning) { await stopScan(); btn.textContent = "Start camera"; return; }
  if (!window.Html5Qrcode) { toast("Scanner not loaded — check connection"); return; }
  try {
    scanner = new Html5Qrcode("reader", {
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.EAN_8, Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.ISBN,
      ],
    });
    scanning = true; btn.textContent = "Stop camera"; hint.textContent = "Scanning… hold steady.";
    await scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 260, height: 160 } },
      onScan, () => {});
  } catch (e) {
    scanning = false; btn.textContent = "Start camera";
    hint.textContent = "Couldn't open the camera. Allow camera access in Safari settings, or use Search / Enter ISBN.";
  }
}
async function stopScan() {
  scanning = false;
  try { if (scanner) { await scanner.stop(); scanner.clear(); } } catch {}
  scanner = null;
}
let lastCode = 0;
async function onScan(text) {
  const now = Date.now(); if (now - lastCode < 2500) return; lastCode = now;
  if (navigator.vibrate) navigator.vibrate(60);
  const hint = $("#scanHint"); if (hint) hint.innerHTML = `<span class="spin"></span> Looking up ${esc(text)}…`;
  const data = await lookupISBN(text);
  if (!data) { if (hint) hint.textContent = `No match for ${text}. Try Search by title.`; return; }
  await stopScan(); const btn = $("#scanBtn"); if (btn) btn.textContent = "Start camera";
  confirmAdd(data, { source: "scan", format: "physical" });
}

// ---- Library tab --------------------------------------------------------
views.library = () => {
  const filters = [["all", "All"], ["reading", "Reading"], ["unread", "To read"], ["finished", "Finished"], ["rated", "Rated"]];
  let list = state.books.slice();
  if (state.query) {
    const q = state.query.toLowerCase();
    list = list.filter((b) => (b.title || "").toLowerCase().includes(q) || authorStr(b).toLowerCase().includes(q));
  }
  if (state.filter === "rated") list = list.filter((b) => b.rating);
  else if (state.filter !== "all") list = list.filter((b) => b.status === state.filter);
  return `
    <div class="searchbar">
      <input placeholder="Search title or author" value="${esc(state.query)}" oninput="RL.setQuery(this.value)">
    </div>
    <div class="chips">${filters.map(([id, l]) =>
      `<button class="chip ${state.filter === id ? "on" : ""}" onclick="RL.setFilter('${id}')">${l}</button>`).join("")}</div>
    ${list.length ? shelfGrid(list, bookTile)
      : `<div class="empty"><div class="ic">📚</div><p>No books here yet.<br>Scan or search to add one.</p></div>`}
    <p class="muted center" style="margin-top:6px;font-size:13px">${list.length} of ${state.books.length} book${state.books.length === 1 ? "" : "s"}</p>`;
};

// ---- Queue tab ----------------------------------------------------------
views.queue = () => {
  const q = state.books.filter((b) => b.queue_pos != null).sort((a, b) => a.queue_pos - b.queue_pos);
  if (!q.length) return `<div class="empty"><div class="ic">📋</div><p>Your reading queue is empty.<br>Open any book and tap “Add to queue”.</p></div>`;
  return `<div class="section-title">Read next</div><div class="card">${q.map((b, i) => `
    <div class="book">
      <div class="q-num">${i + 1}</div>
      ${coverEl(b)}
      <div class="meta" onclick="RL.openBook('${b.id}')">
        <div class="title">${esc(b.title)}</div>
        <div class="authors">${esc(authorStr(b))}</div>
      </div>
      <div class="q-arrows">
        <button onclick="RL.moveQueue('${b.id}',-1)" ${i === 0 ? "disabled" : ""}>▲</button>
        <button onclick="RL.moveQueue('${b.id}',1)" ${i === q.length - 1 ? "disabled" : ""}>▼</button>
      </div>
    </div>`).join("")}</div>
    <p class="muted center" style="font-size:13px;margin-top:12px">Tap a book to start it or remove it from the queue.</p>`;
};

// ---- Stats / Dashboard --------------------------------------------------
views.stats = () => {
  const year = new Date().getFullYear();
  const finished = state.books.filter((b) => b.status === "finished");
  const finishedThisYear = finished.filter((b) => (b.date_finished || "").startsWith(String(year)));
  const reading = state.books.filter((b) => b.status === "reading");
  const rated = state.books.filter((b) => b.rating);
  const pagesThisYear = finishedThisYear.reduce((s, b) => s + (b.page_count || 0), 0);
  const avg = rated.length ? (rated.reduce((s, b) => s + b.rating, 0) / rated.length).toFixed(1) : "—";
  const bookGoal = state.goals.find((g) => g.metric === "books" && g.period === "year" && g.year === year);

  let goalCard = "";
  if (bookGoal) {
    const pct = Math.min(100, Math.round((finishedThisYear.length / bookGoal.target) * 100));
    goalCard = `<div class="card pad" style="margin-top:12px">
      <div style="display:flex;justify-content:space-between;font-weight:650"><span>${year} reading goal</span><span>${finishedThisYear.length}/${bookGoal.target}</span></div>
      <div class="bar"><span style="width:${pct}%"></span></div>
      <div class="muted" style="font-size:13px;margin-top:6px">${pct}% — ${Math.max(0, bookGoal.target - finishedThisYear.length)} to go</div>
    </div>`;
  }
  // rating distribution
  const dist = Array(10).fill(0); rated.forEach((b) => dist[b.rating - 1]++);
  const maxD = Math.max(1, ...dist);
  const distHtml = dist.map((n, i) => `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
      <div style="width:100%;background:var(--bg);border:1px solid var(--line);border-radius:5px 5px 0 0;height:70px;display:flex;align-items:flex-end;overflow:hidden">
        <div style="width:100%;background:linear-gradient(180deg,var(--gold),#e0b757);height:${(n / maxD) * 100}%"></div>
      </div>
      <div style="font-size:10px;color:var(--muted)">${i + 1}</div>
    </div>`).join("");

  return `
    <div class="section-title">This year (${year})</div>
    <div class="stats">
      <div class="stat"><div class="n">${finishedThisYear.length}</div><div class="l">Books finished</div></div>
      <div class="stat"><div class="n">${pagesThisYear.toLocaleString()}</div><div class="l">Pages read</div></div>
      <div class="stat"><div class="n">${reading.length}</div><div class="l">Currently reading</div></div>
      <div class="stat"><div class="n">${avg}</div><div class="l">Avg rating</div></div>
    </div>
    ${goalCard}
    <div class="section-title">All time</div>
    <div class="stats">
      <div class="stat"><div class="n">${state.books.length}</div><div class="l">In library</div></div>
      <div class="stat"><div class="n">${finished.length}</div><div class="l">Finished ever</div></div>
    </div>
    ${rated.length ? `<div class="section-title">How you rate (1–10)</div>
      <div class="card pad"><div style="display:flex;gap:4px;align-items:flex-end">${distHtml}</div></div>` : ""}`;
};

// ---- Goals tab ----------------------------------------------------------
views.goals = () => {
  const year = new Date().getFullYear();
  const gs = state.goals.slice().sort((a, b) => (b.year - a.year) || a.metric.localeCompare(b.metric));
  return `
    <div class="section-title">Your goals</div>
    ${gs.length ? `<div class="card">${gs.map(goalRow).join("")}</div>`
      : `<div class="empty" style="padding:24px"><div class="ic">🎯</div><p>No goals set yet.</p></div>`}
    <button class="btn" style="margin-top:14px" onclick="RL.addGoal()">+ New goal</button>
    <p class="muted" style="font-size:13px;margin-top:10px;padding:0 4px">Tip: a common goal is “${year}: read 24 books”. Finished books count automatically.</p>`;
};
function goalRow(g) {
  const year = new Date().getFullYear();
  let done = 0;
  if (g.metric === "books") {
    done = state.books.filter((b) => b.status === "finished" && (b.date_finished || "").startsWith(String(g.year))).length;
  } else {
    done = state.books.filter((b) => b.status === "finished" && (b.date_finished || "").startsWith(String(g.year)))
      .reduce((s, b) => s + (b.page_count || 0), 0);
  }
  const pct = Math.min(100, Math.round((done / g.target) * 100));
  const label = g.metric === "books" ? "books" : "pages";
  return `<div class="book" style="display:block">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div><div class="title">${g.year} · ${g.target.toLocaleString()} ${label}</div>
      <div class="authors">${done.toLocaleString()} / ${g.target.toLocaleString()} ${label} · ${pct}%</div></div>
      <button class="btn ghost" onclick="RL.removeGoal('${g.id}')">Delete</button>
    </div>
    <div class="bar" style="margin-top:8px"><span style="width:${pct}%"></span></div>
  </div>`;
}

// ---- Recommendations ----------------------------------------------------
views.recs = () => {
  const cache = load(LS.recs, null);
  const rated = state.books.filter((b) => b.rating >= 7);
  return `
    <div class="section-title">Recommended for you</div>
    <div class="card pad">
      <p class="muted" style="margin:0 0 10px;font-size:14px">
        ${rated.length ? `Based on ${rated.length} book${rated.length === 1 ? "" : "s"} you rated 7+.` :
          "Rate a few books 7 or higher and we'll find more you'll love."}
      </p>
      <button class="btn" onclick="RL.buildRecs()">${cache ? "↻ Refresh recommendations" : "✨ Find recommendations"}</button>
    </div>
    <div id="recsOut">${cache ? renderRecs(cache.items) : ""}</div>`;
};
function renderRecs(items) {
  if (!items || !items.length) return `<p class="muted center" style="margin-top:16px">No new suggestions found. Try refreshing after rating more books.</p>`;
  return `<div class="section-title">You might like</div>${shelfGrid(items, recTile)}`;
}
function recTile(b) {
  const art = b.cover_url ? `<img src="${esc(b.cover_url)}" loading="lazy" alt="">` : genCover(b);
  return `<div class="tile" onclick='RL.addRec(${JSON.stringify(b).replace(/'/g, "&#39;")})'>
    <div class="art">${art}<div class="ribbon" style="background:linear-gradient(0deg,color-mix(in srgb,var(--brand) 92%,#000),transparent)">+ Add</div></div>
    <div class="t">${esc(b.title)}</div><div class="a">${esc(authorStr(b))}</div>
  </div>`;
}
async function buildRecs() {
  const out = $("#recsOut");
  const rated = state.books.filter((b) => b.rating >= 7);
  if (!rated.length) { toast("Rate some books 7+ first"); return; }
  if (out) out.innerHTML = `<div class="empty"><span class="spin"></span><p>Finding books you'll love…</p></div>`;

  // favorite authors & genres, weighted by rating
  const authorScore = {}, genreScore = {};
  rated.forEach((b) => {
    const w = b.rating - 6;
    (b.authors || []).forEach((a) => (authorScore[a] = (authorScore[a] || 0) + w));
    (b.genres || []).forEach((g) => (genreScore[g] = (genreScore[g] || 0) + w));
  });
  const topAuthors = Object.entries(authorScore).sort((a, b) => b[1] - a[1]).slice(0, 4).map((x) => x[0]);
  const topGenres = Object.entries(genreScore).sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);

  const have = new Set(state.books.map(dedupeKey));
  const cand = new Map();
  const add = (b, reason, score) => {
    if (!b.title) return;
    const k = dedupeKey(b); if (have.has(k)) return;
    const ex = cand.get(k);
    if (ex) { ex.score += score; } else cand.set(k, { ...b, reason, score });
  };
  for (const a of topAuthors) {
    const r = await searchBooks(`inauthor:"${a}"`, 8);
    r.forEach((b) => add(b, `More by ${a.split(" ").slice(-1)[0]}`, 3));
  }
  for (const g of topGenres) {
    const r = await searchBooks(`subject:"${g}"`, 8);
    r.forEach((b) => add(b, g, 1));
  }
  const items = [...cand.values()].sort((a, b) => b.score - a.score).slice(0, 18);
  localStorage.setItem(LS.recs, JSON.stringify({ at: Date.now(), items }));
  if (out) out.innerHTML = renderRecs(items);
}

// ---------------------------------------------------------------- Book detail sheet
function openBook(id) {
  const b = state.books.find((x) => x.id === id); if (!b) return;
  const rateBtns = Array.from({ length: 10 }, (_, i) => i + 1)
    .map((n) => `<button class="${b.rating === n ? "on" : ""}" onclick="RL.rate('${id}',${n})">${n}</button>`).join("");
  const inQueue = b.queue_pos != null;
  sheet(`
    <div style="display:flex;gap:14px">
      ${coverEl(b)}
      <div style="flex:1;min-width:0">
        <h2 style="margin-top:0">${esc(b.title)}</h2>
        <div class="muted">${esc(authorStr(b))}</div>
        ${b.page_count ? `<div class="muted" style="font-size:13px;margin-top:4px">${b.page_count} pages · ${esc(b.format)}</div>` : ""}
        ${b.genres && b.genres.length ? `<div class="tags" style="margin-top:8px">${b.genres.map((g) => `<span class="pill">${esc(g)}</span>`).join("")}</div>` : ""}
      </div>
    </div>
    <label class="fld">Status</label>
    <div class="btn-row" style="margin-top:0">
      ${["unread", "reading", "finished"].map((s) =>
        `<button class="btn ${b.status === s ? "" : "secondary"}" onclick="RL.setStatus('${id}','${s}')">${s === "unread" ? "To read" : s[0].toUpperCase() + s.slice(1)}</button>`).join("")}
    </div>
    <label class="fld">Your rating (1–10)</label>
    <div class="rate-grid">${rateBtns}</div>
    <label class="fld">Notes</label>
    <textarea onchange="RL.setNotes('${id}',this.value)" placeholder="Thoughts, quotes, where you left off…">${esc(b.notes || "")}</textarea>
    <div class="btn-row">
      <button class="btn secondary" onclick="RL.toggleQueue('${id}')">${inQueue ? "− Remove from queue" : "+ Add to queue"}</button>
    </div>
    <div class="btn-row">
      <button class="btn danger" onclick="RL.confirmDelete('${id}')">Delete book</button>
    </div>
  `);
}

// ---------------------------------------------------------------- Add / confirm flows
function confirmAdd(data, extra) {
  if (existsAlready(data)) { toast(`Already in library: ${data.title}`); return; }
  sheet(`
    <h2 style="margin-top:0">Add this book?</h2>
    <div class="book" style="padding-left:0">
      ${coverEl(data)}
      <div class="meta"><div class="title">${esc(data.title)}</div>
      <div class="authors">${esc(authorStr(data))}</div>
      ${data.page_count ? `<div class="muted" style="font-size:13px">${data.page_count} pages</div>` : ""}</div>
    </div>
    <div class="btn-row">
      <button class="btn secondary" onclick="RL.closeSheet()">Cancel</button>
      <button class="btn" onclick='RL.doAdd(${JSON.stringify(data).replace(/'/g, "&#39;")},${JSON.stringify(extra).replace(/'/g, "&#39;")})'>Add to library</button>
    </div>`);
}
async function doAdd(data, extra) {
  closeSheet();
  const book = newBookFrom(data, extra);
  await upsertBook(book);
  toast(`Added: ${book.title}`);
}

async function manualSearch() {
  const q = prompt("Search by title (and author):"); if (!q) return;
  toast("Searching…");
  const res = await searchBooks(q, 12);
  if (!res.length) { toast("No results"); return; }
  sheet(`<h2 style="margin-top:0">Search results</h2>
    <div class="card">${res.map((b) => `
      <div class="book" onclick='RL.pickResult(${JSON.stringify(b).replace(/'/g, "&#39;")})'>
        ${coverEl(b)}
        <div class="meta"><div class="title">${esc(b.title)}</div>
        <div class="authors">${esc(authorStr(b))}</div></div>
      </div>`).join("")}</div>`);
}
function pickResult(b) { closeSheet(); confirmAdd(b, { source: "manual", format: "physical" }); }

async function manualISBN() {
  const isbn = prompt("Enter the ISBN (numbers under the barcode):"); if (!isbn) return;
  toast("Looking up…");
  const data = await lookupISBN(isbn);
  if (!data) { toast("No match for that ISBN"); return; }
  confirmAdd(data, { source: "manual", format: "physical" });
}

// ---------------------------------------------------------------- Imports
function importKindle() {
  sheet(`<h2 style="margin-top:0">Import Kindle library</h2>
    <p class="muted" style="font-size:14px">
      In Amazon: <b>Account → Content Library</b> (or <b>Manage Your Content and Devices</b>) →
      use the <b>Download / export</b> option to get a CSV of your books, then upload it here.
    </p>
    <label class="fld">Choose the CSV file</label>
    <input type="file" accept=".csv,text/csv" onchange="RL.handleKindleFile(this.files[0])">
    <p class="muted" style="font-size:12px;margin-top:10px">We read Title & Author columns, add them as eBooks, then fetch covers in the background.</p>`);
}
async function handleKindleFile(file) {
  if (!file) return;
  const text = await file.text();
  const rows = parseCSV(text);
  if (rows.length < 2) { toast("Couldn't read that CSV"); return; }
  const head = rows[0].map((h) => h.toLowerCase().trim());
  const ti = head.findIndex((h) => h.includes("title"));
  const ai = head.findIndex((h) => h.includes("author"));
  if (ti < 0) { toast("No Title column found"); return; }
  let added = 0;
  const toEnrich = [];
  for (const r of rows.slice(1)) {
    const title = (r[ti] || "").trim(); if (!title) continue;
    const authors = ai >= 0 && r[ai] ? [r[ai].trim()] : [];
    const data = { title, authors, genres: [] };
    if (existsAlready(data)) continue;
    const book = newBookFrom(data, { source: "kindle", format: "ebook" });
    state.books.unshift(book); toEnrich.push(book); added++;
  }
  persist(); closeSheet(); render();
  toast(`Imported ${added} Kindle book${added === 1 ? "" : "s"}`);
  // push + enrich covers in the background (throttled)
  enrichAndPush(toEnrich);
}

function importNAS() {
  sheet(`<h2 style="margin-top:0">Import NAS eBooks</h2>
    <p class="muted" style="font-size:14px">On your Mac (connected to the NAS), run the helper script
      <b>nas-scan.sh</b> from the repo — it writes <code>nas-books.txt</code>, one book per line.
      Upload that file, or paste the lines below.</p>
    <label class="fld">Upload nas-books.txt</label>
    <input type="file" accept=".txt,.csv,text/plain" onchange="RL.handleNASFile(this.files[0])">
    <label class="fld">…or paste filenames (one per line)</label>
    <textarea id="nasPaste" placeholder="The Fellowship of the Ring - J.R.R. Tolkien.epub&#10;Dune - Frank Herbert.mobi"></textarea>
    <button class="btn" style="margin-top:10px" onclick="RL.handleNASPaste()">Import pasted list</button>`);
}
async function handleNASFile(file) { if (!file) return; ingestNAS(await file.text()); }
function handleNASPaste() { const t = $("#nasPaste"); if (t) ingestNAS(t.value); }
async function ingestNAS(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) { toast("Nothing to import"); return; }
  let added = 0; const toEnrich = [];
  for (const line of lines) {
    const { title, author } = parseFilename(line);
    if (!title) continue;
    const data = { title, authors: author ? [author] : [], genres: [] };
    if (existsAlready(data)) continue;
    const book = newBookFrom(data, { source: "nas", format: "ebook" });
    state.books.unshift(book); toEnrich.push(book); added++;
  }
  persist(); closeSheet(); render();
  toast(`Imported ${added} eBook${added === 1 ? "" : "s"} from NAS`);
  enrichAndPush(toEnrich);
}
// "Title - Author.epub" | "Author - Title.epub" | "Title.epub"
function parseFilename(name) {
  let s = name.replace(/^.*[\\/]/, "").replace(/\.(epub|mobi|azw3?|pdf|txt|fb2|cbz)$/i, "").trim();
  const parts = s.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { title: parts[0].trim(), author: parts.slice(1).join(" - ").trim() };
  return { title: s, author: "" };
}
// Standardize titles/authors + fetch covers (throttled), then push everything to Supabase.
async function enrichAndPush(books) {
  let n = 0;
  for (const b of books) {
    try { Object.assign(b, await canonicalize(b)); } catch {}
    await pushRow("books", b);
    if (++n % 5 === 0) { persist(); if (state.tab === "library") render(); }
    await new Promise((r) => setTimeout(r, 300)); // be gentle on the free API
  }
  persist(); render();
}
// Re-run standardization + cover fetch on books already in the library (imports).
async function normalizeLibrary() {
  closeSheet();
  const targets = state.books.filter((b) => !b.cover_url);
  if (!targets.length) { toast("Every book already has a cover ✓"); return; }
  let done = 0;
  toast(`Cleaning up ${targets.length} books…`);
  for (const b of targets) {
    try { Object.assign(b, await canonicalize(b)); await pushRow("books", b); } catch {}
    if (++done % 4 === 0) { toast(`Cleaning up… ${done}/${targets.length}`); persist(); if (state.tab === "library") render(); }
    await new Promise((r) => setTimeout(r, 300));
  }
  persist(); render();
  toast(`Done — cleaned ${done} book${done === 1 ? "" : "s"} ✓`);
}

// ---------------------------------------------------------------- Goals mgmt
function addGoal() {
  const year = new Date().getFullYear();
  sheet(`<h2 style="margin-top:0">New reading goal</h2>
    <label class="fld">I want to read…</label>
    <div class="row2">
      <input id="gTarget" type="number" inputmode="numeric" placeholder="24" value="24">
      <select id="gMetric"><option value="books">books</option><option value="pages">pages</option></select>
    </div>
    <label class="fld">In year</label>
    <input id="gYear" type="number" inputmode="numeric" value="${year}">
    <button class="btn" style="margin-top:14px" onclick="RL.saveGoal()">Save goal</button>`);
}
async function saveGoal() {
  const target = parseInt($("#gTarget").value, 10);
  const metric = $("#gMetric").value;
  const year = parseInt($("#gYear").value, 10) || new Date().getFullYear();
  if (!target || target < 1) { toast("Enter a target number"); return; }
  closeSheet();
  await upsertGoal({ id: uid(), metric, target, period: "year", year, month: null });
  toast("Goal saved");
}

// ---------------------------------------------------------------- Settings / backup
function openSettings() {
  const conn = SB_READY ? (state.sync === "ok" ? "Connected & synced ✓" : state.sync === "bad" ? "Connection error — data saved locally, will retry" : "Configured, connecting…") : "Not configured (local only)";
  sheet(`<h2 style="margin-top:0">Settings</h2>
    <div class="card pad">
      <div style="font-weight:650;margin-bottom:4px">Cloud sync</div>
      <div class="muted" style="font-size:14px">${conn}</div>
      ${state.pending.length ? `<div class="muted" style="font-size:13px;margin-top:6px">${state.pending.length} change(s) waiting to sync.</div>` : ""}
      <button class="btn secondary" style="margin-top:10px" onclick="RL.refresh()">↻ Refresh from cloud</button>
    </div>
    <div class="section-title">Clean up imports</div>
    <div class="card pad">
      <div class="muted" style="font-size:14px;margin-bottom:10px">Standardize messy titles/authors and fetch cover images for imported books (Kindle & NAS).</div>
      <button class="btn" onclick="RL.normalizeLibrary()">✨ Clean up & fetch covers</button>
    </div>
    <div class="section-title">Backup</div>
    <div class="card pad">
      <div class="btn-row" style="margin-top:0">
        <button class="btn secondary" onclick="RL.exportData()">⬇︎ Export JSON</button>
        <button class="btn secondary" onclick="document.getElementById('impFile').click()">⬆︎ Import JSON</button>
      </div>
      <input id="impFile" type="file" accept=".json" style="display:none" onchange="RL.importData(this.files[0])">
    </div>
    <p class="muted center" style="font-size:12px;margin-top:14px">Reading Library · data stored in Supabase + this device</p>`);
}
function exportData() {
  const blob = new Blob([JSON.stringify({ books: state.books, goals: state.goals, exported: new Date().toISOString() }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `reading-library-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
}
async function importData(file) {
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (Array.isArray(d.books)) for (const b of d.books) { if (!existsAlready(b)) { b.id = b.id || uid(); state.books.push(b); await pushRow("books", b); } }
    if (Array.isArray(d.goals)) for (const g of d.goals) { g.id = g.id || uid(); await upsertGoal(g); }
    persist(); closeSheet(); render(); toast("Backup imported");
  } catch { toast("Couldn't read that backup file"); }
}

// ---------------------------------------------------------------- Sheet plumbing
function sheet(html) {
  closeSheet();
  const bg = document.createElement("div");
  bg.className = "sheet-bg"; bg.id = "sheetBg";
  bg.innerHTML = `<div class="sheet"><button class="close" onclick="RL.closeSheet()">✕</button>${html}</div>`;
  bg.addEventListener("click", (e) => { if (e.target === bg) closeSheet(); });
  document.body.appendChild(bg);
}
function closeSheet() { const b = $("#sheetBg"); if (b) b.remove(); }

// ---------------------------------------------------------------- Small CSV parser
function parseCSV(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") {}
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

// ---------------------------------------------------------------- Actions bound to buttons
const RL = {
  go(t) { if (state.tab === "scan" && t !== "scan") stopScan(); state.tab = t; state.query = ""; render(); },
  toggleScan, manualSearch, manualISBN, pickResult,
  doAdd, closeSheet, openBook,
  setQuery(v) { state.query = v; const m = $("main"); if (m) { /* light re-render of list only */ } state._q && clearTimeout(state._q); state._q = setTimeout(() => { const cur = document.activeElement; render(); const inp = $(".searchbar input"); if (inp && cur && cur.className === inp.className) { inp.focus(); inp.setSelectionRange(v.length, v.length); } }, 120); },
  setFilter(f) { state.filter = f; render(); },
  async rate(id, n) { const b = state.books.find((x) => x.id === id); if (!b) return; b.rating = b.rating === n ? null : n; await upsertBook(b); openBook(id); },
  async setStatus(id, s) {
    const b = state.books.find((x) => x.id === id); if (!b) return;
    b.status = s;
    if (s === "reading" && !b.date_started) b.date_started = new Date().toISOString().slice(0, 10);
    if (s === "finished") { b.date_finished = new Date().toISOString().slice(0, 10); if (b.page_count) b.pages_read = b.page_count; if (b.queue_pos != null) b.queue_pos = null; }
    await upsertBook(b); openBook(id);
  },
  async setNotes(id, v) { const b = state.books.find((x) => x.id === id); if (!b) return; b.notes = v; await upsertBook(b); },
  async toggleQueue(id) {
    const b = state.books.find((x) => x.id === id); if (!b) return;
    if (b.queue_pos != null) b.queue_pos = null;
    else { const max = Math.max(0, ...state.books.filter((x) => x.queue_pos != null).map((x) => x.queue_pos)); b.queue_pos = max + 1; }
    await upsertBook(b); openBook(id);
  },
  async moveQueue(id, dir) {
    const q = state.books.filter((b) => b.queue_pos != null).sort((a, b) => a.queue_pos - b.queue_pos);
    const i = q.findIndex((b) => b.id === id); const j = i + dir;
    if (j < 0 || j >= q.length) return;
    const a = q[i], b = q[j]; const tmp = a.queue_pos; a.queue_pos = b.queue_pos; b.queue_pos = tmp;
    persist(); render(); pushRow("books", a); pushRow("books", b);
  },
  confirmDelete(id) {
    const b = state.books.find((x) => x.id === id); if (!b) return;
    sheet(`<h2 style="margin-top:0">Delete book?</h2>
      <p class="muted">“${esc(b.title)}” will be removed from your library everywhere.</p>
      <div class="btn-row">
        <button class="btn secondary" onclick="RL.closeSheet()">Cancel</button>
        <button class="btn danger" onclick="RL.reallyDelete('${id}')">Delete</button>
      </div>`);
  },
  async reallyDelete(id) { closeSheet(); await deleteBook(id); toast("Deleted"); },
  addGoal, saveGoal, removeGoal(id) { deleteGoal(id); toast("Goal removed"); },
  buildRecs, addRec(b) { confirmAdd(b, { source: "manual", format: "physical" }); },
  importKindle, handleKindleFile, importNAS, handleNASFile, handleNASPaste,
  openSettings, exportData, importData, normalizeLibrary,
  async refresh() { closeSheet(); toast("Refreshing…"); await pullAll(); render(); },
};
window.RL = RL;

// ---------------------------------------------------------------- Boot
window.addEventListener("online", flushPending);
render();
(async () => {
  if (SB_READY) { await pullAll(); await flushPending(); render(); }
})();

// Service worker
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
