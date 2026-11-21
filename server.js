// Zero-dependency local server for the daily speaking practice app.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { TOPICS } = require("./topics");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const REC_DIR = path.join(ROOT, "recordings");
const DB_FILE = path.join(DATA_DIR, "sessions.json");
const NOTES_DIR = path.join(ROOT, "notes");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(REC_DIR, { recursive: true });
fs.mkdirSync(NOTES_DIR, { recursive: true });

// ---------- storage ----------
function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    db.sessions ||= {};
    db.skipped ||= [];
    return db;
  } catch {
    return { sessions: {}, skipped: [] };
  }
}
function saveDb(db) {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- topic selection ----------
// A fixed, seeded shuffle so the daily order is stable but not grouped by category.
function seededOrder(n, seed = 193) {
  const order = [...Array(n).keys()];
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
const ORDER = seededOrder(TOPICS.length);

function pickTopic(db, excludeDate) {
  const used = new Set(db.skipped);
  for (const [date, s] of Object.entries(db.sessions)) {
    if (date !== excludeDate && s.topicId != null) used.add(s.topicId);
  }
  let next = ORDER.find((id) => !used.has(id));
  if (next === undefined) {
    // Bank exhausted: start a new cycle.
    db.skipped = [];
    const current = db.sessions[excludeDate]?.topicId;
    next = ORDER.find((id) => id !== current) ?? ORDER[0];
  }
  return next;
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function ensureToday(db) {
  const date = todayStr();
  if (!db.sessions[date]) {
    db.sessions[date] = { date, topicId: pickTopic(db, date), notes: "", createdAt: new Date().toISOString() };
    saveDb(db);
  }
  return db.sessions[date];
}

function withTopic(s) {
  return { ...s, topic: TOPICS[s.topicId] || null };
}

function previousFix(db, date) {
  const prev = Object.keys(db.sessions).filter((d) => d < date && db.sessions[d].fixTomorrow).sort().pop();
  return prev ? { date: prev, text: db.sessions[prev].fixTomorrow } : null;
}

// ---------- readable notes file per day (notes/Day N - YYYY-MM-DD.md) ----------
const RUBRIC_NAMES = { clarity: "Clarity", structure: "Structure", pace: "Pace & pauses", delivery: "Confidence & eye contact", depth: "Technical depth" };
function writeNotesFile(s) {
  const t = TOPICS[s.topicId];
  if (!t) return;
  const name = (s.day ? `Day ${s.day} - ${s.date}` : s.date) + ".md";
  const lines = [
    `# ${s.day ? `Day ${s.day}: ` : ""}${t.title}`,
    `*${s.date} · ${t.category}*`,
    "",
    `> ${t.summary}`,
    "",
    "## The talk should answer",
    ...t.questions.map((q, i) => `${i + 1}. ${q}`),
    "",
    "## My notes",
    (s.notes || "").trim() || "_(none)_",
    "",
  ];
  if (s.fixTomorrow) lines.push("## What I need to improve", s.fixTomorrow, "");
  if (s.ratings) {
    lines.push("## Self-review", ...Object.entries(RUBRIC_NAMES).map(([k, n]) => `- ${n}: ${s.ratings[k] ?? "–"} / 5`));
    if (typeof s.fillerCount === "number") lines.push(`- Filler words counted: ${s.fillerCount}`);
    lines.push("");
  }
  if (s.durationSec) lines.push(`Recording: ${s.recording || "–"} (${Math.floor(s.durationSec / 60)}m ${s.durationSec % 60}s)`, "");
  if (s.transcript) lines.push("## Transcript", s.transcript, "");
  try {
    fs.writeFileSync(path.join(NOTES_DIR, name), lines.join("\n"));
    if (s.day) fs.rmSync(path.join(NOTES_DIR, s.date + ".md"), { force: true }); // replaced by the "Day N" file
  } catch (e) { console.error("notes file:", e.message); }
}

// ---------- helpers ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end("Not found"); return; }
    const type = MIME[path.extname(file)] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (m && !m[1] && m[2]) { start = st.size - parseInt(m[2], 10); end = st.size - 1; }
      if (start >= st.size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); res.end(); return;
      }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Range": `bytes ${start}-${end}/${st.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
      fs.createReadStream(file).pipe(res);
    }
  });
}

