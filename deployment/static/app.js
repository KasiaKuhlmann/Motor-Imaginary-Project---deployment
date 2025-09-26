// app.js — EEG → Music Layers (synced start, instant ON/OFF, English status)

let audioContext = null;
let mapping = {};                    // className -> relative wav path (e.g., "Set/track.wav")
let scheduledTimeouts = [];          // setTimeout handles for timeline
let buffersCache = {};               // url -> AudioBuffer
let gainNodes = {};                  // className -> GainNode (mask)
let activationCounts = {};           // className -> how many times toggled (odd=ON, even=OFF)
let activeClasses = new Set();       // currently ON (for status icons)
let currentExercise = null;

let eegCanvas = null;
let eegCtx = null;

// (kept for reference if you want viridis )
function viridis(t) {
  const a = Math.max(0, Math.min(1, t));
  const r = Math.round(255 * (0.267 + a * (0.233 + a * (0.121 - 0.233))));
  const g = Math.round(255 * (0.004 + a * (0.634 + a * (0.365 - 0.634))));
  const b = Math.round(255 * (0.329 + a * (0.196 + a * (0.478 - 0.196))));
  return [r, g, b];
}

// ---- Mixing constants ----
const NEUTRAL_LEVEL = 0.30;          // quiet bed for neutral
let audioStartTime = 0;               // remember common start

// ---- Class dictionaries ----
const classIdToName = {
  0: "left_hand",
  1: "right_hand",
  2: "neutral",
  3: "left_leg",
  4: "tongue",
  5: "right_leg",
};

const classIcons = {
  left_hand: "✋",
  right_hand: "🤚",
  left_leg: "⬅️🦶",
  right_leg: "🦶➡️",
};

const classEnglish = {
  left_hand: "Left hand",
  right_hand: "Right hand",
  neutral: "Neutral (bed)",
  left_leg: "Left foot",
  right_leg: "Right foot",
  tongue: "Tongue",
};

// ---- Color map for spectrogram ----
function rainbow(t) {
  const r = Math.round(255 * Math.sin(Math.PI * t));
  const g = Math.round(255 * Math.sin(Math.PI * (t + 0.33)));
  const b = Math.round(255 * Math.sin(Math.PI * (t + 0.66)));
  return [
    Math.max(0, Math.min(255, r)),
    Math.max(0, Math.min(255, g)),
    Math.max(0, Math.min(255, b))
  ];
}

window.addEventListener("load", async () => {
  await loadMusicSets();
  await loadExercises();

  document.getElementById("startBtn").onclick = startMusic;
  document.getElementById("stopBtn").onclick = stopAndReset;

  // spectrogram canvas refs
  eegCanvas = document.getElementById("eegSpectrogram");
  if (eegCanvas) {
    eegCtx = eegCanvas.getContext("2d");
    clearSpectrogram();
  }

  setStatus("Ready. Pick a music set + exercise, signal, then press Start.");
});

// ---- API helpers ----
async function loadMusicSets() {
  const res = await fetch("/api/music_sets");
  const data = await res.json();
  const sel = document.getElementById("musicSet");
  sel.innerHTML = "";
  (data.sets || []).forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  });
}

async function loadExercises() {
  const res = await fetch("/api/available_exercises");
  const data = await res.json();
  const sel = document.getElementById("exercise");
  sel.innerHTML = "";
  (data.exercises || []).forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = niceLabel(name);
    sel.appendChild(opt);
  });
}

function niceLabel(key) {
  const map = {
    full: "Full Body",
    hands: "Hands Only",
    right: "Right Side",
    left: "Left Side",
  };
  return map[key] || key;
}

