// The UI is served by FastAPI, so keeping API calls on the current origin makes
// local startup work on any available Uvicorn port (not only 8000).
const apiBase = window.location.origin;
const state = { fileId: null, objectUrl: null, sourceUrl: null, waves: {}, masterUrl: null, stemFiles: [] };
const els = Object.fromEntries([
  'single-file-input', 'stem-file-input', 'file-badge', 'track-info', 'track-name', 'track-meta', 'remove-file',
  'genre', 'analyze-button', 'master-button', 'workspace', 'status', 'metrics', 'feedback',
  'diagnostics-subtitle', 'master-card', 'download-button', 'choose-single', 'choose-stems', 'stem-queue', 'stem-queue-title', 'stem-queue-list', 'stem-premaster', 'stem-profile-label', 'add-stems', 'prepare-stems',
].map((id) => [id, document.getElementById(id)]));

const formatBytes = (bytes) => bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const endpoint = (path) => `${apiBase}${path}`;
const MAX_UPLOAD_BYTES = 1 * 1024 * 1024 * 1024;
const sliderIds = ['highpass-hz', 'target-lufs', 'compressor-threshold', 'compressor-ratio', 'compressor-attack', 'compressor-release', 'shelf-frequency', 'shelf-gain', 'max-makeup', 'limiter-ceiling'];
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
let waveSurferLoader;

function showStatus(message, kind = 'info') {
  const styles = { info: 'border-electric/35 bg-electric/10 text-slate-200', success: 'border-accent/35 bg-accent/10 text-slate-100', error: 'border-rose-400/35 bg-rose-400/10 text-rose-100' };
  els.status.className = `mb-5 rounded-xl border px-4 py-3 text-sm ${styles[kind]}`;
  els.status.textContent = message;
}

function destroyWave(name) { state.waves[name]?.destroy(); delete state.waves[name]; }
async function loadWaveSurfer() {
  waveSurferLoader ??= import('https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.esm.js').then((module) => module.default);
  let timeout;
  try {
    return await Promise.race([
      waveSurferLoader,
      new Promise((_, reject) => { timeout = window.setTimeout(() => reject(new Error('Waveform loading timed out')), 3500); }),
    ]);
  } finally {
    window.clearTimeout(timeout);
  }
}
async function makeWave(name, url, container, color) {
  destroyWave(name);
  const element = document.querySelector(container);
  try {
    const WaveSurfer = await loadWaveSurfer();
    const wave = WaveSurfer.create({ container, url, height: 82, waveColor: color, progressColor: '#66e3c4', cursorColor: '#e2e8f0', cursorWidth: 1.5, barWidth: 2, barGap: 2, barRadius: 3, normalize: true });
    wave.on('finish', () => updatePlayButton(name, false));
    state.waves[name] = wave;
  } catch {
    // Upload and mastering must remain usable if the optional waveform CDN is
    // unavailable.  Native audio playback is a reliable local fallback.
    const player = document.createElement('audio');
    player.controls = true; player.src = url; player.className = 'native-player';
    player.addEventListener('ended', () => updatePlayButton(name, false));
    element.replaceChildren(player);
    state.waves[name] = { destroy: () => player.remove(), playPause: () => player.paused ? player.play() : player.pause(), isPlaying: () => !player.paused };
  }
}
function updatePlayButton(name, playing) {
  const button = document.querySelector(`[data-wave="${name}"]`);
  if (button) button.textContent = playing ? 'Pause' : 'Play';
}

async function api(path, options = {}) {
  const response = await fetch(endpoint(path), options);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.detail || 'The request could not be completed.'); }
  return response.json();
}

function renderAnalysis(analysis, title = 'Original track') {
  const { metrics: m, feedback } = analysis;
  const cards = [
    ['Integrated loudness', `${m.integrated_lufs} LUFS`], ['True peak', `${m.true_peak_dbtp} dBTP`],
    ['Loudness range', `${m.loudness_range_lu} LU`], ['Spectral centroid', `${Math.round(m.spectral_centroid_hz).toLocaleString()} Hz`],
  ];
  els['diagnostics-subtitle'].textContent = `${title} · ${analysis.duration_seconds}s · ${analysis.sample_rate.toLocaleString()} Hz`;
  els.metrics.innerHTML = cards.map(([label, value]) => `<div class="metric-card"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`).join('');
  els.feedback.innerHTML = feedback.map((item) => `<div class="feedback-note">${item}</div>`).join('');
}

function updateSliderLabel(input) {
  const output = document.querySelector(`output[for="${input.id}"]`);
  if (!output) return;
  const value = Number(input.value);
  if (input.dataset.format === 'ratio') output.textContent = `${value}:1`;
  else if (input.dataset.format === 'khz') output.textContent = `${(value / 1000).toFixed(1)} kHz`;
  else output.textContent = `${value < 0 ? '−' : ''}${Math.abs(value)}${input.dataset.unit || ''}`;
}

