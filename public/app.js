"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtClock = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

const RUBRIC = [
  { key: "clarity", name: "Clarity", desc: "Could a sophomore follow it?" },
  { key: "structure", name: "Structure", desc: "Clear intro, logical flow, recap at the end" },
  { key: "pace", name: "Pace & pauses", desc: "Not rushed; silent pauses instead of fillers" },
  { key: "delivery", name: "Confidence & eye contact", desc: "Looked at the lens, steady voice, little reading" },
  { key: "depth", name: "Technical depth", desc: "Accurate, and went past the surface" },
];
const TARGET_SEC = 600;

let session = null;

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}
function saveSession(patch) {
  return api(`/api/session/${session.date}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).then((r) => { session = r.session; updateStepper(); return r; });
}

// ---------- metrics helpers ----------
const HARD_FILLERS = /\b(u+m+|u+h+|erm|er|a+h+|hmm+|mm+)\b/gi;
const SOFT_FILLERS = /\b(like|you know|basically|actually|literally|kind of|sort of|i mean)\b/gi;
function computeMetrics(text, durationSec, longestPauseSec) {
  const words = (text.match(/\b[\w']+\b/g) || []).length;
  const hard = (text.match(HARD_FILLERS) || []).length;
  const soft = (text.match(SOFT_FILLERS) || []).length;
  const min = Math.max(durationSec, 1) / 60;
  return { words, fillers: hard + soft, hardFillers: hard, softFillers: soft, wpm: Math.round(words / min), longestPauseSec: Math.round(longestPauseSec || 0) };
}
function avgScore(s) {
  const vals = RUBRIC.map((r) => s.ratings?.[r.key]).filter((v) => typeof v === "number");
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
function fillersPerMin(s) {
  const count = typeof s.fillerCount === "number" ? s.fillerCount : s.metrics?.fillers;
  if (typeof count !== "number" || !s.durationSec) return null;
  return count / (s.durationSec / 60);
}

// MediaRecorder WebM files have no duration header; this forces the browser to compute it so seeking works.
function loadVideo(video, src) {
  video.onloadedmetadata = () => {
    if (video.duration === Infinity) {
      video.currentTime = 1e101;
      video.ontimeupdate = () => { video.ontimeupdate = null; video.currentTime = 0; };
    }
  };
  video.src = src;
}
const recUrl = (s) => `/recordings/${encodeURIComponent(s.recording)}?v=${encodeURIComponent(s.recordedAt || "")}`;

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach((t, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = [660, 880, 990][i];
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.4);
      o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.45);
    });
  } catch {}
}

// ======================= TODAY VIEW =======================
async function loadToday() {
  const { session: s, previousFix } = await api("/api/today");
  session = s;
  $("dateLine").textContent = new Date(s.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (previousFix) {
    $("prevFix").hidden = false;
    $("prevFixText").textContent = previousFix.text;
  }
  renderTopic();
  $("notes").value = s.notes || "";
  $("notesMirror").textContent = s.notes || "(no notes yet)";
  renderReview();
  updateStepper();
}

function renderTopic() {
  const t = session.topic;
  $("topicCategory").textContent = t.category;
  $("topicTitle").textContent = t.title;
  $("topicSummary").textContent = t.summary;
  $("topicQuestions").innerHTML = t.questions.map((q) => `<li>${esc(q)}</li>`).join("");
  $("searchLink").href = `https://www.google.com/search?q=${encodeURIComponent(t.title + " explained")}`;
}

function updateStepper() {
  if (!session) return;
  const done = {
    1: !!session.topic,
    2: (session.notes || "").trim().length > 20,
    3: !!session.recording,
    4: !!session.completedAt,
  };
  document.querySelectorAll("#stepper li").forEach((li) => li.classList.toggle("done", done[li.dataset.step]));
}
document.querySelectorAll("#stepper li").forEach((li) =>
  li.addEventListener("click", () => $("step" + li.dataset.step).scrollIntoView({ behavior: "smooth", block: "start" }))
);

$("rerollBtn").addEventListener("click", async () => {
  if (session.recording && !confirm("You already recorded a talk on this topic today. Reroll anyway?")) return;
  if ((session.notes || "").trim() && !session.recording && !confirm("You have notes for this topic. Reroll anyway? (Your notes stay, so clear them if you want.)")) return;
  const r = await api("/api/reroll", { method: "POST" });
  session = r.session;
  renderTopic();
});

// ---------- research timer ----------
let researchLeft = TARGET_SEC, researchTick = null, chimed = false;
function drawResearch() {
  const el = $("researchTimer");
  el.textContent = researchLeft >= 0 ? fmtClock(researchLeft) : "+" + fmtClock(-researchLeft);
  el.classList.toggle("done", researchLeft <= 0);
}
$("researchStart").addEventListener("click", () => {
  if (researchTick) {
    clearInterval(researchTick); researchTick = null; $("researchStart").textContent = "Resume";
  } else {
    $("researchStart").textContent = "Pause";
    researchTick = setInterval(() => {
      researchLeft--;
      if (researchLeft === 0 && !chimed) { chimed = true; chime(); }
      drawResearch();
    }, 1000);
  }
});
$("researchReset").addEventListener("click", () => {
  clearInterval(researchTick); researchTick = null; researchLeft = TARGET_SEC; chimed = false;
  $("researchStart").textContent = "Start"; drawResearch();
});

// ---------- notes autosave ----------
let notesTimer = null;
$("notes").addEventListener("input", () => {
  const v = $("notes").value;
  $("notesMirror").textContent = v || "(no notes yet)";
  $("notesState").textContent = "Saving…";
  clearTimeout(notesTimer);
  notesTimer = setTimeout(async () => {
    try { await saveSession({ notes: v }); $("notesState").textContent = "Saved"; }
    catch { $("notesState").textContent = "Couldn't save. Is the server running?"; }
  }, 600);
});

// ---------- recording ----------
let stream = null, recorder = null, chunks = [], recStart = 0, recTick = null;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, transcriptUsed = false, finalText = "", interimText = "", lastResultAt = 0, longestPause = 0;

if (!SR) {
  $("transcriptToggle").disabled = true;
  $("transcriptLabel").lastChild.textContent = " Live transcript isn't supported in this browser (try Chrome or Safari)";
}

$("camBtn").addEventListener("click", async () => {
  if (stream) { stopCamera(); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
    $("preview").srcObject = stream;
    $("previewEmpty").hidden = true;
    $("recBtn").disabled = false;
    $("camBtn").textContent = "Turn off camera";
  } catch (e) {
    $("recState").textContent = "Camera/mic access failed: " + e.message;
  }
});
function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $("preview").srcObject = null;
  $("previewEmpty").hidden = false;
  $("recBtn").disabled = true;
  $("camBtn").textContent = "Enable camera";
}