// ---- Main flow ----
async function startMusic() {
  // clean previous run
  stopAndReset();

  const setName = document.getElementById("musicSet").value;
  const exercise = document.getElementById("exercise").value;
  currentExercise = exercise;

  // fetch mapping (auto-assign on backend)
  const resAssign = await fetch(
    `/api/assign_tracks/${encodeURIComponent(setName)}/${encodeURIComponent(exercise)}`
  );
  const dataAssign = await resAssign.json();
  if (dataAssign.error) {
    setStatus("❌ " + dataAssign.error);
    return;
  }

  // convert numeric class ids from backend to readable keys
  mapping = {};
  for (const [clsId, relPath] of Object.entries(dataAssign.mapping || {})) {
    const name = classIdToName[clsId] || clsId;
    mapping[name] = relPath;
  }

  if (!mapping || Object.keys(mapping).length === 0) {
    setStatus("❌ No tracks assigned.");
    return;
  }

  const filename = document.getElementById("csvFile").value.trim();
  if (!filename) {
    setStatus("❌ Enter CSV filename first.");
    return;
  }

  // audio context must be created/resumed after a user gesture
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  // preload and start all layers in perfect sync (non-neutral @ 0.0)
  try {
    await preloadAndStartAll();
  } catch (e) {
    console.error(e);
    setStatus("❌ Failed to load audio layers.");
    return;
  }

  // get timeline + spectrogram epochs
  const res = await fetch(`/api/stream_csv/${encodeURIComponent(filename)}`);
  const data = await res.json();
  if (data.error) {
    setStatus("❌ " + data.error);
    return;
  }

  const timeline = data.timeline || [];
  const epochs = data.epochs || []; // each epoch: 2D array [freqBins x timeBins] in dB

  setStatus(`Streaming ${timeline.length} windows...`);

  // schedule toggles & spectrogram frames
  scheduledTimeouts.forEach(clearTimeout);
  scheduledTimeouts = [];
  activationCounts = {};
  activeClasses.clear();
  updateStatusIcons(); // clear icons at start

  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    const id = setTimeout(() => {
      // toggle audio mask for the predicted class
      toggleLayer(entry.predicted_class);

      // update spectrogram frame for this epoch
      if (epochs[i]) {
        // if backend sends 3D [channels][freq][time], pick channel 0:
        const m = Array.isArray(epochs[i][0]) && Array.isArray(epochs[i][0][0])
          ? epochs[i][0]
          : epochs[i];
        updateSpectrogram(m);
      }
    }, entry.time_sec * 1000);
    scheduledTimeouts.push(id);
  }
}

