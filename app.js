/* ═══════════════════════════════════════════
   NIGHTLOG – app.js
   Cyberpunk Evening Activity Tracker
   No build step. Pure Vanilla JS + localStorage.
═══════════════════════════════════════════ */

'use strict';

// ── CONFIGURATION ──────────────────────────────────────────────────────────────
// Edit names, icons, or colors here to customize activities.
// rgb must match the hex color, comma-separated (used for rgba() in CSS).

// line1 = kdo (velké, Orbitron), line2 = co (malé, mono)
const ACTIVITIES = [
  {
    id:    'chris-cte',
    line1: 'CHRIS',
    line2: 'si čte',
    icon:  '◈',
    color: '#00E5FF',
    rgb:   '0,229,255',
  },
  {
    id:    'chris-tel',
    line1: 'CHRIS',
    line2: 'na telefonu',
    icon:  '◁',
    color: '#0070FF',   /* electric blue – stejná rodina jako cyan výše */
    rgb:   '0,112,255',
  },
  {
    id:    'kata-cte',
    line1: 'KÁŤA',
    line2: 'si čte',
    icon:  '✦',
    color: '#FF00BB',   /* hot magenta */
    rgb:   '255,0,187',
  },
  {
    id:    'kata-tel',
    line1: 'KÁŤA',
    line2: 'na telefonu',
    icon:  '◆',
    color: '#FF6699',   /* neonová růžová – stejná rodina jako magenta výše */
    rgb:   '255,102,153',
  },
  {
    id:    'oba-ctou',
    line1: 'OBA',
    line2: 'si čtou',
    icon:  '◉',
    color: '#00FF41',   /* neon green */
    rgb:   '0,255,65',
  },
  {
    id:    'oba-tel',
    line1: 'OBA',
    line2: 'na telefonu',
    icon:  '⬢',
    color: '#FFE600',   /* neon yellow */
    rgb:   '255,230,0',
  },
];

const STORAGE_KEY  = 'nightlog_v1';
const GIST_ID      = '5e7f9f71bdcdf0e5c9a8cba664452624';
const GIST_FILE    = 'nightlog-data.json';
const LS_GIST_PAT  = 'nightlog_gist_pat'; // PAT stored in localStorage, never in code
const PIN_HASH     = '3e69f85e28228b9a23edc17f6742074bba4e6ea715344fa73eecb9246540b814';
const SESSION_KEY  = 'nightlog_pin_ok';
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MS   = 5 * 60 * 1000; // 5 minutes
const LS_PIN_ATTEMPTS  = 'nightlog_pin_attempts';
const LS_PIN_LOCKOUT   = 'nightlog_pin_lockout';
const CIRCUMFERENCE = 2 * Math.PI * 70; // SVG donut radius = 70

// In-memory cache – populated at startup from Gist (or localStorage fallback).
// loadData() and saveData() operate on this exclusively after startup.
let _memCache = null;

// In-memory pending selection (not yet saved)
let pendingSelections = [];


// ── DATA LAYER ─────────────────────────────────────────────────────────────────

/**
 * Synchronous read from in-memory cache.
 * Returns a shallow copy so callers can't corrupt the cache by mutation.
 */
function loadData() {
  return _memCache ? { ..._memCache } : {};
}

/**
 * Synchronous write:
 *   1. Updates in-memory cache immediately
 *   2. Writes to localStorage as resilient local cache
 *   3. Fires async Gist PATCH in background (fire-and-forget)
 */
function saveData(data) {
  _memCache = { ...data };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* quota exceeded or private browsing */ }
  syncToGist(data);
}


// ── GIST SYNC ──────────────────────────────────────────────────────────────────

function getGistPat() {
  return localStorage.getItem(LS_GIST_PAT) || '';
}

