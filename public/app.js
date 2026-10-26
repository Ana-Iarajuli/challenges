"use strict";

const MIKIRI_API = "https://challenges-api.mikiri.ge/api";
const STATE_API = "/api/state";
const KEY_STORAGE = "mikiri-medals-key";
const POLL_MS = 20000;

const $ = (id) => document.getElementById(id);

const app = {
  key: null,
  challenges: [],
  challenge: null,
  entries: [],          // normalized leaderboard rows for the current challenge
  saved: { medalsTotal: null, entries: {} },
  filter: "all",
  query: "",
  expanded: new Set(),
  pending: 0,           // in-flight writes; polling waits for them
};

// ---------- helpers ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function storage(fn) {
  try { return fn(localStorage); } catch { return null; }
}

function parseDuration(s) {
  const m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)/.exec(s || "");
  return m ? (+m[1] || 0) * 86400 + +m[2] * 3600 + +m[3] * 60 + +m[4] : 0;
}

const GOALS = {
  Distance: { value: (e) => e.totalDistanceInMeters || 0, target: (c) => c.targetDistanceInMeters, fmt: (v) => `${(v / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km` },
  Elevation: { value: (e) => e.totalElevationInMeters || 0, target: (c) => c.targetElevationInMeters, fmt: (v) => `${Math.round(v).toLocaleString()} m` },
  Sessions: { value: (e) => e.totalSessions || 0, target: (c) => c.targetSessions, fmt: (v) => `${v} sessions` },
  Duration: { value: (e) => parseDuration(e.totalDuration), target: (c) => parseDuration(c.targetDuration), fmt: (v) => `${(v / 3600).toFixed(1)} h` },
};
const goalOf = (c) => GOALS[c.goalType] || GOALS.Distance;

function personName(u) {
  const strava = [u.stravaFirstName, u.stravaLastName].filter(Boolean).join(" ");
  const name = u.userName && !u.userName.includes("@") ? u.userName : strava || u.userName || "Unknown";
  return { name, strava: strava && strava !== name ? strava : "" };
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function fmtWhen(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
}

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("err", isError);
}

// ---------- network ----------