function pickMime() {
  const opts = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4;codecs=avc1,mp4a", "video/mp4"];
  return opts.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
}

$("recBtn").addEventListener("click", () => (recorder ? stopRecording() : startRecording()));

function startRecording() {
  if (session.recording && !confirm("Replace today's existing recording?")) return;
  chunks = [];
  transcriptUsed = false;
  const mimeType = pickMime();
  recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : undefined);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = uploadRecording;
  recorder.start(1000);
  recStart = Date.now();
  $("recBtn").textContent = "Stop recording";
  $("recBtn").classList.add("recording");
  $("recDot").hidden = false;
  $("camBtn").disabled = true;
  $("transcriptToggle").disabled = true;
  $("recState").textContent = "";
  recTick = setInterval(() => {
    const el = (Date.now() - recStart) / 1000;
    $("recTimer").textContent = fmtClock(el);
    $("recTimer").classList.toggle("done", el >= TARGET_SEC);
    if (el >= TARGET_SEC) $("recTarget").textContent = "target hit ✓";
  }, 250);
  if ($("transcriptToggle").checked && SR) startTranscript();
}

function stopRecording() {
  clearInterval(recTick);
  stopTranscript();
  recorder.stop();
  $("recBtn").textContent = "Start recording";
  $("recBtn").classList.remove("recording");
  $("recDot").hidden = true;
  $("camBtn").disabled = false;
  $("transcriptToggle").disabled = !SR;
}

async function uploadRecording() {
  const durationSec = Math.round((Date.now() - recStart) / 1000);
  const type = recorder.mimeType || chunks[0]?.type || "video/webm";
  const blob = new Blob(chunks, { type });
  recorder = null;
  $("recState").textContent = `Saving recording (${(blob.size / 1e6).toFixed(1)} MB)…`;
  try {
    const r = await api(`/api/recording/${session.date}?duration=${durationSec}`, {
      method: "POST", headers: { "Content-Type": type.split(";")[0] }, body: blob,
    });
    session = r.session;
    const patch = { durationSec };
    const text = (finalText + " " + interimText).trim();
    if (transcriptUsed) {
      patch.transcript = text;
      patch.metrics = computeMetrics(text, durationSec, longestPause);
    } else {
      patch.transcript = null; patch.metrics = null;
    }
    patch.completedAt = null; // a new recording needs a new review
    await saveSession(patch);
    $("recState").textContent = `Saved as "${session.recording}" (${fmtClock(durationSec)}). Now watch it back below.`;
    renderReview();
    $("step4").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    $("recState").textContent = "Upload failed: " + e.message;
  }
}