async function fetchFromGist() {
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        'Authorization': `Bearer ${getGistPat()}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      console.warn('[NightLog] Gist fetch failed:', res.status, res.statusText);
      return null;
    }
    const gist = await res.json();
    const file = gist.files?.[GIST_FILE];
    if (!file) {
      console.warn('[NightLog] Gist file not found:', GIST_FILE);
      return null;
    }
    const raw = file.truncated
      ? await (await fetch(file.raw_url)).text()
      : file.content;
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[NightLog] fetchFromGist error:', err);
    return null;
  }
}

async function syncToGist(data) {
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${getGistPat()}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: { [GIST_FILE]: { content: JSON.stringify(data) } },
      }),
    });
    if (!res.ok) {
      console.warn('[NightLog] Gist PATCH failed:', res.status, res.statusText);
    }
  } catch (err) {
    console.warn('[NightLog] syncToGist error:', err);
  }
}


// ── PIN AUTH ───────────────────────────────────────────────────────────────────

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function isPinVerified() {
  return localStorage.getItem(SESSION_KEY) === '1';
}

function waitForPin() {
  return new Promise((resolve) => {
    const overlay  = document.getElementById('pinOverlay');
    const digitsEl = document.getElementById('pinDigits');
    const errorEl  = document.getElementById('pinError');
    const inputs   = Array.from(digitsEl.querySelectorAll('.pin-digit'));

    let countdownInterval = null;

    // ── Lockout helpers ──────────────────────────────────────────
    function getLockoutRemaining() {
      const until = parseInt(localStorage.getItem(LS_PIN_LOCKOUT) || '0', 10);
      return Math.max(0, until - Date.now());
    }

    function getAttempts() {
      return parseInt(localStorage.getItem(LS_PIN_ATTEMPTS) || '0', 10);
    }

    function setInputsDisabled(disabled) {
      inputs.forEach(inp => { inp.disabled = disabled; });
    }

    function startCountdown() {
      setInputsDisabled(true);
      inputs.forEach(inp => { inp.value = ''; });

      function tick() {
        const remaining = getLockoutRemaining();
        if (remaining <= 0) {
          clearInterval(countdownInterval);
          countdownInterval = null;
          localStorage.removeItem(LS_PIN_LOCKOUT);
          localStorage.removeItem(LS_PIN_ATTEMPTS);
          errorEl.textContent = '';
          setInputsDisabled(false);
          setTimeout(() => inputs[0].focus(), 50);
          return;
        }
        const mins = Math.floor(remaining / 60000);
        const secs = Math.ceil((remaining % 60000) / 1000);
        errorEl.textContent = `PŘÍLIŠ MNOHO POKUSŮ – ČEKEJ ${mins}:${String(secs).padStart(2, '0')}`;
      }

      tick();
      countdownInterval = setInterval(tick, 1000);
    }

    // Check lockout on load
    if (getLockoutRemaining() > 0) {
      startCountdown();
    } else {
      setTimeout(() => inputs[0].focus(), 80);
    }

    // ── PIN check ────────────────────────────────────────────────
    function getEnteredPin() {
      return inputs.map(inp => inp.value).join('');
    }

    function clearDigits() {
      inputs.forEach(inp => { inp.value = ''; });
      inputs[0].focus();
    }

    async function checkPin() {
      const entered = getEnteredPin();
      if (entered.length < 6) return;

      const hash = await sha256(entered);
      if (hash === PIN_HASH) {
        // Correct — clear lockout state and proceed
        localStorage.removeItem(LS_PIN_ATTEMPTS);
        localStorage.removeItem(LS_PIN_LOCKOUT);
        localStorage.setItem(SESSION_KEY, '1');
        errorEl.textContent = '';
        overlay.classList.add('exit');
        overlay.addEventListener('transitionend', () => {
          overlay.style.display = 'none';
          resolve();
        }, { once: true });
      } else {
        // Wrong — increment attempts
        const attempts = getAttempts() + 1;
        localStorage.setItem(LS_PIN_ATTEMPTS, String(attempts));

        if (attempts >= PIN_MAX_ATTEMPTS) {
          localStorage.setItem(LS_PIN_LOCKOUT, String(Date.now() + PIN_LOCKOUT_MS));
          localStorage.setItem(LS_PIN_ATTEMPTS, '0');
          digitsEl.classList.add('shake');
          digitsEl.addEventListener('animationend', () => {
            digitsEl.classList.remove('shake');
          }, { once: true });
          startCountdown();
        } else {
          const left = PIN_MAX_ATTEMPTS - attempts;
          errorEl.textContent = `NESPRÁVNÝ KÓD – ZBÝVÁ ${left} ${left === 1 ? 'POKUS' : 'POKUSY'}`;
          digitsEl.classList.add('shake');
          digitsEl.addEventListener('animationend', () => {
            digitsEl.classList.remove('shake');
          }, { once: true });
          clearDigits();
        }
      }
    }

    inputs.forEach((input, idx) => {
      input.addEventListener('input', (e) => {
        const v = e.target.value.replace(/[^0-9]/g, '');
        input.value = v ? v[v.length - 1] : '';
        if (input.value && idx < inputs.length - 1) inputs[idx + 1].focus();
        if (getEnteredPin().length === 6) checkPin();
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !input.value && idx > 0) {
          inputs[idx - 1].value = '';
          inputs[idx - 1].focus();
        }
      });

      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = (e.clipboardData || window.clipboardData)
          .getData('text').replace(/[^0-9]/g, '').slice(0, 6);
        pasted.split('').forEach((ch, i) => { if (inputs[i]) inputs[i].value = ch; });
        if (pasted.length === 6) {
          checkPin();
        } else if (inputs[pasted.length]) {
          inputs[pasted.length].focus();
        }
      });
    });
  });
}


// ── SETUP SCREEN ───────────────────────────────────────────────────────────────

function waitForSetup() {
  return new Promise((resolve) => {
    const overlay  = document.getElementById('setupOverlay');
    const input    = document.getElementById('setupPatInput');
    const btn      = document.getElementById('setupSaveBtn');
    const errorEl  = document.getElementById('setupError');

    overlay.style.display = 'flex';
    setTimeout(() => input.focus(), 80);

    function save() {
      const val = input.value.trim();
      if (!val.startsWith('ghp_') && !val.startsWith('github_pat_')) {
        errorEl.textContent = 'NEPLATNÝ TOKEN – musí začínat ghp_ nebo github_pat_';
        return;
      }
      localStorage.setItem(LS_GIST_PAT, val);
      errorEl.textContent = '';
      overlay.classList.add('exit');
      overlay.addEventListener('transitionend', () => {
        overlay.style.display = 'none';
        overlay.classList.remove('exit');
        resolve();
      }, { once: true });
    }

    btn.addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  });
}


// ── LOADING OVERLAY ────────────────────────────────────────────────────────────

function showLoadingOverlay(message = 'PŘIPOJOVÁNÍ KE GIST...') {
  const overlay = document.getElementById('loadingOverlay');
  const status  = document.getElementById('loadingStatus');
  if (status) status.textContent = message;
  overlay.setAttribute('aria-hidden', 'false');
  overlay.classList.add('visible');
  overlay.classList.remove('exit');
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('loadingOverlay');
  overlay.classList.remove('visible');
  overlay.classList.add('exit');
  overlay.addEventListener('transitionend', () => {
    overlay.setAttribute('aria-hidden', 'true');
    overlay.classList.remove('exit');
  }, { once: true });
}

function updateLoadingStatus(message) {
  const status = document.getElementById('loadingStatus');
  if (status) status.textContent = message;
}

/**
 * Returns "YYYY-MM-DD" for a given Date (defaults to today).
 */
function getDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Returns array of selected indices for today (e.g. [0, 2]).
 * Handles old single-int format for backward compatibility.
 */
function getTodaySelections(data) {
  const val = data[getDateKey()];
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

/**
 * Adds a selection for today. Enforces rules:
 *   - Buttons 0–3 (individual): max 2 per day, blocked if OBA selected
 *   - Buttons 4–5 (OBA): max 1 per day, blocked if individual selected
 */
function addSelection(index) {
  const data       = loadData();
  const selections = getTodaySelections(data);

  if (selections.includes(index)) return;

  const has14  = selections.some(i => i < 4);
  const has56  = selections.some(i => i >= 4);
  const count14 = selections.filter(i => i < 4).length;

  if (index < 4 && (count14 >= 2 || has56)) return;
  if (index >= 4 && (has14 || has56))        return;

  data[getDateKey()] = [...selections, index];
  saveData(data);
}

/**
 * Returns an array of counts [count0, count1, …] per activity.
 * Handles both old (single int) and new (array) data format.
 */
function calculateCounts(data) {
  const counts = new Array(ACTIVITIES.length).fill(0);
  for (const val of Object.values(data)) {
    const indices = Array.isArray(val) ? val : [val];
    for (const idx of indices) {
      if (Number.isInteger(idx) && idx >= 0 && idx < ACTIVITIES.length) {
        counts[idx]++;
      }
    }
  }
  return counts;
}


// ── SVG HELPERS ────────────────────────────────────────────────────────────────

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}


// ── RENDER: DATE HEADER ────────────────────────────────────────────────────────

function renderDate() {
  const opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
  const str  = new Date().toLocaleDateString('cs-CZ', opts).toUpperCase();
  document.getElementById('currentDate').textContent = `// ${str} //`;
}