// ---- Audio handling ----
async function preloadAndStartAll() {
  const urls = [];
  for (const cls of Object.keys(mapping)) {
    const relPath = mapping[cls];
    urls.push({ cls, url: `/Waves/${relPath}` });
  }

  // 1) Decode all files in parallel
  const decodedEntries = await Promise.all(
    urls.map(async ({ cls, url }) => {
      if (!buffersCache[url]) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Audio not found: ${url}`);
        const arr = await resp.arrayBuffer();
        buffersCache[url] = await audioContext.decodeAudioData(arr);
      }
      return { cls, buffer: buffersCache[url] };
    })
  );

  // 2) One common start time (a bit in the future)
  audioStartTime = audioContext.currentTime + 1.2;

  // 3) Create sources + gains, set exact levels BEFORE start, then start together
  decodedEntries.forEach(({ cls, buffer }) => {
    const src = audioContext.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const gain = audioContext.createGain();

    // set initial values slightly before start to avoid any leakage
    const t0 = audioStartTime - 0.01;
    try {
      gain.gain.cancelScheduledValues(0);
    } catch {}
    gain.gain.setValueAtTime(0.0, Math.max(0, audioContext.currentTime));
    if (cls === "neutral") {
      gain.gain.setValueAtTime(NEUTRAL_LEVEL, t0); // neutral bed
    } else {
      gain.gain.setValueAtTime(0.0, t0);           // others fully muted
    }

    src.connect(gain).connect(audioContext.destination);
    src.start(audioStartTime);

    gainNodes[cls] = gain;
  });

  console.log("🎵 All tracks scheduled at", audioStartTime);
}

function toggleLayer(clsId) {
  const className = classIdToName[clsId];

  // ignored classes
  if (className === "tongue") return;
  if (className === "neutral") return; // neutral is a quiet bed, not toggled

  if (!(className in mapping)) {
    // this class not present in current exercise/set
    return;
  }

  if (!(className in activationCounts)) {
    activationCounts[className] = 0;
  }
  activationCounts[className]++;

  const isOn = activationCounts[className] % 2 === 1;
  const gain = gainNodes[className];
  if (!gain) return;

  // INSTANT mask change (no fades)
  const now = audioContext.currentTime;
  try { gain.gain.cancelScheduledValues(now); } catch {}
  gain.gain.setValueAtTime(isOn ? 1.0 : 0.0, now);

  // Update active set + status (with track name)
  if (isOn) {
    activeClasses.add(className);
    setStatus(`Detected: ${classEnglish[className]} → 🎵 ${trackNameFor(className)} (ON)`);
  } else {
    activeClasses.delete(className);
    setStatus(`Detected: ${classEnglish[className]} → 🎵 ${trackNameFor(className)} (OFF)`);
  }

  // Icons update exactly together with audio
  updateStatusIcons();
}

function trackNameFor(className) {
  const rel = mapping[className] || "";
  const parts = String(rel).split(/[\\/]/);
  return parts[parts.length - 1] || "unknown.wav";
}

// ---- UI (status + icons) ----
function updateStatusIcons() {
  let leftSide = "";
  let rightSide = "";

  const onlyRight = currentExercise === "right";
  const onlyLeft = currentExercise === "left";

  if (!onlyRight && activeClasses.has("left_hand")) leftSide += classIcons.left_hand + " ";
  if (!onlyRight && activeClasses.has("left_leg")) leftSide += classIcons.left_leg;

  if (!onlyLeft && activeClasses.has("right_hand")) rightSide += classIcons.right_hand + " ";
  if (!onlyLeft && activeClasses.has("right_leg")) rightSide += classIcons.right_leg;

  // Place left icons to the left, right icons to the right
  const html =
    `<span style="font-size:2.2em; float:left;">${leftSide}</span>` +
    `<span style="font-size:2.2em; float:right;">${rightSide}</span>` +
    `<div style="clear:both;"></div>`;

  document.getElementById("status").innerHTML = html;
}

function setStatus(text) {
  const node = document.getElementById("status");
  if (!node) return;
  // For English detected message, append below icons block
  if (text.startsWith("Detected:")) {
    const existing = node.innerHTML;
    const msg = `<div style="margin-top:8px; font-size:0.95rem; color:#555;">${text}</div>`;
    node.innerHTML = existing + msg;
  } else {
    node.textContent = text;
  }
}

function stopAndReset() {
  // cancel scheduled callbacks
  scheduledTimeouts.forEach(clearTimeout);
  scheduledTimeouts = [];

  // hard-mute and disconnect all gains
  for (const cls in gainNodes) {
    try {
      gainNodes[cls].gain.cancelScheduledValues(0);
      gainNodes[cls].gain.value = 0;
      gainNodes[cls].disconnect();
    } catch {}
  }
  gainNodes = {};
  activationCounts = {};
  activeClasses.clear();

  clearSpectrogram();
  setStatus("⏹ Stopped & reset.");
}

// ---- Spectrogram drawing ----
// Expects matrix shape [freqBins x timeBins], values already in dB (≈ -60..0)
function updateSpectrogram(matrix) {
  if (!eegCtx || !matrix || !matrix.length || !matrix[0].length) return;

  const freqBins = matrix.length;
  const timeBins = matrix[0].length;

  // Fit the matrix to canvas size
  const W = eegCanvas.width;
  const H = eegCanvas.height;

  // Create an offscreen image where each matrix cell maps to pixel block
  const img = eegCtx.createImageData(timeBins, freqBins);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const normVal = (db) => clamp((db + 60) / 60, 0, 1);

  let p = 0;
  for (let y = 0; y < freqBins; y++) {
    for (let x = 0; x < timeBins; x++) {
      const v = normVal(matrix[y][x]);
      const [r, g, b] = rainbow(v);
      img.data[p++] = r;
      img.data[p++] = g;
      img.data[p++] = b;
      img.data[p++] = 255;
    }
  }

  const off = document.createElement("canvas");
  off.width = timeBins;
  off.height = freqBins;
  off.getContext("2d").putImageData(img, 0, 0);

  // Flip frequency axis so low freq at bottom (optional)
  eegCtx.save();
  eegCtx.clearRect(0, 0, W, H);
  eegCtx.translate(0, H);
  eegCtx.scale(1, -1);
  eegCtx.drawImage(off, 0, 0, W, H);
  eegCtx.restore();
}

function clearSpectrogram() {
  if (!eegCtx) return;
  eegCtx.fillStyle = "#f6f6f6";
  eegCtx.fillRect(0, 0, eegCanvas.width, eegCanvas.height);
  // simple grid
  eegCtx.strokeStyle = "#e0e0e0";
  eegCtx.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    const y = (i * eegCanvas.height) / 6;
    eegCtx.beginPath();
    eegCtx.moveTo(0, y);
    eegCtx.lineTo(eegCanvas.width, y);
    eegCtx.stroke();
  }
}