function startTranscript() {
  transcriptUsed = true;
  finalText = ""; interimText = ""; longestPause = 0; lastResultAt = Date.now();
  $("liveStats").hidden = false; $("liveWords").textContent = "0"; $("liveFillers").textContent = "0";
  recog = new SR();
  recog.continuous = true;
  recog.interimResults = true;
  recog.lang = "en-US";
  recog.onresult = (e) => {
    const now = Date.now();
    longestPause = Math.max(longestPause, (now - lastResultAt) / 1000);
    lastResultAt = now;
    interimText = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += " " + e.results[i][0].transcript;
      else interimText += " " + e.results[i][0].transcript;
    }
    const m = computeMetrics(finalText + interimText, 60, 0);
    $("liveWords").textContent = m.words;
    $("liveFillers").textContent = m.fillers;
  };
  recog.onend = () => { if (recorder && recog) { try { recog.start(); } catch {} } }; // recognition times out; keep it alive
  recog.onerror = () => {};
  try { recog.start(); } catch {}
}
function stopTranscript() {
  if (!recog) return;
  const r = recog;
  recog = null;
  r.onend = null;
  try { r.stop(); } catch {}
}

window.addEventListener("beforeunload", (e) => { if (recorder) { e.preventDefault(); e.returnValue = ""; } });