// ── RENDER: DONUT CHART ────────────────────────────────────────────────────────
//
// Each activity segment is a <circle> with stroke-dasharray tuned
// so only its proportional arc is visible. Segments are stacked by
// offsetting stroke-dashoffset (rotate -90° so we start at 12 o'clock).
//
// Formula:
//   segLen  = (count / total) * CIRCUMFERENCE
//   dasharray  = "segLen  (CIRCUMFERENCE - segLen)"
//   dashoffset = -cumulativeOffset   (negative = push segment forward)

function renderDonutChart(counts, total) {
  const svg = document.getElementById('scoreChart');
  svg.innerHTML = '';

  // Background ring (dark fill)
  svg.appendChild(svgEl('circle', {
    cx: 100, cy: 100, r: 70,
    fill: 'none',
    stroke: '#0d0d2e',
    'stroke-width': 20,
  }));

  // Thin guide rings
  svg.appendChild(svgEl('circle', {
    cx: 100, cy: 100, r: 81,
    fill: 'none',
    stroke: '#141440',
    'stroke-width': 0.5,
  }));
  svg.appendChild(svgEl('circle', {
    cx: 100, cy: 100, r: 58,
    fill: 'none',
    stroke: '#141440',
    'stroke-width': 0.5,
  }));

  if (total === 0) return;

  let cumulative = 0;

  ACTIVITIES.forEach((act, i) => {
    const count = counts[i] || 0;
    if (count === 0) return;

    const segLen  = (count / total) * CIRCUMFERENCE;
    // Small visual gap between adjacent segments (skip for tiny segments)
    const gap     = segLen > 6 ? 3 : 0;
    const drawLen = Math.max(0, segLen - gap);

    const circle = svgEl('circle', {
      cx: 100,
      cy: 100,
      r:  70,
      fill:              'none',
      stroke:            act.color,
      'stroke-width':    18,
      'stroke-dasharray':  `0 ${CIRCUMFERENCE}`,
      'stroke-dashoffset': `${-cumulative}`,
      transform:         'rotate(-90 100 100)',
      class:             'segment',
    });

    circle.style.filter = `drop-shadow(0 0 5px ${act.color})`;
    svg.appendChild(circle);

    // Animate segment to its final length after the browser paints the initial state
    const finalDasharray = `${drawLen} ${CIRCUMFERENCE - drawLen}`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      circle.setAttribute('stroke-dasharray', finalDasharray);
    }));

    cumulative += segLen;
  });
}