const EDITABLE = ["notes", "ratings", "fillerCount", "metrics", "transcript", "fixTomorrow", "durationSec", "completedAt"];

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = decodeURIComponent(url.pathname);

  if (p === "/api/today" && req.method === "GET") {
    const db = loadDb();
    const s = ensureToday(db);
    return sendJson(res, 200, { session: withTopic(s), previousFix: previousFix(db, s.date), topicCount: TOPICS.length });
  }

  if (p === "/api/reroll" && req.method === "POST") {
    const db = loadDb();
    const s = ensureToday(db);
    if (s.topicId != null) db.skipped.push(s.topicId);
    s.topicId = pickTopic(db, s.date);
    saveDb(db);
    return sendJson(res, 200, { session: withTopic(s) });
  }

  if (p === "/api/sessions" && req.method === "GET") {
    const db = loadDb();
    const list = Object.values(db.sessions).sort((a, b) => a.date.localeCompare(b.date)).map(withTopic);
    return sendJson(res, 200, { sessions: list });
  }

  let m;
  if ((m = /^\/api\/session\/([\d-]+)$/.exec(p)) && req.method === "PUT") {
    const date = m[1];
    if (!DATE_RE.test(date)) return sendJson(res, 400, { error: "bad date" });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const db = loadDb();
    const s = db.sessions[date];
    if (!s) return sendJson(res, 404, { error: "no session" });
    for (const k of EDITABLE) if (k in body) s[k] = body[k];
    s.updatedAt = new Date().toISOString();
    saveDb(db);
    writeNotesFile(s);
    return sendJson(res, 200, { session: withTopic(s) });
  }

  if ((m = /^\/api\/recording\/([\d-]+)$/.exec(p)) && req.method === "POST") {
    const date = m[1];
    if (!DATE_RE.test(date)) return sendJson(res, 400, { error: "bad date" });
    const db = loadDb();
    const s = db.sessions[date];
    if (!s) return sendJson(res, 404, { error: "no session" });
    const ext = (req.headers["content-type"] || "").includes("mp4") ? ".mp4" : ".webm";
    // Day number: keep it when re-recording the same day, otherwise next after the highest so far.
    const day = s.day || 1 + Math.max(0, ...Object.values(db.sessions).filter((x) => x.date !== date && x.recording).map((x) => x.day || 0));
    const name = `Day ${day} - ${date}${ext}`;
    const tmp = path.join(REC_DIR, name + ".part");
    const out = fs.createWriteStream(tmp);
    req.pipe(out);
    out.on("finish", () => {
      fs.renameSync(tmp, path.join(REC_DIR, name));
      const fresh = loadDb();
      const old = fresh.sessions[date].recording;
      if (old && old !== name) fs.rmSync(path.join(REC_DIR, path.basename(old)), { force: true });
      fresh.sessions[date].day = day;
      fresh.sessions[date].recording = name;
      fresh.sessions[date].recordedAt = new Date().toISOString();
      const dur = Number(url.searchParams.get("duration"));
      if (dur > 0) fresh.sessions[date].durationSec = dur;
      saveDb(fresh);
      writeNotesFile(fresh.sessions[date]);
      sendJson(res, 200, { session: withTopic(fresh.sessions[date]) });
    });
    out.on("error", () => sendJson(res, 500, { error: "write failed" }));
    return;
  }

  if (p.startsWith("/recordings/") && req.method === "GET") {
    const file = path.join(REC_DIR, path.basename(p));
    return serveFile(req, res, file);
  }

  if (req.method === "GET") {
    const rel = p === "/" ? "index.html" : p.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
    return serveFile(req, res, file);
  }

  res.writeHead(405); res.end();
}

const onRequest = (req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) sendJson(res, 500, { error: String(e) }); });
};
// Listen on both IPv4 and IPv6 loopback (Safari resolves "localhost" to ::1 first). Local-only.
http.createServer(onRequest).listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Speaking practice running at  http://localhost:${PORT}\n  (leave this terminal open; Ctrl+C to stop)\n`);
});
http.createServer(onRequest).listen(PORT, "::1").on("error", () => {});