// ---------- review ----------
let ratings = {};
function renderReview() {
  const s = session;
  if (s.recording) {
    $("playbackEmpty").hidden = true;
    if (!$("playback").src.includes(encodeURIComponent(s.recordedAt || ""))) loadVideo($("playback"), recUrl(s));
  } else {
    $("playbackEmpty").hidden = false;
  }

  const m = s.metrics;
  if (m) {
    $("autoMetrics").hidden = false;
    $("autoMetrics").innerHTML = [
      ["Length", fmtClock(s.durationSec || 0)],
      ["Words / min", m.wpm],
      ["Fillers detected", m.fillers],
      ["Longest silence", m.longestPauseSec + "s"],
    ].map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join("");
    $("transcriptBox").hidden = !s.transcript;
    $("transcriptText").textContent = s.transcript || "";
  } else if (s.durationSec) {
    $("autoMetrics").hidden = false;
    $("autoMetrics").innerHTML = `<div class="metric"><div class="k">Length</div><div class="v">${fmtClock(s.durationSec)}</div></div>`;
    $("transcriptBox").hidden = true;
  }

  ratings = { ...(s.ratings || {}) };
  $("rubric").innerHTML = RUBRIC.map((r) => `
    <div class="rubric-row">
      <div class="rubric-name">${r.name}<small>${r.desc}</small></div>
      <div class="scale" data-key="${r.key}">
        ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-v="${n}" class="${ratings[r.key] === n ? "on" : ""}">${n}</button>`).join("")}
      </div>
    </div>`).join("");
  $("fillerCount").value = typeof s.fillerCount === "number" ? s.fillerCount : "";
  $("fixTomorrow").value = s.fixTomorrow || "";
}

$("rubric").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b) return;
  const key = b.parentElement.dataset.key;
  ratings[key] = Number(b.dataset.v);
  b.parentElement.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
});

$("saveReview").addEventListener("click", async () => {
  const missing = RUBRIC.filter((r) => !ratings[r.key]);
  if (missing.length) { $("reviewState").textContent = "Rate all five: " + missing.map((r) => r.name).join(", "); return; }
  if (!session.recording) { $("reviewState").textContent = "Record your talk first."; return; }
  const fc = $("fillerCount").value.trim();
  try {
    await saveSession({
      ratings,
      fillerCount: fc === "" ? null : Number(fc),
      fixTomorrow: $("fixTomorrow").value.trim(),
      completedAt: new Date().toISOString(),
    });
    $("reviewState").textContent = "Saved. See you tomorrow.";
    refreshStreak();
  } catch (e) {
    $("reviewState").textContent = "Save failed: " + e.message;
  }
});

// ======================= PROGRESS VIEW =======================
function computeStreak(sessions) {
  const have = new Set(sessions.filter((s) => s.recording).map((s) => s.date));
  const d = new Date();
  const key = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  if (!have.has(key(d))) d.setDate(d.getDate() - 1); // today not done yet doesn't break the streak
  let n = 0;
  while (have.has(key(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
async function refreshStreak() {
  const { sessions } = await api("/api/sessions");
  $("streakNum").textContent = computeStreak(sessions);
  return sessions;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const shortDate = (d) => new Date(d + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });

async function loadProgress() {
  const all = await refreshStreak();
  const done = all.filter((s) => s.recording);

  // tiles
  const scored = done.filter((s) => avgScore(s) != null);
  const first = mean(scored.slice(0, 5).map(avgScore));
  const last = mean(scored.slice(-5).map(avgScore));
  const totalMin = done.reduce((a, s) => a + (s.durationSec || 0), 0) / 60;
  const fpm = done.map(fillersPerMin).filter((v) => v != null);
  const tiles = [
    ["Current streak", computeStreak(all), "days in a row"],
    ["Talks recorded", done.length, `${Math.round(totalMin)} min spoken total`],
    ["Avg score (last 5)", last != null ? last.toFixed(1) : "–", first != null && scored.length > 5 ? `${last - first >= 0 ? "+" : ""}${(last - first).toFixed(1)} vs. first 5` : "out of 5"],
    ["Fillers / min (last 5)", fpm.length ? mean(fpm.slice(-5)).toFixed(1) : "–", fpm.length > 5 ? `was ${mean(fpm.slice(0, 5)).toFixed(1)} in first 5` : "lower is better"],
  ];
  $("tiles").innerHTML = tiles.map(([k, v, d]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("");

  // charts
  const series = (fn) => done.map((s) => ({ date: s.date, value: fn(s) })).filter((p) => p.value != null);
  $("charts").innerHTML = "";
  addChart("Average self-rating", "1–5, higher is better", series(avgScore), { yMin: 1, yMax: 5, fmt: (v) => v.toFixed(1) });
  addChart("Filler words per minute", "Your count, or the auto count if you didn't enter one. Lower is better", series(fillersPerMin), { yMin: 0, fmt: (v) => v.toFixed(1) });
  addChart("Speaking pace", "Words per minute, from the transcript (130–160 is a good lecture pace)", series((s) => s.metrics?.wpm ?? null), { fmt: (v) => Math.round(v) + " wpm" });
  addChart("Talk length", "Minutes without stopping (target 10)", series((s) => (s.durationSec ? s.durationSec / 60 : null)), { yMin: 0, fmt: (v) => v.toFixed(1) + " min" });

  // compare
  const opts = done.map((s) => `<option value="${s.date}">${s.day ? `Day ${s.day} · ` : ""}${shortDate(s.date)}: ${esc(s.topic?.title)}</option>`).join("");
  $("compareCard").hidden = done.length < 1;
  $("cmpA").innerHTML = opts; $("cmpB").innerHTML = opts;
  if (done.length) { $("cmpA").value = done[0].date; $("cmpB").value = done[done.length - 1].date; }
  const byDate = Object.fromEntries(done.map((s) => [s.date, s]));
  const showCmp = (sel, vid, label) => {
    const s = byDate[$(sel).value]; if (!s) return;
    const a = avgScore(s);
    $(label).textContent = `${s.day ? `Day ${s.day} · ` : ""}${shortDate(s.date)} · ${fmtClock(s.durationSec || 0)}${a != null ? ` · score ${a.toFixed(1)}` : ""}`;
    loadVideo($(vid), recUrl(s));
  };
  $("cmpA").onchange = () => showCmp("cmpA", "cmpAVid", "cmpALabel");
  $("cmpB").onchange = () => showCmp("cmpB", "cmpBVid", "cmpBLabel");
  if (done.length) { showCmp("cmpA", "cmpAVid", "cmpALabel"); showCmp("cmpB", "cmpBVid", "cmpBLabel"); }

  // history table
  $("historyBody").innerHTML = all.slice().reverse().map((s) => {
    const a = avgScore(s), f = fillersPerMin(s);
    return `<tr>
      <td class="num">${s.day ? `Day ${s.day} · ` : ""}${shortDate(s.date)}</td>
      <td>${esc(s.topic?.title)}</td>
      <td class="num">${s.durationSec ? fmtClock(s.durationSec) : "–"}</td>
      <td class="num">${a != null ? a.toFixed(1) : "–"}</td>
      <td class="num">${f != null ? f.toFixed(1) : "–"}</td>
      <td class="num">${s.metrics?.wpm ?? "–"}</td>
      <td class="fix">${esc(s.fixTomorrow || "")}</td>
      <td><a class="btn ghost" href="#day/${s.date}">Open →</a></td>
    </tr>`;
  }).join("") || `<tr><td colspan="8" class="fix">No sessions yet. Do today's.</td></tr>`;
}