function customSettings() {
  return {
    highpass_hz: Number(document.getElementById('highpass-hz').value),
    compressor_enabled: document.getElementById('compressor-enabled').checked,
    compressor_threshold_db: Number(document.getElementById('compressor-threshold').value),
    compressor_ratio: Number(document.getElementById('compressor-ratio').value),
    compressor_attack_ms: Number(document.getElementById('compressor-attack').value),
    compressor_release_ms: Number(document.getElementById('compressor-release').value),
    high_shelf_frequency_hz: Number(document.getElementById('shelf-frequency').value),
    high_shelf_gain_db: Number(document.getElementById('shelf-gain').value),
    target_lufs: Number(document.getElementById('target-lufs').value),
    max_makeup_gain_db: Number(document.getElementById('max-makeup').value),
    limiter_ceiling_dbtp: Number(document.getElementById('limiter-ceiling').value),
  };
}

function updateStemProfileLabel() {
  const selected = els.genre.options[els.genre.selectedIndex].text.split('—')[0].trim();
  els['stem-profile-label'].textContent = `Uses the selected ${selected} profile on every stem.`;
}

function renderStemQueue() {
  els['stem-queue'].classList.toggle('hidden', state.stemFiles.length === 0);
  if (state.stemFiles.length === 0) return;
  const totalBytes = state.stemFiles.reduce((total, file) => total + file.size, 0);
  els['stem-queue-title'].textContent = `${state.stemFiles.length} stem${state.stemFiles.length === 1 ? '' : 's'} queued · ${formatBytes(totalBytes)}`;
  els['prepare-stems'].disabled = state.stemFiles.length < 2;
  els['stem-queue-list'].innerHTML = state.stemFiles.map((file, index) => { const name = escapeHtml(file.name); return `<div class="queued-stem"><span class="queued-stem-name" title="${name}">${name}</span><span>${formatBytes(file.size)}</span><button class="queued-stem-remove" type="button" data-stem-index="${index}" aria-label="Remove ${name}">×</button></div>`; }).join('');
}

function addStemFiles(selectedFiles) {
  const files = Array.from(selectedFiles || []);
  if (!files.length) return;
  if (files.some((file) => !file.name.toLowerCase().endsWith('.wav'))) { showStatus('Every selected file must be a .wav audio file.', 'error'); return; }
  const additions = files.filter((file) => !state.stemFiles.some((existing) => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified));
  const total = [...state.stemFiles, ...additions];
  if (total.length > 32) { showStatus('A stem session supports up to 32 WAV files.', 'error'); return; }
  if (total.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD_BYTES) { showStatus('The combined stem upload is larger than the 1 GB limit.', 'error'); return; }
  state.stemFiles = total; els['stem-file-input'].value = ''; renderStemQueue();
}

async function uploadFiles(selectedFiles, stems = false) {
  const files = Array.from(selectedFiles || []);
  if (!stems && state.stemFiles.length) { state.stemFiles = []; renderStemQueue(); }
  if (!files.length || (!stems && files.length !== 1)) { showStatus('Please choose one valid .wav audio file.', 'error'); return; }
  if (stems && files.length < 2) { showStatus('A stem session needs at least two WAV files.', 'error'); return; }
  if (files.some((file) => !file.name.toLowerCase().endsWith('.wav'))) { showStatus('Every selected file must be a .wav audio file.', 'error'); return; }
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_UPLOAD_BYTES) { showStatus('The combined upload is larger than the 1 GB limit.', 'error'); return; }
  resetSession(false); showStatus(stems ? 'Uploading stems and building a safe premaster mix…' : 'Uploading and validating your WAV…'); els.workspace.classList.remove('hidden');
  const form = new FormData();
  files.forEach((file) => form.append(stems ? 'files' : 'file', file));
  if (stems && els['stem-premaster'].checked) {
    form.append('process_stems', 'true');
    form.append('genre', els.genre.value);
    if (els.genre.value === 'custom') form.append('custom_settings_json', JSON.stringify(customSettings()));
  }
  try {
    const result = await api(stems ? '/api/upload-stems' : '/api/upload', { method: 'POST', body: form });
    if (stems) { state.stemFiles = []; renderStemQueue(); }
    state.fileId = result.file_id; state.objectUrl = stems ? null : URL.createObjectURL(files[0]); state.sourceUrl = stems ? endpoint(`/api/stream/source/${result.file_id}`) : state.objectUrl;
    els['track-name'].textContent = stems ? `${files.length} stems — premaster mix` : result.filename;
    els['track-meta'].textContent = `${formatBytes(totalBytes)} · ${result.audio.sample_rate.toLocaleString()} Hz · ${result.audio.channels} ch`;
    els['track-info'].classList.remove('hidden'); els['file-badge'].textContent = stems ? 'Stem mix' : 'Loaded'; els['file-badge'].classList.remove('hidden');
    els.analyzeButton = els['analyze-button']; els.analyzeButton.disabled = false; els['master-button'].disabled = false;
    void makeWave('original', state.sourceUrl, '#waveform-original', '#61708d');
    const stemTreatment = stems && result.stem_pre_mastering?.enabled ? ` Each stem was pre-mastered with the ${result.stem_pre_mastering.genre.toUpperCase()} profile.` : '';
    const mixNote = stems && result.mix.pre_master_gain_db < 0 ? ` The summed stems were trimmed ${Math.abs(result.mix.pre_master_gain_db)} dB to preserve headroom.` : '';
    showStatus(`Track ready.${stemTreatment}${mixNote} Analyze it first, or go straight to automaster.`, 'success');
  } catch (error) { showStatus(error.message, 'error'); }
}

