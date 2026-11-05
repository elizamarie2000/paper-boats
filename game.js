// Paper Boats: two players hide boats on a typed page and take turns hunting each other's.
// The computers talk directly over PeerJS. Each player's boats stay on their own computer,
// and all that crosses the wire is the shot and its answer.
const N = 9;
const PREFIX = "paperboats-v1-";
const WORDS = ["PEN", "INK", "DOODLE", "BOAT", "PAPER", "SKETCH", "CHALK", "NOTE", "CRAYON", "TIDE"];
const FLEET = [
  { id: "barge", name: "Steamer", len: 4 },
  { id: "skiff", name: "Sailboat", len: 3 },
  { id: "punt", name: "Tugboat", len: 3 },
  { id: "dinghy", name: "Canoe", len: 2 },
  { id: "paper", name: "Paper boat", len: 2 },
];
const TOTAL = FLEET.reduce((n, b) => n + b.len, 0);
const $ = id => document.getElementById(id);
const key = (x, y) => x + "," + y;
const label = (x, y) => "ABCDEFGHI"[x] + (y + 1);
const inGrid = v => Number.isInteger(v) && v >= 0 && v < N;
const blank = () => Array.from({ length: N }, () => Array(N).fill(null));

const S = {
  me: "", foe: "Your friend", host: false, code: "", started: false, over: false, turn: null,
  boats: [], sel: "barge", dir: "h", hover: null, iReady: false, foeReady: false,
  myShots: blank(), foeShots: blank(), foeSunk: [], foeReveal: [], pending: null,
  iAgain: false, foeAgain: false, fresh: null, status: "",
};
let peer = null, conn = null, retry = null, leaving = false;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- connection ----------
function bind(c) {
  conn = c;
  c.on("open", () => {
    clearTimeout(retry);
    send({ t: "hello", name: S.me });
    if (S.iReady && !S.started) send({ t: "ready" });
    if (S.pending) send({ t: "shot", ...S.pending });
    showConn();
  });
  c.on("data", onMessage);
  c.on("close", dropped);
  c.on("error", dropped);
}

function dropped() {
  if (leaving) return;
  conn = null;
  showConn();
  if (S.started && !S.over) setStatus("Your friend has dropped out. Hold on, trying to reconnect…", "lost");
  if (!S.host) { clearTimeout(retry); retry = setTimeout(connectToHost, 3000); }
}

function connectToHost() {
  if (leaving || (conn && conn.open) || !peer || peer.destroyed) return;
  bind(peer.connect(PREFIX + S.code, { reliable: true, serialization: "json" }));
  clearTimeout(retry);
  retry = setTimeout(() => { if (!conn || !conn.open) connectToHost(); }, 6000);
}

const send = m => { if (conn && conn.open) conn.send(m); };

function hostRoom() {
  S.host = true;
  S.code = WORDS[Math.floor(Math.random() * WORDS.length)] + "-" + (10 + Math.floor(Math.random() * 90));
  peer = new Peer(PREFIX + S.code);
  peer.on("open", () => {
    $("codeOut").textContent = S.code;
    show("wait");
  });
  peer.on("connection", c => {
    if (conn && conn.open) { c.on("open", () => { c.send({ t: "full" }); setTimeout(() => c.close(), 300); }); return; }
    bind(c);
  });
  peer.on("disconnected", () => { if (!leaving && !peer.destroyed) peer.reconnect(); });
  peer.on("error", e => {
    if (e.type === "unavailable-id") { peer.destroy(); hostRoom(); }
    else if (e.type !== "peer-unavailable" && !S.started) homeError("Couldn't connect. Check your internet and try again.");
  });
}

function joinRoom(code) {
  S.host = false;
  S.code = code;
  $("waitTitle").textContent = "Joining…";
  $("codeOut").textContent = code;
  $("waitNote").textContent = "Looking for your friend's room…";
  $("copyBtn").hidden = true;
  show("wait");
  peer = new Peer();
  peer.on("open", connectToHost);
  peer.on("disconnected", () => { if (!leaving && !peer.destroyed) peer.reconnect(); });
  peer.on("error", e => {
    if (e.type === "peer-unavailable") {
      if (S.started) return;
      clearTimeout(retry);
      homeError("No room with that code. Check it with your friend.");
    } else if (!S.started) homeError("Couldn't connect. Check your internet and try again.");
  });
}

function leave() {
  leaving = true;
  clearTimeout(retry);
  if (peer) peer.destroy();
  location.href = location.pathname;
}