// ======================= PAST DAYS =======================
const dayLabel = (s) => (s.day ? `Day ${s.day}` : s.date === session?.date ? "Today" : "Not recorded");
const longDate = (d) => new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

async function loadDays() {
  const { sessions } = await api("/api/sessions");
  const list = sessions.slice().reverse();
  $("daysList").innerHTML = list.map((s) => {
    const a = avgScore(s);
    return `<a class="day-card" href="#day/${s.date}">
      <div class="day-num">${dayLabel(s)}</div>
      <div class="day-date">${shortDate(s.date)}</div>
      <div class="day-topic">${esc(s.topic?.title)}</div>
      <div class="day-meta">${[s.recording && "🎥 Video", (s.notes || "").trim() && "📝 Notes", a != null && `⭐ ${a.toFixed(1)}`].filter(Boolean).join(" · ")}</div>
      ${s.fixTomorrow ? `<div class="day-fix"><b>To improve:</b> ${esc(s.fixTomorrow)}</div>` : ""}
    </a>`;
  }).join("") || `<p class="hint">No days yet. Today's session will show up here.</p>`;
}

async function loadDay(date) {
  const { sessions } = await api("/api/sessions");
  const idx = sessions.findIndex((x) => x.date === date);
  const s = sessions[idx];
  const box = $("dayDetail");
  if (!s) { box.innerHTML = `<p class="hint">No session for ${esc(date)}.</p>`; return; }
  const prev = sessions[idx - 1], next = sessions[idx + 1];
  const a = avgScore(s), f = fillersPerMin(s), m = s.metrics;
  const stats = [
    ["Length", s.durationSec ? fmtClock(s.durationSec) : "–"],
    ["Avg score", a != null ? a.toFixed(1) + " / 5" : "–"],
    ["Fillers / min", f != null ? f.toFixed(1) : "–"],
    ["Words / min", m?.wpm ?? "–"],
  ];
  box.innerHTML = `
    <div class="day-nav">
      <a class="link" href="#days">← All days</a>
      <span>
        ${prev ? `<a class="btn ghost" href="#day/${prev.date}">‹ ${esc(dayLabel(prev))}</a>` : ""}
        ${next ? `<a class="btn ghost" href="#day/${next.date}">${esc(dayLabel(next))} ›</a>` : ""}
      </span>
    </div>
    <div class="date-line">${esc(dayLabel(s))} · ${longDate(s.date)}</div>

    ${s.fixTomorrow ? `<div class="callout"><div class="callout-label">What I needed to improve</div><div class="callout-text">${esc(s.fixTomorrow)}</div></div>` : ""}

    <article class="card">
      <div class="card-head"><h2>Topic</h2></div>
      <div class="tag">${esc(s.topic?.category)}</div>
      <h1 class="topic-title">${esc(s.topic?.title)}</h1>
      <p class="topic-summary">${esc(s.topic?.summary)}</p>
      <h3>The talk should answer</h3>
      <ol class="questions">${(s.topic?.questions || []).map((q) => `<li>${esc(q)}</li>`).join("")}</ol>
    </article>

    <article class="card">
      <div class="card-head"><h2>My notes</h2></div>
      ${(s.notes || "").trim() ? `<pre class="notes-view">${esc(s.notes)}</pre>` : `<p class="hint">No notes this day.</p>`}
    </article>

    <article class="card">
      <div class="card-head"><h2>Recording</h2></div>
      ${s.recording ? `<div class="video-wrap review"><video id="dayVid" controls playsinline></video></div>
        <div class="hint" style="margin-top:8px">File: recordings/${esc(s.recording)}</div>` : `<p class="hint">No recording this day.</p>`}
      <div class="metrics">${stats.map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join("")}</div>
    </article>

    <article class="card">
      <div class="card-head"><h2>My review</h2></div>
      ${s.ratings ? `<div class="rubric">${RUBRIC.map((r) => `
        <div class="rubric-row"><div class="rubric-name">${r.name}<small>${r.desc}</small></div>
        <div class="scale">${[1, 2, 3, 4, 5].map((n) => `<button type="button" disabled class="${s.ratings[r.key] === n ? "on" : ""}">${n}</button>`).join("")}</div></div>`).join("")}</div>`
        : `<p class="hint">Not reviewed.</p>`}
      ${typeof s.fillerCount === "number" ? `<p>Filler words counted: <b>${s.fillerCount}</b></p>` : ""}
      ${s.transcript ? `<details class="transcript-box"><summary>Transcript</summary><p>${esc(s.transcript)}</p></details>` : ""}
    </article>`;
  if (s.recording) loadVideo($("dayVid"), recUrl(s));
  window.scrollTo(0, 0);
}