// ── RENDER: SCORE LEGEND ───────────────────────────────────────────────────────

function renderLegend(counts, total) {
  const list = document.getElementById('scoreLegend');
  list.innerHTML = '';

  ACTIVITIES.forEach((act, i) => {
    const count = counts[i] || 0;
    const pct   = total > 0 ? Math.round((count / total) * 100) : 0;

    const li = document.createElement('li');
    li.className = 'legend-item';
    li.innerHTML = `
      <span class="legend-dot"
            style="background:${act.color};box-shadow:0 0 6px ${act.color}">
      </span>
      <span class="legend-name" style="color:${act.color}">${act.line1} ${act.line2}</span>
      <span class="legend-count">${count}×</span>
      <span class="legend-pct"
            style="color:${act.color};text-shadow:0 0 8px rgba(${act.rgb},0.65)">
        ${pct}%
      </span>`;
    list.appendChild(li);
  });
}


// ── RENDER: ACTIVITY BUTTONS ───────────────────────────────────────────────────

function renderButtons(savedSelections, isSaved) {
  const grid     = document.getElementById('buttonsGrid');
  const msgEl    = document.getElementById('lockedMessage');
  const lockText = document.getElementById('lockText');
  const saveBar  = document.getElementById('saveBar');
  const saveBtn  = document.getElementById('saveBtn');

  // What to display: saved state or current pending state
  const displaySelections = isSaved ? savedSelections : pendingSelections;

  // Rules are checked against pendingSelections (only matters before saving)
  const count14 = pendingSelections.filter(i => i < 4).length;
  const has14   = pendingSelections.some(i => i < 4);
  const has56   = pendingSelections.some(i => i >= 4);

  grid.innerHTML = '';

  ACTIVITIES.forEach((act, i) => {
    const isSelected = displaySelections.includes(i);

    let isDisabled;
    if (isSaved) {
      // After saving: only the saved buttons remain active, rest are greyed out
      isDisabled = !isSelected;
    } else if (i < 4) {
      isDisabled = !isSelected && (count14 >= 2 || has56);
    } else {
      isDisabled = !isSelected && (has14 || has56);
    }

    const btn = document.createElement('button');
    btn.className = [
      'activity-btn',
      isSelected ? 'selected' : '',
      isDisabled  ? 'disabled'  : '',
    ].filter(Boolean).join(' ');

    btn.style.setProperty('--btn-color', act.color);
    btn.style.setProperty('--btn-rgb',   act.rgb);

    btn.type = 'button';
    btn.disabled = isDisabled;
    btn.setAttribute('aria-label',  `${act.line1} ${act.line2}`);
    btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');

    btn.innerHTML = `
      <span class="btn-icon" aria-hidden="true">${act.icon}</span>
      <span class="btn-name">${act.line1}</span>
      <span class="btn-sub">${act.line2}</span>`;

    // Before saving: clicking toggles pending selection
    if (!isSaved && !isDisabled) {
      btn.addEventListener('click', () => handleActivityToggle(i));
    }

    grid.appendChild(btn);
  });

  // Save bar – visible only when day not yet saved
  if (saveBar) saveBar.style.display = isSaved ? 'none' : 'flex';
  if (saveBtn) {
    saveBtn.disabled = pendingSelections.length === 0;
    saveBtn.classList.toggle('ready', pendingSelections.length > 0);
  }

  // Locked message – shown only after saving
  if (isSaved && savedSelections.length > 0) {
    const firstAct = ACTIVITIES[savedSelections[0]];
    const names    = savedSelections
      .map(i => `${ACTIVITIES[i].line1} ${ACTIVITIES[i].line2}`)
      .join('  +  ');
    lockText.textContent    = `ULOŽENO: ${names}`;
    msgEl.style.display     = 'flex';
    msgEl.style.color       = firstAct.color;
    msgEl.style.borderColor = firstAct.color;
    msgEl.style.boxShadow   = `0 0 14px rgba(${firstAct.rgb},0.45)`;
    msgEl.style.textShadow  = `0 0 8px rgba(${firstAct.rgb},0.8)`;
  } else {
    msgEl.style.display = 'none';
  }
}