function homeError(text) {
  clearTimeout(retry);
  if (peer) { leaving = true; peer.destroy(); leaving = false; peer = null; }
  conn = null;
  $("homeErr").textContent = text;
  show("home");
}

// ---------- messages from the other player ----------
function onMessage(m) {
  if (!m || typeof m !== "object") return;
  if (m.t === "hello") {
    S.foe = String(m.name || "").trim().slice(0, 16) || "Your friend";
    $("foeName").textContent = S.foe + "’s page";
    if ($("wait").classList.contains("on")) { resetRound(); show("place"); }
    if (S.started && !S.over) refreshStatus();
    showConn();
  } else if (m.t === "full") {
    homeError("That room already has two players.");
  } else if (m.t === "ready") {
    S.foeReady = true;
    tryStart();
    renderPlace();
  } else if (m.t === "start" && !S.host && !S.started) {
    begin(m.first === "guest" ? "me" : "foe");
  } else if (m.t === "shot" && inGrid(m.x) && inGrid(m.y)) {
    answerShot(m.x, m.y);
  } else if (m.t === "result" && inGrid(m.x) && inGrid(m.y)) {
    takeResult(m);
  } else if (m.t === "reveal" && Array.isArray(m.boats)) {
    S.foeReveal = m.boats.filter(validBoat).slice(0, FLEET.length);
    renderPlay();
  } else if (m.t === "again") {
    S.foeAgain = true;
    tryAgain();
  }
}

const validBoat = b => b && inGrid(b.x) && inGrid(b.y) && Number.isInteger(b.len) && b.len > 1 && b.len <= 4 && (b.dir === "h" || b.dir === "v");

function tryStart() {
  if (!S.host || S.started || !S.iReady || !S.foeReady) return;
  const guestFirst = Math.random() < 0.5;
  send({ t: "start", first: guestFirst ? "guest" : "host" });
  begin(guestFirst ? "foe" : "me");
}

function begin(turn) {
  S.started = true;
  S.turn = turn;
  chime([392, 523]);
  show("play");
  refreshStatus();
  renderPlay();
}

function answerShot(x, y) {
  const seen = S.foeShots[y][x];
  if (!seen && S.turn !== "foe") return;
  const boat = S.boats.find(b => cells(b).some(c => c.x === x && c.y === y));
  S.foeShots[y][x] = boat ? "hit" : "miss";
  const sunk = boat && cells(boat).every(c => S.foeShots[c.y][c.x]);
  const won = hitCount(S.foeShots) === TOTAL;
  send({ t: "result", x, y, hit: !!boat, sunk: sunk ? { x: boat.x, y: boat.y, len: boat.len, dir: boat.dir, name: boat.name } : null, won });
  if (seen) return;
  S.fresh = key(x, y);
  if (won) return finish(false, boat);
  S.turn = "me";
  boat ? chime([294, 220]) : ripple();
  say(boat ? (sunk ? `${S.foe} sank your ${boat.name}.` : `${S.foe} hit you at ${label(x, y)}.`) : `${S.foe} missed at ${label(x, y)}.`);
  renderPlay();
  nudge();
}

function takeResult(m) {
  if (!S.pending || S.pending.x !== m.x || S.pending.y !== m.y) return;
  S.pending = null;
  S.myShots[m.y][m.x] = m.hit ? "hit" : "miss";
  S.fresh = key(m.x, m.y);
  if (m.sunk && validBoat(m.sunk)) S.foeSunk.push({ ...m.sunk, name: String(m.sunk.name).slice(0, 20) });
  if (m.won) {
    send({ t: "reveal", boats: S.boats.map(({ x, y, len, dir }) => ({ x, y, len, dir })) });
    return finish(true);
  }
  S.turn = "foe";
  m.hit ? chime(m.sunk ? [523, 659, 784] : [523, 784]) : ripple();
  say(m.hit ? (m.sunk ? `You sank the ${S.foeSunk[S.foeSunk.length - 1].name}!` : `Hit at ${label(m.x, m.y)}!`) : `Miss at ${label(m.x, m.y)}.`);
  renderPlay();
}