async function stateRequest(method, { query = "", body } = {}) {
  const res = await fetch(STATE_API + query, {
    method,
    headers: { "x-admin-key": app.key, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { logout("Session expired, please sign in again."); throw new Error("Unauthorized"); }
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

async function mikiri(path) {
  const res = await fetch(MIKIRI_API + path);
  if (!res.ok) throw new Error(`Mikiri API ${res.status}`);
  return res.json();
}

// ---------- auth ----------

async function login(key) {
  app.key = key;
  const res = await fetch(STATE_API, { headers: { "x-admin-key": key } }).catch(() => null);
  if (!res) throw new Error("Can't reach the server. Is the site deployed on Netlify?");
  if (res.status === 401) throw new Error("Wrong password");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Server error ${res.status}`);
  }
  storage((s) => s.setItem(KEY_STORAGE, key));
  $("login").hidden = true;
  $("app").hidden = false;
  $("logout").hidden = false;
  await loadChallenges();
}

function logout(message = "") {
  storage((s) => s.removeItem(KEY_STORAGE));
  app.key = null;
  $("app").hidden = true;
  $("logout").hidden = true;
  $("login").hidden = false;
  $("login-error").textContent = message;
  $("password").value = "";
  $("password").focus();
}

// ---------- data loading ----------

async function loadChallenges() {
  setStatus("Loading challenges…");
  const list = await mikiri("/challenge");
  app.challenges = list.sort((a, b) => b.startDateUtc.localeCompare(a.startDateUtc));
  const remembered = storage((s) => s.getItem("mikiri-medals-challenge"));
  const first = app.challenges.find((c) => c.id === remembered) || app.challenges[0];
  renderTabs();
  if (first) await selectChallenge(first.id);
  else setStatus("No challenges found.");
}

async function selectChallenge(id) {
  app.challenge = app.challenges.find((c) => c.id === id);
  app.entries = [];
  app.saved = { medalsTotal: null, entries: {} };
  app.expanded.clear();
  storage((s) => s.setItem("mikiri-medals-challenge", id));
  renderTabs();
  renderHead();
  render();
  await refresh();
}

async function refresh() {
  const c = app.challenge;
  if (!c) return;
  setStatus("Loading leaderboard…");
  try {
    const isTeam = c.mode === "Team";
    const [board, saved] = await Promise.all([
      mikiri(`/user/challenges/${isTeam ? "team-leaderboard" : "leaderboard"}?challengeId=${encodeURIComponent(c.id)}`),
      stateRequest("GET", { query: `?challengeId=${encodeURIComponent(c.id)}` }),
    ]);
    if (app.challenge !== c) return; // user switched tabs meanwhile
    app.entries = normalize(board, c);
    app.saved = saved;
    render();
    setStatus(`Updated ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    setStatus(`Couldn't load: ${err.message}`, true);
  }
}

async function pollSaved() {
  const c = app.challenge;
  if (!c || !app.key || app.pending || document.hidden) return;
  try {
    const saved = await stateRequest("GET", { query: `?challengeId=${encodeURIComponent(c.id)}` });
    if (app.challenge === c && !app.pending) { app.saved = saved; render(); }
  } catch { /* next poll will retry */ }
}

function normalize(board, c) {
  const goal = goalOf(c);
  const target = goal.target(c) || 0;
  const rows = board.map((r) => {
    if (r.teamId) {
      const members = (r.members || []).map((m) => ({
        id: m.userId, ...personName(m), email: m.email, pic: m.profilePictureThumbnailUrl, value: goal.value(m),
      })).sort((a, b) => b.value - a.value);
      return {
        id: r.teamId, team: true, name: r.teamName || r.teamNameGeo || "Team", strava: "",
        email: "", pic: r.profilePictureThumbnailUrl, value: goal.value(r), members,
      };
    }
    return { id: r.userId, team: false, ...personName(r), email: r.email, pic: r.profilePictureThumbnailUrl, value: goal.value(r), members: [] };
  });
  rows.sort((a, b) => b.value - a.value);
  rows.forEach((r, i) => {
    r.rank = i + 1;
    r.finished = target > 0 && r.value >= target;
    r.pct = target > 0 ? Math.min(100, (r.value / target) * 100) : 0;
  });
  return rows;
}

// ---------- state changes ----------

async function save(body, applyLocal) {
  const before = structuredClone(app.saved);
  applyLocal();
  render();
  app.pending++;
  try {
    app.saved = await stateRequest("POST", { body: { challengeId: app.challenge.id, ...body } });
    setStatus(`Saved ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    app.saved = before;
    setStatus(`Not saved: ${err.message}`, true);
  } finally {
    app.pending--;
    render();
  }
}

function toggle(ids, field, value) {
  return save({ op: "entry", ids, field, value }, () => {
    for (const id of ids) {
      const e = (app.saved.entries[id] = { ...app.saved.entries[id] });
      e[field] = value;
      e[field + "At"] = new Date().toISOString();
    }
  });
}

function setMedalsTotal(value) {
  return save({ op: "medalsTotal", value }, () => { app.saved.medalsTotal = value; });
}

// ---------- rendering ----------

const flagOf = (id) => !!app.saved.entries[id]?.flag;
const medalOf = (id) => !!app.saved.entries[id]?.medal;
const teamFlagged = (r) => flagOf(r.id) || r.members.some((m) => flagOf(m.id));
// Each team member collects their own medal; a team without a member list is treated as one person.
const medalHolders = (r) => (r.team && r.members.length ? r.members : [r]);
const medalsTaken = (r) => medalHolders(r).filter((p) => medalOf(p.id)).length;
const medalsLeft = (r) => medalHolders(r).length - medalsTaken(r);

const FILTERS = [
  ["all", "All", () => true],
  ["finished", "Finished", (r) => r.finished],
  ["waiting", "Waiting for medal", (r) => r.finished && medalsLeft(r) > 0 && !teamFlagged(r)],
  ["taken", "Medal taken", (r) => medalsLeft(r) === 0],
  ["flagged", "Flagged", (r) => teamFlagged(r)],
];

function renderTabs() {
  $("challenges").innerHTML = app.challenges.map((c) =>
    `<button class="tab" role="tab" data-id="${esc(c.id)}" aria-selected="${c === app.challenge}">${esc(c.name)}</button>`
  ).join("");
}

function renderHead() {
  const c = app.challenge;
  const img = (c.attachments || []).find((a) => a.type === 1) || (c.attachments || [])[0];
  const goal = goalOf(c);
  $("challenge-head").innerHTML = `
    ${img ? `<img src="${esc(img.url)}" alt="">` : ""}
    <div>
      <h1>${esc(c.name)}</h1>
      <p>${esc(c.mode)} · ${esc(c.discipline || "")} · goal ${esc(goal.fmt(goal.target(c) || 0))} · ${fmtDate(c.startDateUtc)} – ${fmtDate(c.endDateUtc)}</p>
    </div>`;
}

function avatar(pic, name) {
  return pic
    ? `<img class="avatar" src="${esc(pic)}" alt="" loading="lazy">`
    : `<span class="avatar">${esc((name || "?").trim().charAt(0).toUpperCase())}</span>`;
}

function checkbox(id, field, label) {
  const entry = app.saved.entries[id] || {};
  const on = !!entry[field];
  return `<label class="check ${field}" title="${esc(label)}">
      <input type="checkbox" data-ids="${esc(id)}" data-field="${field}" ${on ? "checked" : ""} aria-label="${esc(label)}">
    </label>${on ? `<span class="when">${fmtWhen(entry[field + "At"])}</span>` : ""}`;
}

// Team row: ticks/unticks every member at once; half-filled when only some have collected.
function teamMedalCheckbox(r) {
  const taken = medalsTaken(r);
  const total = r.members.length;
  const label = `Medals taken by all of ${r.name}`;
  return `<label class="check medal" title="${esc(label)}">
      <input type="checkbox" data-ids="${esc(r.members.map((m) => m.id).join(","))}" data-field="medal"
        ${taken === total ? "checked" : ""} ${taken > 0 && taken < total ? "data-indeterminate" : ""} aria-label="${esc(label)}">
    </label><span class="when">${taken}/${total}</span>`;
}

function progress(r, goal) {
  return `<div class="progress">
      <div class="progress-top"><b>${esc(goal.fmt(r.value))}</b><span>${Math.floor(r.pct)}%</span></div>
      <div class="bar ${r.finished ? "done" : ""}"><i style="width:${r.pct.toFixed(1)}%"></i></div>
    </div>`;
}

function rowHtml(r, goal) {
  const flagged = teamFlagged(r);
  const sub = r.team
    ? `${r.members.length} member${r.members.length === 1 ? "" : "s"} · <button class="expand" data-expand="${esc(r.id)}">${app.expanded.has(r.id) ? "hide" : "show"} members</button>`
    : [r.strava, r.email].filter(Boolean).map(esc).join(" · ");
  const teamMedals = r.team && r.members.length;
  let html = `<tr class="${flagged ? "flagged" : ""} ${medalsLeft(r) === 0 ? "taken" : ""}">
    <td class="c-rank">${r.rank}</td>
    <td><div class="who">${avatar(r.pic, r.name)}<div class="who-text">
      <div class="name">${esc(r.name)}
        ${r.finished ? `<span class="badge done">Finished</span>` : ""}
        ${flagged ? `<span class="badge flag">Flagged</span>` : ""}
      </div>
      <div class="sub">${sub}</div>
    </div></div></td>
    <td class="c-progress">${progress(r, goal)}</td>
    <td class="c-check"><span class="check-label">${teamMedals ? "Medals" : "Medal"}</span>${teamMedals ? teamMedalCheckbox(r) : checkbox(r.id, "medal", `Medal taken by ${r.name}`)}</td>
    <td class="c-check"><span class="check-label">Cheat</span>${checkbox(r.id, "flag", `Flag ${r.name} as cheating candidate`)}</td>
  </tr>`;
  if (r.team && app.expanded.has(r.id)) {
    html += r.members.map((m) => `<tr class="member ${flagOf(m.id) ? "flagged" : ""} ${medalOf(m.id) ? "taken" : ""}">
      <td class="c-rank"></td>
      <td><div class="who">${avatar(m.pic, m.name)}<div class="who-text">
        <div class="name">${esc(m.name)}</div>
        <div class="sub">${[m.strava, m.email].filter(Boolean).map(esc).join(" · ")}</div>
      </div></div></td>
      <td class="c-progress"><div class="progress-top"><b>${esc(goal.fmt(m.value))}</b></div></td>
      <td class="c-check"><span class="check-label">Medal</span>${checkbox(m.id, "medal", `Medal taken by ${m.name}`)}</td>
      <td class="c-check"><span class="check-label">Cheat</span>${checkbox(m.id, "flag", `Flag ${m.name} as cheating candidate`)}</td>
    </tr>`).join("");
  }
  return html;
}

function render() {
  const c = app.challenge;
  if (!c) return;
  const goal = goalOf(c);

  // stats
  const total = app.saved.medalsTotal;
  const given = app.entries.reduce((n, r) => n + medalsTaken(r), 0);
  const waiting = app.entries.filter(FILTERS[2][2]);
  const flagged = app.entries.filter((r) => teamFlagged(r)).length;
  const input = $("medals-total");
  if (document.activeElement !== input) input.value = total ?? "";
  $("s-given").textContent = given;
  $("s-left").textContent = total == null ? "–" : total - given;
  $("s-left").classList.toggle("neg", total != null && total - given < 0);
  $("s-pending").textContent = waiting.reduce((n, r) => n + medalsLeft(r), 0);
  $("s-flagged").textContent = flagged;

  // filters
  $("filters").innerHTML = FILTERS.map(([key, label, fn]) =>
    `<button class="chip" data-filter="${key}" aria-pressed="${app.filter === key}">${label}<span class="n">${app.entries.filter(fn).length}</span></button>`
  ).join("");

  // rows
  const match = FILTERS.find(([k]) => k === app.filter)[2];
  const q = app.query.trim().toLowerCase();
  const hit = (p) => [p.name, p.strava, p.email].some((s) => s && s.toLowerCase().includes(q));
  const rows = app.entries.filter((r) => match(r) && (!q || hit(r) || r.members.some(hit)));
  if (q) rows.forEach((r) => { if (!hit(r) && r.members.some(hit)) app.expanded.add(r.id); });

  $("rows").innerHTML = rows.length
    ? rows.map((r) => rowHtml(r, goal)).join("")
    : `<tr><td colspan="5" class="empty">${app.entries.length ? "Nobody matches this filter." : "No participants yet."}</td></tr>`;
  $("rows").querySelectorAll("[data-indeterminate]").forEach((box) => { box.indeterminate = true; });
}

function exportCsv() {
  const c = app.challenge;
  const goal = goalOf(c);
  const lines = [["Rank", "Type", "Name", "Strava", "Email", "Team", "Result", "Finished", "Medal taken", "Medal taken at", "Flagged", "Flagged at"]];
  const add = (p, type, team, rank, finished, medal) => {
    const e = app.saved.entries[p.id] || {};
    lines.push([rank, type, p.name, p.strava, p.email, team, goal.fmt(p.value), finished, medal ?? (e.medal ? "yes" : ""), e.medalAt || "", e.flag ? "yes" : "", e.flagAt || ""]);
  };
  for (const r of app.entries) {
    const teamMedals = r.team && r.members.length ? `${medalsTaken(r)}/${r.members.length}` : undefined;
    add(r, r.team ? "team" : "individual", "", r.rank, r.finished ? "yes" : "", teamMedals);
    for (const m of r.members) add(m, "member", r.name, "", "");
  }
  const csv = lines.map((l) => l.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = `${c.name.replace(/[^\w-]+/g, "_")}-medals.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- events ----------

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  try { await login($("password").value); }
  catch (err) { $("login-error").textContent = err.message; }
});

$("logout").addEventListener("click", () => logout());

$("challenges").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab && tab.dataset.id !== app.challenge?.id) selectChallenge(tab.dataset.id);
});

$("filters").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) { app.filter = chip.dataset.filter; render(); }
});

$("search").addEventListener("input", (e) => { app.query = e.target.value; render(); });

$("rows").addEventListener("change", (e) => {
  const box = e.target;
  if (box.matches("input[type=checkbox]")) toggle(box.dataset.ids.split(","), box.dataset.field, box.checked);
});

$("rows").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-expand]");
  if (!btn) return;
  const id = btn.dataset.expand;
  app.expanded.has(id) ? app.expanded.delete(id) : app.expanded.add(id);
  render();
});

$("medals-total").addEventListener("change", (e) => {
  const raw = e.target.value.trim();
  const value = raw === "" ? null : Math.max(0, Math.floor(Number(raw)));
  if (raw !== "" && !Number.isFinite(value)) return;
  setMedalsTotal(value);
});

$("refresh").addEventListener("click", refresh);
$("export").addEventListener("click", exportCsv);

setInterval(pollSaved, POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) pollSaved(); });

// ---------- start ----------

const savedKey = storage((s) => s.getItem(KEY_STORAGE));
if (savedKey) {
  login(savedKey).catch((err) => logout(err.message === "Wrong password" ? "" : err.message));
} else {
  logout();
}