// Single-series SVG line chart with crosshair tooltip.
function addChart(title, sub, points, { yMin, yMax, fmt = String } = {}) {
  const card = document.createElement("article");
  card.className = "card chart-card";
  card.innerHTML = `<div class="chart-title">${esc(title)}</div><div class="chart-sub">${esc(sub)}</div><div class="chart"></div>`;
  $("charts").appendChild(card);
  const box = card.querySelector(".chart");
  const W = 460, H = 190, L = 40, R = 14, T = 12, B = 26;
  if (points.length === 0) {
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">No data yet. Finish a session to see this.</text></svg>`;
    return;
  }
  const vals = points.map((p) => p.value);
  let lo = yMin ?? Math.min(...vals), hi = yMax ?? Math.max(...vals);
  if (yMin == null) lo = Math.floor(lo * 0.9);
  if (yMax == null) hi = Math.ceil(hi * 1.1);
  if (hi === lo) hi = lo + 1;
  const x = (i) => (points.length === 1 ? L + (W - L - R) / 2 : L + (i / (points.length - 1)) * (W - L - R));
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = [0, 0.5, 1].map((f) => lo + f * (hi - lo));
  const grid = ticks.map((t) => `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${+t.toFixed(1)}</text>`).join("");
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const showDots = points.length <= 30;
  const dots = showDots ? points.map((p, i) => `<circle class="dot" cx="${x(i)}" cy="${y(p.value)}" r="4"/>`).join("") : "";
  const xl = [`<text x="${x(0)}" y="${H - 6}" text-anchor="${points.length === 1 ? "middle" : "start"}">${shortDate(points[0].date)}</text>`];
  if (points.length > 1) xl.push(`<text x="${x(points.length - 1)}" y="${H - 6}" text-anchor="end">${shortDate(points[points.length - 1].date)}</text>`);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
    <g class="axis">${grid}${xl.join("")}</g>
    <path class="line" d="${path}"/>
    ${dots}
    <line class="cross" y1="${T}" y2="${H - B}" visibility="hidden"/>
    <circle class="dot hover" r="5" visibility="hidden"/>
    <rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/>
  </svg><div class="tooltip" hidden></div>`;
  const svg = box.querySelector("svg"), cross = svg.querySelector(".cross"), hd = svg.querySelector(".hover"), tip = box.querySelector(".tooltip");
  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let i = points.length === 1 ? 0 : Math.round(((px - L) / (W - L - R)) * (points.length - 1));
    i = Math.max(0, Math.min(points.length - 1, i));
    const p = points[i];
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    hd.setAttribute("cx", x(i)); hd.setAttribute("cy", y(p.value)); hd.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.innerHTML = `${shortDate(p.date)} · <b>${esc(fmt(p.value))}</b>`;
    tip.style.left = (x(i) / W) * r.width + "px";
    tip.style.top = (y(p.value) / H) * r.height + "px";
  });
  svg.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hd.setAttribute("visibility", "hidden"); tip.hidden = true; });
}

// ======================= ROUTING =======================
function route() {
  const h = location.hash;
  const view = h === "#progress" ? "progress" : h === "#days" ? "days" : h.startsWith("#day/") ? "day" : "today";
  for (const v of ["today", "progress", "days", "day"]) $("view-" + v).hidden = v !== view;
  const navKey = view === "day" ? "days" : view;
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === navKey));
  document.querySelectorAll("video").forEach((v) => { if (!v.closest(".view:not([hidden])") && v.id !== "preview") v.pause(); });
  if (view === "progress") loadProgress().catch(console.error);
  if (view === "days") loadDays().catch(console.error);
  if (view === "day") loadDay(decodeURIComponent(h.slice(5))).catch(console.error);
}
window.addEventListener("hashchange", route);

loadToday().catch((e) => { $("topicTitle").textContent = "Couldn't reach the server. Run `npm start`."; console.error(e); });
refreshStreak().catch(() => {});
route();
