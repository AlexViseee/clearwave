const MAX_UPLOAD_BYTES = 1 * 1024 * 1024 * 1024;
const state = { tracks: [], context: null, master: null, playing: false, soloKey: null, pendingAnalysis: null };
const els = Object.fromEntries([
  'stem-input', 'add-stems', 'session-summary', 'daw-genre', 'daw-premaster',
  'play-preview', 'stop-preview', 'playback-status', 'empty-desk', 'daw-track-list',
  'daw-status', 'bounce-button', 'mix-desk-panel', 'reset-mixer-size', 'analysis-dialog',
  'analysis-track-name', 'analysis-results', 'analysis-suggestion', 'apply-auto-eq', 'cancel-analysis',
].map((id) => [id, document.getElementById(id)]));

const bytes = (value) => value < 1024 * 1024 ? `${Math.round(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const keyFor = (file) => `${file.name}:${file.size}:${file.lastModified}`;
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const db = (value) => value <= 0 ? '−∞' : `${(20 * Math.log10(value)).toFixed(1)} dBFS`;
const hz = (value) => value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} kHz` : `${Math.round(value)} Hz`;

function status(message, type = 'info') {
  const styles = { info: 'border-electric/35 bg-electric/10 text-slate-200', success: 'border-accent/35 bg-accent/10 text-slate-100', error: 'border-rose-400/35 bg-rose-400/10 text-rose-100' };
  els['daw-status'].className = `mt-5 rounded-xl border px-4 py-3 text-sm ${styles[type]}`;
  els['daw-status'].textContent = message;
}

function context() {
  if (!state.context) {
    const AudioEngine = window.AudioContext || window.webkitAudioContext;
    if (!AudioEngine) throw new Error('This browser does not support live audio preview.');
    state.context = new AudioEngine();
    state.master = state.context.createGain();
    state.master.gain.value = 0.8;
    state.master.connect(state.context.destination);
  }
  return state.context;
}

function isAudible(track) {
  return !track.muted && (!state.soloKey || state.soloKey === track.key);
}

function updatePlaybackLabel() {
  const soloTrack = state.tracks.find((track) => track.key === state.soloKey);
  if (state.playing) els['playback-status'].textContent = soloTrack ? `Solo: ${soloTrack.file.name}` : 'Live mix preview active';
  else els['playback-status'].textContent = soloTrack ? `Solo armed: ${soloTrack.file.name}` : 'Preview stopped';
}

function applyTrack(track) {
  if (!track.gainNode) return;
  const now = context().currentTime;
  track.gainNode.gain.setTargetAtTime(isAudible(track) ? 10 ** (track.gainDb / 20) : 0, now, 0.012);
  if (track.panNode.pan) track.panNode.pan.setTargetAtTime(track.pan / 100, now, 0.012);
  track.eqNode.frequency.setTargetAtTime(track.eqFrequencyHz, now, 0.012);
  track.eqNode.gain.setTargetAtTime(track.eqGainDb, now, 0.012);
  track.eqNode.Q.setTargetAtTime(track.eqQ, now, 0.012);
}

function applyAllTracks() {
  state.tracks.forEach(applyTrack);
  updatePlaybackLabel();
}