// ── RENDER: CALENDAR ───────────────────────────────────────────────────────────

let calViewDate = new Date();   // tracks which month is displayed

function renderCalendar(data) {
  const year  = calViewDate.getFullYear();
  const month = calViewDate.getMonth();

  // Month title
  const monthStr = new Date(year, month, 1)
    .toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' })
    .toUpperCase();
  document.getElementById('calendarTitle').textContent = monthStr;

  const grid     = document.getElementById('calendarGrid');
  const todayKey = getDateKey();

  grid.innerHTML = '';

  // Day-of-week of the 1st: convert Sunday=0 → Monday=0 system
  const firstDow    = new Date(year, month, 1).getDay();
  const startOffset = (firstDow + 6) % 7;   // 0=Mon … 6=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Empty leading cells
  for (let i = 0; i < startOffset; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-day empty';
    empty.setAttribute('aria-hidden', 'true');
    grid.appendChild(empty);
  }

  // Day cells
  for (let d = 1; d <= daysInMonth; d++) {
    const dateKey  = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const actIdx   = data[dateKey];
    const isToday  = dateKey === todayKey;
    const isPast   = dateKey <= todayKey;   // includes today
    const hasRec   = actIdx !== undefined;

    const cell = document.createElement('div');
    cell.className = [
      'cal-day',
      isToday ? 'today'      : '',
      hasRec  ? 'recorded'   : '',
      isPast  ? 'past-day'   : 'future-day',
    ].filter(Boolean).join(' ');

    cell.setAttribute('role', 'gridcell');
    cell.textContent = d;

    if (hasRec) {
      // Normalize to array (handles old single-int format)
      const indices = Array.isArray(actIdx) ? actIdx : [actIdx];
      const act  = ACTIVITIES[indices[0]];
      const act2 = indices[1] !== undefined ? ACTIVITIES[indices[1]] : null;

      if (act2) {
        // Two activities: diagonal split background
        cell.style.background  = `linear-gradient(135deg, rgba(${act.rgb},0.22) 50%, rgba(${act2.rgb},0.22) 50%)`;
        cell.style.borderColor = act.color;
        cell.style.boxShadow   = `0 0 8px rgba(${act.rgb},0.3), inset 0 0 6px rgba(${act2.rgb},0.15)`;
        cell.style.color       = act.color;
      } else {
        cell.style.background  = `rgba(${act.rgb}, 0.15)`;
        cell.style.borderColor = act.color;
        cell.style.color       = act.color;
        cell.style.boxShadow   = `0 0 8px rgba(${act.rgb},0.35), inset 0 0 8px rgba(${act.rgb},0.1)`;
      }
      const label = indices.map(i => `${ACTIVITIES[i].line1} ${ACTIVITIES[i].line2}`).join(' + ');
      cell.setAttribute('title',      label);
      cell.setAttribute('aria-label', `${d}. – ${label}`);
    } else {
      cell.setAttribute('aria-label', String(d));
    }

    // Past + today days are clickable for editing
    if (isPast) {
      cell.addEventListener('click', () => openDayEditor(dateKey));
    }

    grid.appendChild(cell);
  }
}