function finish(iWon) {
  S.over = true;
  S.turn = null;
  iWon ? chime([523, 659, 784, 1047]) : chime([392, 330, 262]);
  $("endTitle").textContent = iWon ? "You sank them all!" : `${S.foe} sank them all`;
  $("endNote").textContent = iWon ? `Every one of ${S.foe}’s boats has been found.` : "Good game! Fancy another round?";
  $("againBtn").disabled = false;
  $("againBtn").textContent = "Play again";
  setStatus(iWon ? "You won!" : `${S.foe} won this one.`);
  $("end").classList.add("on");
  renderPlay();
}

function tryAgain() {
  if (S.iAgain && S.foeAgain) { resetRound(); show("place"); }
  else if (S.foeAgain) $("endNote").textContent = `${S.foe} would like another round.`;
}

function resetRound() {
  Object.assign(S, {
    started: false, over: false, turn: null, boats: [], sel: "barge", dir: "h", iReady: false, foeReady: false,
    myShots: blank(), foeShots: blank(), foeSunk: [], foeReveal: [], pending: null, iAgain: false, foeAgain: false, fresh: null,
  });
  $("end").classList.remove("on");
  renderPlace();
}

// ---------- hiding boats ----------
function cells({ x, y, len, dir }) {
  return Array.from({ length: len }, (_, i) => dir === "h" ? { x: x + i, y } : { x, y: y + i });
}

function fits(b, others) {
  const taken = new Set(others.flatMap(o => cells(o).map(c => key(c.x, c.y))));
  return cells(b).every(c => inGrid(c.x) && inGrid(c.y) && !taken.has(key(c.x, c.y)));
}

function placeAt(x, y) {
  const here = S.boats.find(b => cells(b).some(c => c.x === x && c.y === y));
  const spec = FLEET.find(f => f.id === S.sel);
  if (here && (!spec || here.id !== spec.id)) { pickUp(here); return; }
  if (!spec) return;
  const others = S.boats.filter(b => b.id !== spec.id);
  const boat = { ...spec, x, y, dir: S.dir };
  if (!fits(boat, others)) return;
  S.boats = [...others, boat];
  S.sel = (FLEET.find(f => !S.boats.some(b => b.id === f.id)) || {}).id || null;
  S.hover = null;
  renderPlace();
}

function pickUp(boat) {
  S.boats = S.boats.filter(b => b !== boat);
  S.sel = boat.id;
  S.dir = boat.dir;
  renderPlace();
}

function scatter() {
  S.boats = [];
  for (const spec of FLEET) {
    let boat;
    do {
      const dir = Math.random() < 0.5 ? "h" : "v";
      boat = { ...spec, dir, x: Math.floor(Math.random() * N), y: Math.floor(Math.random() * N) };
    } while (!fits(boat, S.boats));
    S.boats.push(boat);
  }
  S.sel = null;
  renderPlace();
}

function turnBoat() {
  S.dir = S.dir === "h" ? "v" : "h";
  const placed = !FLEET.some(f => f.id === S.sel) && S.boats[S.boats.length - 1];
  if (placed) {
    const turned = { ...placed, dir: S.dir };
    if (fits(turned, S.boats.filter(b => b !== placed))) S.boats = S.boats.map(b => b === placed ? turned : b);
  }
  renderPlace();
}

function renderPlace() {
  const board = $("placeBoard");
  if (!board.childElementCount) {
    buildCells(board, "Place a boat at ", placeAt);
    board.addEventListener("mouseleave", () => { S.hover = null; paintPreview(); });
  }
  board.querySelectorAll(".boat").forEach(e => e.remove());
  S.boats.forEach(b => board.append(boatEl(b)));
  paintPreview();
  $("tray").replaceChildren(...FLEET.map(f => {
    const btn = document.createElement("button");
    const placed = S.boats.some(b => b.id === f.id);
    btn.className = (S.sel === f.id ? "sel " : "") + (placed ? "done" : "");
    btn.disabled = S.iReady;
    const name = document.createElement("span");
    name.textContent = f.name;
    const pips = document.createElement("span");
    pips.className = "pips";
    pips.append(...Array.from({ length: f.len }, () => document.createElement("i")));
    btn.append(name, pips);
    btn.onclick = () => { const b = S.boats.find(x => x.id === f.id); b ? pickUp(b) : (S.sel = f.id, renderPlace()); };
    return btn;
  }));
  const all = S.boats.length === FLEET.length;
  $("readyBtn").disabled = !all || S.iReady;
  $("readyBtn").textContent = S.iReady ? "Ready" : all ? "Ready" : `${FLEET.length - S.boats.length} left to hide`;
  $("turnBtn").disabled = $("scatterBtn").disabled = S.iReady;
  board.querySelectorAll(".cell").forEach(c => { c.disabled = S.iReady; });
  $("placeNote").textContent = S.iReady ? `Waiting for ${S.foe} to finish hiding…` : S.foeReady ? `${S.foe} is ready and waiting.` : "Pick a boat, then tap the grid. Tap a placed boat to move it.";
}