function trackRow(track, index) {
  const soloed = state.soloKey === track.key;
  return `<div class="mix-track ${track.muted ? 'muted' : ''} ${soloed ? 'soloed' : ''}">
    <span class="mix-track-number">${String(index + 1).padStart(2, '0')}</span>
    <span class="mix-track-name" title="${escapeHtml(track.file.name)}">${escapeHtml(track.file.name)}</span>
    <label class="mix-control"><span class="mix-control-top"><span>Gain</span><output class="mix-control-value">${track.gainDb > 0 ? '+' : ''}${track.gainDb.toFixed(1)} dB</output></span><input type="range" min="-24" max="12" step="0.5" value="${track.gainDb}" data-track="${index}" data-control="gain" /></label>
    <label class="mix-control"><span class="mix-control-top"><span>Pan</span><output class="mix-control-value">${track.pan === 0 ? 'C' : `${track.pan < 0 ? 'L' : 'R'}${Math.abs(track.pan)}`}</output></span><input type="range" min="-100" max="100" step="1" value="${track.pan}" data-track="${index}" data-control="pan" /></label>
    <span class="mix-track-actions"><button type="button" class="mix-solo ${soloed ? 'active' : ''}" data-track="${index}" data-action="solo" aria-pressed="${soloed}" aria-label="Solo ${escapeHtml(track.file.name)}">S</button><button type="button" class="mix-mute ${track.muted ? 'active' : ''}" data-track="${index}" data-action="mute" aria-pressed="${track.muted}" aria-label="Mute ${escapeHtml(track.file.name)}">M</button></span>
    <div class="track-eq"><span class="track-eq-title"><span>Parametric EQ</span><button type="button" class="mix-analyze" data-track="${index}" data-action="analyze">Analyze</button></span><label class="eq-field"><span>Hz</span><input type="number" min="20" max="20000" step="10" value="${track.eqFrequencyHz}" data-track="${index}" data-control="eq-frequency" /></label><label class="eq-field"><span>Gain</span><input type="number" min="-18" max="18" step="0.1" value="${track.eqGainDb}" data-track="${index}" data-control="eq-gain" /><em>dB</em></label><label class="eq-field"><span>Res / Q</span><input type="number" min="0.1" max="20" step="0.1" value="${track.eqQ}" data-track="${index}" data-control="eq-q" /></label></div>
  </div>`;
}

function render() {
  const total = state.tracks.reduce((sum, track) => sum + track.file.size, 0);
  const ready = state.tracks.length >= 2;
  els['session-summary'].classList.toggle('hidden', !state.tracks.length);
  els['session-summary'].textContent = `${state.tracks.length} track${state.tracks.length === 1 ? '' : 's'} loaded · ${bytes(total)}`;
  els['empty-desk'].classList.toggle('hidden', !!state.tracks.length);
  els['daw-track-list'].classList.toggle('hidden', !state.tracks.length);
  els['bounce-button'].classList.toggle('hidden', !state.tracks.length);
  els['play-preview'].disabled = !state.tracks.length;
  els['bounce-button'].disabled = !ready;
  els['daw-track-list'].innerHTML = state.tracks.map(trackRow).join('');
  updatePlaybackLabel();
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (files.some((file) => !file.name.toLowerCase().endsWith('.wav'))) return status('Every track must be a WAV file.', 'error');
  const unique = files.filter((file) => !state.tracks.some((track) => track.key === keyFor(file)));
  if (state.tracks.length + unique.length > 32) return status('A session supports up to 32 stems.', 'error');
  if ([...state.tracks.map((track) => track.file), ...unique].reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD_BYTES) return status('The combined session is larger than 1 GB.', 'error');
  status('Decoding tracks for live preview…');
  try {
    const audio = context();
    const decoded = await Promise.all(unique.map(async (file) => ({ file, buffer: await audio.decodeAudioData(await file.arrayBuffer()) })));
    state.tracks.push(...decoded.map(({ file, buffer }) => ({ key: keyFor(file), file, buffer, gainDb: 0, pan: 0, muted: false, eqFrequencyHz: 1000, eqGainDb: 0, eqQ: 0.7, source: null, gainNode: null, panNode: null, eqNode: null })));
    els['stem-input'].value = '';
    render();
    status('Tracks are ready. Solo a stem, analyze it, or preview the whole mix.', 'success');
  } catch (error) {
    status(error.message || 'One of the WAV files could not be decoded for preview.', 'error');
  }
}

function analysisWindow(buffer) {
  const size = Math.min(1024, buffer.length);
  if (!size) return new Float32Array(0);
  let bestStart = 0;
  let bestEnergy = -1;
  const probes = Math.min(24, Math.max(1, Math.floor(buffer.length / size)));
  for (let probe = 0; probe < probes; probe += 1) {
    const start = Math.floor((buffer.length - size) * (probe / Math.max(1, probes - 1)));
    let energy = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < size; index += 1) energy += data[start + index] ** 2;
    }
    if (energy > bestEnergy) { bestEnergy = energy; bestStart = start; }
  }
  const mono = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) mono[index] += buffer.getChannelData(channel)[bestStart + index] / buffer.numberOfChannels;
  }
  return mono;
}