// ── DAY EDITOR ─────────────────────────────────────────────────────────────────

let editingDate    = null;
let editingPending = [];

function openDayEditor(dateKey) {
  editingDate = dateKey;
  const data  = loadData();
  const existing = data[dateKey];
  editingPending = existing !== undefined
    ? (Array.isArray(existing) ? [...existing] : [existing])
    : [];

  const [y, m, d] = dateKey.split('-').map(Number);
  const dateStr = new Date(y, m - 1, d)
    .toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .toUpperCase();
  document.getElementById('dayModalDate').textContent = `// ${dateStr} //`;

  renderDayEditor();

  const overlay = document.getElementById('dayModalOverlay');
  overlay.setAttribute('aria-hidden', 'false');
  overlay.classList.add('open');
}

function closeDayEditor() {
  editingDate    = null;
  editingPending = [];
  const overlay  = document.getElementById('dayModalOverlay');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
}

function renderDayEditor() {
  const grid    = document.getElementById('dayModalGrid');
  const saveBtn = document.getElementById('dayModalSave');

  const count14 = editingPending.filter(i => i < 4).length;
  const has14   = editingPending.some(i => i < 4);
  const has56   = editingPending.some(i => i >= 4);

  grid.innerHTML = '';

  ACTIVITIES.forEach((act, i) => {
    const isSelected = editingPending.includes(i);

    let isDisabled;
    if (i < 4) {
      isDisabled = !isSelected && (count14 >= 2 || has56);
    } else {
      isDisabled = !isSelected && (has14 || has56);
    }

    const btn = document.createElement('button');
    btn.className = [
      'activity-btn',
      isSelected ? 'selected' : '',
      isDisabled  ? 'disabled'  : '',
    ].filter(Boolean).join(' ');

    btn.style.setProperty('--btn-color', act.color);
    btn.style.setProperty('--btn-rgb',   act.rgb);
    btn.type = 'button';
    btn.disabled = isDisabled;
    btn.setAttribute('aria-label',  `${act.line1} ${act.line2}`);
    btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');

    btn.innerHTML = `
      <span class="btn-icon" aria-hidden="true">${act.icon}</span>
      <span class="btn-name">${act.line1}</span>
      <span class="btn-sub">${act.line2}</span>`;

    if (!isDisabled) {
      btn.addEventListener('click', () => handleDayEditorToggle(i));
    }

    grid.appendChild(btn);
  });

  if (saveBtn) saveBtn.classList.toggle('ready', editingPending.length > 0);

  // Show delete button only when the day already has a saved record
  const deleteBtn = document.getElementById('dayModalDelete');
  if (deleteBtn) {
    const hasRecord = loadData()[editingDate] !== undefined;
    deleteBtn.style.display = hasRecord ? '' : 'none';
  }
}