function paintPreview() {
  const cellsEls = $("placeBoard").querySelectorAll(".cell");
  cellsEls.forEach(c => c.classList.remove("preview", "bad"));
  const spec = FLEET.find(f => f.id === S.sel);
  if (!S.hover || !spec) return;
  const boat = { ...spec, ...S.hover, dir: S.dir };
  const ok = fits(boat, S.boats.filter(b => b.id !== spec.id));
  cells(boat).forEach(c => { if (inGrid(c.x) && inGrid(c.y)) cellsEls[c.y * N + c.x].classList.add(ok ? "preview" : "bad"); });
}

// ---------- drawing ----------
function tag(kind, text) {
  const t = document.createElement("span");
  t.className = "tag " + kind;
  t.textContent = text;
  return t;
}

function buildCells(board, verb, click) {
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const c = document.createElement("button");
    c.className = "cell";
    c.dataset.x = x;
    c.dataset.y = y;
    c.setAttribute("aria-label", verb + label(x, y));
    if (y === 0) c.append(tag("col", "ABCDEFGHI"[x]));
    if (x === 0) c.append(tag("row", y + 1));
    if (click) {
      c.onclick = () => click(x, y);
      c.onmouseenter = () => { if (board.id === "placeBoard") { S.hover = { x, y }; paintPreview(); } };
    } else c.disabled = true;
    board.append(c);
  }
}

function boatEl(b, extra = "") {
  const e = document.createElement("div");
  e.className = `boat ${b.dir === "v" ? "tall" : ""} ${extra}`;
  e.style.setProperty("--x", b.x);
  e.style.setProperty("--y", b.y);
  e.style.setProperty("--w", b.dir === "h" ? b.len : 1);
  e.style.setProperty("--h", b.dir === "h" ? 1 : b.len);
  return e;
}

const hitCount = grid => grid.flat().filter(v => v === "hit").length;

function paintShots(board, grid, canFire) {
  board.querySelectorAll(".cell").forEach(c => {
    const x = +c.dataset.x, y = +c.dataset.y, v = grid[y][x];
    c.className = "cell" + (v ? " " + v : "") + (v && S.fresh === key(x, y) ? " new" : "");
    if (board.id === "foeBoard") c.disabled = !canFire || !!v;
  });
}

function renderPlay() {
  const foe = $("foeBoard"), mine = $("myBoard");
  if (!foe.childElementCount) { buildCells(foe, "Aim at ", fire); buildCells(mine, "Your page, "); }
  [foe, mine].forEach(b => b.querySelectorAll(".boat").forEach(e => e.remove()));
  S.boats.forEach(b => mine.append(boatEl(b, cells(b).every(c => S.foeShots[c.y][c.x]) ? "sunk" : "")));
  S.foeSunk.forEach(b => foe.append(boatEl(b, "sunk")));
  S.foeReveal.filter(b => !S.foeSunk.some(s => s.x === b.x && s.y === b.y)).forEach(b => foe.append(boatEl(b, "ghost")));
  const canFire = S.turn === "me" && !S.pending;
  paintShots(foe, S.myShots, canFire);
  paintShots(mine, S.foeShots, false);
  foe.classList.toggle("live", canFire);
  mine.classList.toggle("live", S.turn === "foe");
  const hiding = FLEET.length - S.foeSunk.length;
  $("foeLeft").textContent = `${hiding} ${hiding === 1 ? "boat" : "boats"} to find`;
  $("myLeft").textContent = `${S.boats.filter(b => !cells(b).every(c => S.foeShots[c.y][c.x])).length} still afloat`;
}

function fire(x, y) {
  if (S.turn !== "me" || S.pending || S.myShots[y][x] || !conn || !conn.open) return;
  S.pending = { x, y };
  send({ t: "shot", x, y });
  renderPlay();
}

let typing = null;
const stillMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function setStatus(text, kind = "") {
  const el = $("status");
  S.status = text;
  el.className = "status " + kind;
  clearTimeout(typing);
  if (stillMotion || document.hidden) { el.textContent = text; return; }
  let n = 0;
  (function type() {
    el.textContent = text.slice(0, ++n);
    if (n < text.length) typing = setTimeout(type, 16);
  })();
}