function spectralCentroid(samples, sampleRate) {
  const size = samples.length;
  if (size < 32) return 0;
  let numerator = 0;
  let denominator = 0;
  for (let bin = 1; bin <= size / 2; bin += 1) {
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < size; index += 1) {
      const value = samples[index] * (0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (size - 1)));
      const angle = (2 * Math.PI * bin * index) / size;
      real += value * Math.cos(angle);
      imaginary -= value * Math.sin(angle);
    }
    const magnitude = Math.hypot(real, imaginary);
    numerator += (bin * sampleRate / size) * magnitude;
    denominator += magnitude;
  }
  return denominator ? numerator / denominator : 0;
}

function analyzeTrack(track) {
  const buffer = track.buffer;
  const maxSamples = Math.min(buffer.length, buffer.sampleRate * 180);
  const step = Math.max(1, Math.ceil(maxSamples / 1_000_000));
  let sumSquares = 0;
  let peak = 0;
  let samples = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < maxSamples; index += step) {
      const value = data[index];
      sumSquares += value * value;
      peak = Math.max(peak, Math.abs(value));
      samples += 1;
    }
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, samples));
  const centroid = spectralCentroid(analysisWindow(buffer), buffer.sampleRate);
  let suggestion;
  if (centroid < 1500) suggestion = { frequency: 4800, gain: 3, q: 0.8, reason: 'The stem is dark. A broad high-mid lift should add definition.' };
  else if (centroid > 5200) suggestion = { frequency: 4200, gain: -2.5, q: 1.1, reason: 'The stem is very bright. A focused presence cut should reduce harshness.' };
  else suggestion = { frequency: 2200, gain: 1.5, q: 0.9, reason: 'The stem is balanced. A gentle presence lift should help it translate.' };
  return { peak, loudness: 20 * Math.log10(Math.max(rms, 1e-8)), centroid, suggestion };
}

function closeAnalysis() {
  state.pendingAnalysis = null;
  if (els['analysis-dialog'].open) els['analysis-dialog'].close();
}

function openAnalysis(index) {
  const track = state.tracks[index];
  if (!track) return;
  status(`Analyzing ${track.file.name}…`);
  window.setTimeout(() => {
    const analysis = analyzeTrack(track);
    state.pendingAnalysis = { index, suggestion: analysis.suggestion };
    els['analysis-track-name'].textContent = track.file.name;
    els['analysis-results'].innerHTML = `<div><span>Estimated level</span><strong>${analysis.loudness.toFixed(1)} dB</strong></div><div><span>Peak</span><strong>${db(analysis.peak)}</strong></div><div><span>Spectral centroid</span><strong>${hz(analysis.centroid)}</strong></div>`;
    els['analysis-suggestion'].innerHTML = `<p>${analysis.suggestion.reason}</p><dl><div><dt>Hz</dt><dd>${hz(analysis.suggestion.frequency)}</dd></div><div><dt>Gain</dt><dd>${analysis.suggestion.gain > 0 ? '+' : ''}${analysis.suggestion.gain.toFixed(1)} dB</dd></div><div><dt>Res / Q</dt><dd>${analysis.suggestion.q.toFixed(1)}</dd></div></dl>`;
    els['analysis-dialog'].showModal();
    status('Stem analysis is ready. Apply or cancel the proposed EQ.', 'success');
  }, 0);
}

function applyAutoEq() {
  const pending = state.pendingAnalysis;
  const track = pending && state.tracks[pending.index];
  if (!track) return closeAnalysis();
  track.eqFrequencyHz = pending.suggestion.frequency;
  track.eqGainDb = pending.suggestion.gain;
  track.eqQ = pending.suggestion.q;
  applyTrack(track);
  closeAnalysis();
  render();
  status(`Auto EQ was applied to ${track.file.name}.`, 'success');
}

function stop() {
  state.tracks.forEach((track) => {
    if (track.source) {
      try { track.source.stop(); } catch {}
      track.source.disconnect();
      track.source = null;
      track.gainNode = null;
      track.panNode = null;
      track.eqNode = null;
    }
  });
  state.playing = false;
  els['stop-preview'].disabled = true;
  updatePlaybackLabel();
}