function handleDayEditorToggle(index) {
  if (editingPending.includes(index)) {
    editingPending = editingPending.filter(i => i !== index);
  } else {
    const has14   = editingPending.some(i => i < 4);
    const has56   = editingPending.some(i => i >= 4);
    const count14 = editingPending.filter(i => i < 4).length;
    if (index < 4 && (count14 >= 2 || has56)) return;
    if (index >= 4 && (has14 || has56))        return;
    editingPending = [...editingPending, index];
  }
  renderDayEditor();
}

function saveDayEditor() {
  if (!editingDate) return;
  const data = loadData();
  if (editingPending.length > 0) {
    data[editingDate] = [...editingPending];
  } else {
    delete data[editingDate];
  }
  saveData(data);
  closeDayEditor();
  refreshAll();
}

function deleteDayEditor() {
  if (!editingDate) return;
  const data = loadData();
  delete data[editingDate];
  saveData(data);
  closeDayEditor();
  refreshAll();
}

function initDayEditor() {
  document.getElementById('dayModalClose') .addEventListener('click', closeDayEditor);
  document.getElementById('dayModalCancel').addEventListener('click', closeDayEditor);
  document.getElementById('dayModalSave')  .addEventListener('click', saveDayEditor);
  document.getElementById('dayModalDelete').addEventListener('click', deleteDayEditor);
  // Close on backdrop click
  document.getElementById('dayModalOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeDayEditor();
  });
}


// ── EVENT HANDLERS ─────────────────────────────────────────────────────────────

function handleActivityToggle(index) {
  if (pendingSelections.includes(index)) {
    pendingSelections = pendingSelections.filter(i => i !== index);
  } else {
    const has14   = pendingSelections.some(i => i < 4);
    const has56   = pendingSelections.some(i => i >= 4);
    const count14 = pendingSelections.filter(i => i < 4).length;
    if (index < 4 && (count14 >= 2 || has56)) return;
    if (index >= 4 && (has14 || has56))        return;
    pendingSelections = [...pendingSelections, index];
  }
  const data    = loadData();
  const isSaved = data[getDateKey()] !== undefined;
  renderButtons(getTodaySelections(data), isSaved);
}

function initSaveButton() {
  const btn = document.getElementById('saveBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (pendingSelections.length === 0) return;
    const data = loadData();
    data[getDateKey()] = [...pendingSelections];
    saveData(data);
    pendingSelections = [];
    refreshAll();
  });
}

document.getElementById('prevMonth').addEventListener('click', (e) => {
  calViewDate = new Date(calViewDate.getFullYear(), calViewDate.getMonth() - 1, 1);
  renderCalendar(loadData());
  e.currentTarget.blur();
});

document.getElementById('nextMonth').addEventListener('click', (e) => {
  calViewDate = new Date(calViewDate.getFullYear(), calViewDate.getMonth() + 1, 1);
  renderCalendar(loadData());
  e.currentTarget.blur();
});