function resetSession(clearInput = true) {
  destroyWave('original'); destroyWave('mastered'); if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.fileId = null; state.objectUrl = null; state.sourceUrl = null; state.masterUrl = null; els['track-info'].classList.add('hidden'); els['file-badge'].classList.add('hidden'); els['analyze-button'].disabled = true; els['master-button'].disabled = true; els['master-card'].classList.add('hidden'); els.metrics.innerHTML = ''; els.feedback.innerHTML = ''; els['diagnostics-subtitle'].textContent = 'Run an analysis to begin.'; if (clearInput) { els['single-file-input'].value = ''; els['stem-file-input'].value = ''; }
}

async function withBusy(button, task, pendingLabel) {
  const old = button.innerHTML; button.disabled = true; button.innerHTML = `<span>${pendingLabel}</span><span class="animate-pulse">•••</span>`;
  try { await task(); } finally { button.disabled = !state.fileId; button.innerHTML = old; }
}

async function analyze() {
  if (!state.fileId) return;
  await withBusy(els['analyze-button'], async () => { showStatus('Measuring loudness, peaks, dynamics, and tone…'); const analysis = await api(`/api/analyze/${state.fileId}?genre=${encodeURIComponent(els.genre.value)}`); renderAnalysis(analysis); showStatus('Analysis complete. Review the diagnostics or create a master.', 'success'); }, 'Analyzing');
}
async function master() {
  if (!state.fileId) return;
  await withBusy(els['master-button'], async () => { showStatus('Building your genre-tuned master. This can take a moment for long tracks…'); const payload = { genre: els.genre.value }; if (payload.genre === 'custom') payload.custom_settings = customSettings(); const result = await api(`/api/master/${state.fileId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); renderAnalysis(result.after, `Mastered ${result.genre.toUpperCase()}`); state.masterUrl = endpoint(result.stream_url); void makeWave('mastered', state.masterUrl, '#waveform-mastered', '#7c8ae6'); els['download-button'].href = endpoint(result.download_url); els['master-card'].classList.remove('hidden'); showStatus(`Master complete — targeted to ${result.target_lufs} LUFS.`, 'success'); }, 'Mastering');
}

els['single-file-input'].addEventListener('change', (event) => uploadFiles(event.target.files));
els['stem-file-input'].addEventListener('change', (event) => addStemFiles(event.target.files));
els['choose-single'].addEventListener('click', () => els['single-file-input'].click());
els['choose-stems'].addEventListener('click', () => els['stem-file-input'].click());
els.genre.addEventListener('change', () => { document.getElementById('custom-controls').classList.toggle('hidden', els.genre.value !== 'custom'); updateStemProfileLabel(); });
sliderIds.forEach((id) => document.getElementById(id).addEventListener('input', (event) => updateSliderLabel(event.target)));
els['prepare-stems'].addEventListener('click', () => uploadFiles(state.stemFiles, true));
els['add-stems'].addEventListener('click', () => els['stem-file-input'].click());
els['stem-queue-list'].addEventListener('click', (event) => { const button = event.target.closest('[data-stem-index]'); if (!button) return; state.stemFiles.splice(Number(button.dataset.stemIndex), 1); renderStemQueue(); });
els['remove-file'].addEventListener('click', () => { resetSession(); els.workspace.classList.add('hidden'); });
els['analyze-button'].addEventListener('click', () => analyze().catch((error) => showStatus(error.message, 'error')));
els['master-button'].addEventListener('click', () => master().catch((error) => showStatus(error.message, 'error')));
document.querySelectorAll('.play-button').forEach((button) => button.addEventListener('click', () => { const name = button.dataset.wave; const wave = state.waves[name]; if (!wave) return; wave.playPause(); window.setTimeout(() => updatePlayButton(name, wave.isPlaying()), 0); }));
updateStemProfileLabel();