async function play() {
  if (!state.tracks.length) return;
  stop();
  const audio = context();
  await audio.resume();
  const start = audio.currentTime + 0.04;
  state.tracks.forEach((track) => {
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    const eq = audio.createBiquadFilter();
    const pan = audio.createStereoPanner ? audio.createStereoPanner() : audio.createGain();
    eq.type = 'peaking';
    source.buffer = track.buffer;
    source.connect(gain).connect(eq).connect(pan).connect(state.master);
    track.source = source;
    track.gainNode = gain;
    track.panNode = pan;
    track.eqNode = eq;
    applyTrack(track);
    source.start(start);
  });
  state.playing = true;
  els['stop-preview'].disabled = false;
  updatePlaybackLabel();
}

function bounceSettings() {
  return state.tracks.map((track) => ({ gain_db: track.gainDb, pan: track.pan, muted: track.muted, eq_frequency_hz: track.eqFrequencyHz, eq_gain_db: track.eqGainDb, eq_q: track.eqQ }));
}

async function bounce() {
  if (state.tracks.length < 2) return;
  stop();
  const form = new FormData();
  state.tracks.forEach((track) => form.append('files', track.file));
  form.append('track_settings_json', JSON.stringify(bounceSettings()));
  if (els['daw-premaster'].checked && els['daw-genre'].value) {
    form.append('process_stems', 'true');
    form.append('genre', els['daw-genre'].value);
  }
  els['bounce-button'].disabled = true;
  status('Rendering live mix and EQ settings to a premaster…');
  try {
    const response = await fetch('/api/upload-stems', { method: 'POST', body: form });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || 'The premaster could not be created.');
    window.location.assign(`/?file_id=${encodeURIComponent(result.file_id)}`);
  } catch (error) {
    status(error.message, 'error');
    els['bounce-button'].disabled = false;
  }
}

els['add-stems'].addEventListener('click', () => els['stem-input'].click());
els['stem-input'].addEventListener('change', (event) => addFiles(event.target.files));
els['play-preview'].addEventListener('click', () => play().catch((error) => status(error.message || 'Playback could not start. Click Preview again.', 'error')));
els['stop-preview'].addEventListener('click', stop);
els['bounce-button'].addEventListener('click', bounce);
els['reset-mixer-size'].addEventListener('click', () => {
  els['mix-desk-panel'].style.removeProperty('width');
  els['mix-desk-panel'].style.removeProperty('height');
});
els['apply-auto-eq'].addEventListener('click', applyAutoEq);
els['cancel-analysis'].addEventListener('click', closeAnalysis);
els['analysis-dialog'].querySelectorAll('[data-cancel-analysis]').forEach((button) => button.addEventListener('click', closeAnalysis));
els['analysis-dialog'].addEventListener('cancel', () => { state.pendingAnalysis = null; });
els['daw-track-list'].addEventListener('input', (event) => {
  const track = state.tracks[Number(event.target.dataset.track)];
  const control = event.target.dataset.control;
  if (!track || !control) return;
  const value = Number(event.target.value);
  if (!Number.isFinite(value)) return;
  if (control === 'gain') track.gainDb = value;
  if (control === 'pan') track.pan = value;
  if (control === 'eq-frequency') track.eqFrequencyHz = value;
  if (control === 'eq-gain') track.eqGainDb = value;
  if (control === 'eq-q') track.eqQ = value;
  applyTrack(track);
  const output = event.target.closest('.mix-control')?.querySelector('output');
  if (output) output.textContent = control === 'gain' ? `${value > 0 ? '+' : ''}${value.toFixed(1)} dB` : (value === 0 ? 'C' : `${value < 0 ? 'L' : 'R'}${Math.abs(value)}`);
});
els['daw-track-list'].addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const track = state.tracks[Number(button.dataset.track)];
  if (!track) return;
  if (button.dataset.action === 'mute') track.muted = !track.muted;
  if (button.dataset.action === 'solo') state.soloKey = state.soloKey === track.key ? null : track.key;
  if (button.dataset.action === 'analyze') return openAnalysis(Number(button.dataset.track));
  applyAllTracks();
  render();
});