// ── RESET TODAY ────────────────────────────────────────────────────────────────
// Two-step confirmation: first click → warn, second click → delete today's record.

let resetPending = false;
let resetTimer   = null;

function initResetButton() {
  const btn = document.getElementById('resetTodayBtn');
  if (!btn) return;

  btn.addEventListener('click', () => {
    if (!resetPending) {
      // Step 1: arm
      resetPending        = true;
      btn.textContent     = '⚠ POTVRDIT RESET';
      btn.classList.add('armed');

      // Auto-revert after 3 s
      resetTimer = setTimeout(() => {
        resetPending    = false;
        btn.textContent = '↺ RESET DNE';
        btn.classList.remove('armed');
      }, 3000);
    } else {
      // Step 2: execute
      clearTimeout(resetTimer);
      resetPending = false;

      const data = loadData();
      delete data[getDateKey()];
      saveData(data);
      pendingSelections = [];

      btn.textContent = '✓ RESET PROVEDEN';
      btn.classList.remove('armed');
      btn.classList.add('done');

      setTimeout(() => {
        btn.textContent = '↺ RESET DNE';
        btn.classList.remove('done');
        refreshAll();
      }, 1200);
    }
  });
}


// ── MAIN REFRESH ───────────────────────────────────────────────────────────────

function refreshAll() {
  const data           = loadData();
  const savedSelections = getTodaySelections(data);
  const isSaved        = data[getDateKey()] !== undefined;
  const counts         = calculateCounts(data);
  const total          = counts.reduce((a, b) => a + b, 0);

  renderDate();
  renderDonutChart(counts, total);
  renderLegend(counts, total);
  renderButtons(savedSelections, isSaved);
  renderCalendar(data);

  document.getElementById('totalCount').textContent = total;
}


// ── SERVICE WORKER REGISTRATION ────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then(reg => {
        console.log('[NightLog] SW registered, scope:', reg.scope);
        // Zkontroluje update při každém příchodu do popředí (klíčové pro iOS PWA)
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) reg.update();
        });
      })
      .catch(err => console.warn('[NightLog] SW registration failed:', err));
  });
}


// ── STARTUP ────────────────────────────────────────────────────────────────────

async function startup() {
  // Step 1: PIN gate (skipped if already verified this session)
  if (!isPinVerified()) {
    await waitForPin();
  }

  // Step 1b: Setup gate – PAT needed for Gist sync (only on first run per device)
  if (!getGistPat()) {
    await waitForSetup();
  }

  // Step 2: Fetch data from Gist (with localStorage fallback)
  showLoadingOverlay('PŘIPOJOVÁNÍ KE GIST...');

  const gistData = await fetchFromGist();

  if (gistData !== null) {
    _memCache = gistData;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(gistData)); } catch { /* ignore */ }
    updateLoadingStatus('DATA NAČTENA ✓');
  } else {
    let localData = {};
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      localData = raw ? JSON.parse(raw) : {};
    } catch { /* ignore */ }
    _memCache = localData;
    updateLoadingStatus('OFFLINE – LOKÁLNÍ DATA');
    await new Promise(resolve => setTimeout(resolve, 1200));
  }

  // Step 3: Hide loading overlay and render app
  hideLoadingOverlay();
  await new Promise(resolve => setTimeout(resolve, 310));

  refreshAll();
  initResetButton();
  initSaveButton();
  initDayEditor();
}

// Save PAT from ?pat= URL param into localStorage, then remove from URL
(function setupPatFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const pat = params.get('pat');
  if (pat) {
    localStorage.setItem(LS_GIST_PAT, pat);
    const url = new URL(window.location.href);
    url.searchParams.delete('pat');
    window.history.replaceState({}, '', url.toString());
  }
})();

// Hide PIN overlay immediately if already verified (no animation needed)
(function prepareOverlays() {
  const pinOverlay = document.getElementById('pinOverlay');
  if (isPinVerified()) pinOverlay.style.display = 'none';
})();

startup();