const turnLine = () => S.turn === "me" ? "Your turn. Pick a square." : `${S.foe} is picking a square…`;

function refreshStatus() {
  if (!S.over) setStatus(turnLine(), S.turn === "me" ? "mine" : "");
}

function say(text) {
  setStatus(text + " " + turnLine(), S.turn === "me" ? "mine" : "");
}

function nudge() {
  if (document.hidden) document.title = "Your turn! Paper Boats";
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = "Paper Boats"; });

function showConn() {
  const on = conn && conn.open;
  document.querySelectorAll("[data-conn]").forEach(e => {
    const dot = document.createElement("i");
    dot.className = "dot" + (on ? "" : " off");
    e.replaceChildren(dot, on ? `With ${S.foe}` : "Reconnecting…");
  });
}

function show(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("on", s.id === id));
  document.body.dataset.screen = id;
  window.scrollTo(0, 0);
}

// ---------- sound ----------
let audio = null, muted = store.get("paperboats-muted") === "1";
function note(freq, at, length, level, shape = "sine") {
  if (muted) return;
  audio = audio || new (window.AudioContext || window.webkitAudioContext)();
  audio.resume();
  const osc = audio.createOscillator(), gain = audio.createGain(), t = audio.currentTime + at;
  osc.type = shape;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(level, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + length);
}
const chime = notes => { ripple(); notes.forEach((f, i) => note(f * 2, i * 0.12, 0.7, 0.05)); };   // key, then the carriage bell
function ripple() {   // a single typewriter key
  if (muted) return;
  audio = audio || new (window.AudioContext || window.webkitAudioContext)();
  audio.resume();
  const buffer = audio.createBuffer(1, audio.sampleRate * 0.05, audio.sampleRate);
  buffer.getChannelData(0).forEach((_, i, d) => { d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3; });
  const src = audio.createBufferSource(), filter = audio.createBiquadFilter(), gain = audio.createGain();
  src.buffer = buffer;
  filter.type = "bandpass";
  filter.frequency.value = 1800;
  gain.gain.value = 0.3;
  src.connect(filter).connect(gain).connect(audio.destination);
  src.start();
}
const soundLabel = () => { $("soundBtn").textContent = muted ? "Sound off" : "Sound on"; };

// ---------- buttons ----------
const myName = () => { S.me = $("nameIn").value.trim().slice(0, 16); store.set("paperboats-name", S.me); $("homeErr").textContent = ""; };
$("hostBtn").onclick = () => { myName(); hostRoom(); };
$("joinBtn").onclick = () => {
  myName();
  const code = $("codeIn").value.trim().toUpperCase();
  if (!/^[A-Z]+-\d{2}$/.test(code)) { $("homeErr").textContent = "Room codes look like PEN-42."; return; }
  joinRoom(code);
};
$("codeIn").onkeydown = e => { if (e.key === "Enter") $("joinBtn").click(); };
$("copyBtn").onclick = async () => {
  const link = location.origin + location.pathname + "#" + S.code;
  try { await navigator.clipboard.writeText(link); $("copyBtn").textContent = "Copied!"; }
  catch { $("copyBtn").textContent = link; }
};
document.querySelectorAll("[data-leave]").forEach(b => { b.onclick = leave; });
$("turnBtn").onclick = turnBoat;
$("scatterBtn").onclick = scatter;
$("readyBtn").onclick = () => { S.iReady = true; S.sel = null; send({ t: "ready" }); tryStart(); renderPlace(); };
$("againBtn").onclick = () => {
  S.iAgain = true;
  send({ t: "again" });
  $("againBtn").disabled = true;
  $("againBtn").textContent = "Waiting…";
  tryAgain();
};
$("lookBtn").onclick = () => $("end").classList.remove("on");
$("soundBtn").onclick = () => { muted = !muted; store.set("paperboats-muted", muted ? "1" : "0"); soundLabel(); };
addEventListener("keydown", e => { if (e.key.toLowerCase() === "r" && $("place").classList.contains("on") && !S.iReady && e.target.tagName !== "INPUT") turnBoat(); });

// ---------- start ----------
$("nameIn").value = store.get("paperboats-name") || "";
const invite = decodeURIComponent(location.hash.slice(1)).toUpperCase();
if (/^[A-Z]+-\d{2}$/.test(invite)) $("codeIn").value = invite;
soundLabel();
