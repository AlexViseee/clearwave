const MAX_UPLOAD_BYTES = 1 * 1024 * 1024 * 1024;
const state = { tracks: [], context: null, master: null, playing: false, soloKey: null, pendingAnalysis: null, analyzingAll: false, eqEditingIndex: null, eqBandIndex: 0, playOffset: 0, startedAt: 0, progressFrame: 0 };
const els = Object.fromEntries([
  'stem-input', 'add-stems', 'session-summary', 'daw-genre', 'daw-premaster',
  'play-preview', 'pause-preview', 'stop-preview', 'playback-status', 'playback-progress', 'playback-time', 'empty-desk', 'daw-track-list',
  'daw-status', 'bounce-button', 'analyze-all', 'analysis-dialog',
  'analysis-track-name', 'analysis-results', 'analysis-suggestion-title', 'analysis-suggestion', 'apply-auto-eq', 'cancel-analysis', 'eq-dialog', 'eq-track-name', 'eq-band-tabs', 'eq-filter-type', 'eq-frequency', 'eq-gain', 'eq-q', 'eq-close', 'eq-curve-line',
].map((id) => [id, document.getElementById(id)]));

const bytes = (value) => value < 1024 * 1024 ? `${Math.round(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const keyFor = (file) => `${file.name}:${file.size}:${file.lastModified}`;
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const db = (value) => value <= 0 ? '−∞' : `${(20 * Math.log10(value)).toFixed(1)} dBFS`;
const hz = (value) => value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} kHz` : `${Math.round(value)} Hz`;
const defaultBands = () => [{ filterType: 'highpass', frequencyHz: 30, gainDb: 0, q: .71 }, { filterType: 'lowshelf', frequencyHz: 120, gainDb: 0, q: .71 }, { filterType: 'peaking', frequencyHz: 400, gainDb: 0, q: 1 }, { filterType: 'peaking', frequencyHz: 1800, gainDb: 0, q: 1 }, { filterType: 'highshelf', frequencyHz: 7000, gainDb: 0, q: .71 }, { filterType: 'lowpass', frequencyHz: 20000, gainDb: 0, q: .71 }];

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

function maxDuration() { return Math.max(0, ...state.tracks.map((track) => track.buffer.duration)); }
function formatTime(seconds) { return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`; }
function updateProgress() { const duration = maxDuration(); const position = state.playing ? Math.min(duration, state.playOffset + (context().currentTime - state.startedAt)) : state.playOffset; els['playback-progress'].value = duration ? (position / duration) * 100 : 0; els['playback-time'].textContent = `${formatTime(position)} / ${formatTime(duration)}`; if (state.playing && position < duration) state.progressFrame = requestAnimationFrame(updateProgress); else if (state.playing) stop(); }

function applyTrack(track) {
  if (!track.gainNode) return;
  const now = context().currentTime;
  track.gainNode.gain.setTargetAtTime(isAudible(track) ? 10 ** (track.gainDb / 20) : 0, now, 0.012);
  if (track.panNode.pan) track.panNode.pan.setTargetAtTime(track.pan / 100, now, 0.012);
  track.eqNodes.forEach((node, index) => { const band = track.eqBands[index]; node.type = band.filterType; node.frequency.setTargetAtTime(band.frequencyHz, now, .012); node.gain.setTargetAtTime(band.gainDb, now, .012); node.Q.setTargetAtTime(band.q, now, .012); });
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
    <span class="mix-track-actions"><button type="button" class="mix-solo ${soloed ? 'active' : ''}" data-track="${index}" data-action="solo">S</button><button type="button" class="mix-mute ${track.muted ? 'active' : ''}" data-track="${index}" data-action="mute">M</button><button type="button" class="mix-analyze" data-track="${index}" data-action="analyze">Analyze</button><button type="button" class="mix-eq" data-track="${index}" data-action="eq">EQ</button></span>
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
  els['analyze-all'].disabled = !state.tracks.length || state.analyzingAll;
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
    state.tracks.push(...decoded.map(({ file, buffer }) => ({ key: keyFor(file), file, buffer, gainDb: 0, pan: 0, muted: false, eqBands: defaultBands(), source: null, gainNode: null, panNode: null, eqNodes: [] })));
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
  const bands = defaultBands();
  const name = track.file.name.toLowerCase();
  if (/kick|bass|808/.test(name)) { bands[0].frequencyHz = 24; bands[2] = { filterType: 'peaking', frequencyHz: 280, gainDb: -2, q: 1.1 }; bands[3] = { filterType: 'peaking', frequencyHz: 2400, gainDb: 1.2, q: .8 }; }
  else if (/vocal|vox|lead/.test(name)) { bands[0].frequencyHz = 75; bands[2] = { filterType: 'peaking', frequencyHz: 320, gainDb: -1.5, q: 1.2 }; bands[3] = { filterType: 'peaking', frequencyHz: 3000, gainDb: 2, q: .9 }; bands[4].gainDb = 1.2; }
  else if (/hat|cymbal|shaker/.test(name)) { bands[0].frequencyHz = 250; bands[3] = { filterType: 'peaking', frequencyHz: 6500, gainDb: -1.5, q: 1.3 }; bands[5].frequencyHz = 18000; }
  else if (centroid < 1500) { bands[0].frequencyHz = 55; bands[3] = { filterType: 'peaking', frequencyHz: 4800, gainDb: 2.5, q: .8 }; bands[4].gainDb = 1.2; }
  else if (centroid > 5200) { bands[0].frequencyHz = 100; bands[3] = { filterType: 'peaking', frequencyHz: 4200, gainDb: -2.5, q: 1.1 }; }
  else { bands[0].frequencyHz = 65; bands[3] = { filterType: 'peaking', frequencyHz: 2200, gainDb: 1.2, q: .9 }; }
  const focus = bands[3];
  const suggestion = { bands, frequency: focus.frequencyHz, gain: focus.gainDb, q: focus.q, reason: `Independent spectral analysis of this stem selected a six-band EQ starting point, with focus around ${hz(focus.frequencyHz)}.` };
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
    state.pendingAnalysis = { mode: 'single', index, suggestion: analysis.suggestion };
    els['analysis-track-name'].textContent = track.file.name;
    els['analysis-results'].className = 'analysis-metrics mt-6';
    els['analysis-results'].innerHTML = `<div><span>Estimated level</span><strong>${analysis.loudness.toFixed(1)} dB</strong></div><div><span>Peak</span><strong>${db(analysis.peak)}</strong></div><div><span>Spectral centroid</span><strong>${hz(analysis.centroid)}</strong></div>`;
    els['analysis-suggestion-title'].textContent = 'Suggested auto master · parametric EQ';
    els['analysis-suggestion'].innerHTML = `<p>${analysis.suggestion.reason}</p><dl><div><dt>Hz</dt><dd>${hz(analysis.suggestion.frequency)}</dd></div><div><dt>Gain</dt><dd>${analysis.suggestion.gain > 0 ? '+' : ''}${analysis.suggestion.gain.toFixed(1)} dB</dd></div><div><dt>Res / Q</dt><dd>${analysis.suggestion.q.toFixed(1)}</dd></div></dl>`;
    els['apply-auto-eq'].textContent = 'Apply auto master';
    els['analysis-dialog'].showModal();
    status('Stem analysis is ready. Apply or cancel the proposed EQ.', 'success');
  }, 0);
}

async function openAnalysisAll() {
  if (!state.tracks.length || state.analyzingAll) return;
  state.analyzingAll = true;
  els['analyze-all'].disabled = true;
  status(`Analyzing all ${state.tracks.length} stems…`);
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  const entries = [];
  for (let index = 0; index < state.tracks.length; index += 1) {
    const track = state.tracks[index];
    const analysis = analyzeTrack(track);
    entries.push({ index, track, analysis, suggestion: analysis.suggestion });
    if (index < state.tracks.length - 1) await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  state.analyzingAll = false;
  els['analyze-all'].disabled = false;
  state.pendingAnalysis = { mode: 'all', entries };
  els['analysis-track-name'].textContent = `${entries.length} stems analyzed`;
  els['analysis-results'].className = 'analysis-all-results mt-6';
  els['analysis-results'].innerHTML = entries.map(({ track, analysis }) => `<div><strong title="${escapeHtml(track.file.name)}">${escapeHtml(track.file.name)}</strong><span>${analysis.loudness.toFixed(1)} dB · ${db(analysis.peak)} · ${hz(analysis.centroid)}</span></div>`).join('');
  els['analysis-suggestion-title'].textContent = 'Suggested auto masters · parametric EQ';
  els['analysis-suggestion'].innerHTML = `<p>Each suggestion is tailored to the tonal balance of its stem. Nothing changes until you apply all suggestions.</p><div class="analysis-all-suggestions">${entries.map(({ track, analysis }) => `<div><span title="${escapeHtml(track.file.name)}">${escapeHtml(track.file.name)}</span><strong>${hz(analysis.suggestion.frequency)} · ${analysis.suggestion.gain > 0 ? '+' : ''}${analysis.suggestion.gain.toFixed(1)} dB · Q ${analysis.suggestion.q.toFixed(1)}</strong></div>`).join('')}</div>`;
  els['apply-auto-eq'].textContent = `Apply auto master to ${entries.length} stems`;
  els['analysis-dialog'].showModal();
  status('All stem analyses are ready. Apply or cancel every suggested EQ.', 'success');
}

function applyAutoEq() {
  const pending = state.pendingAnalysis;
  if (!pending) return closeAnalysis();
  const entries = pending.mode === 'all' ? pending.entries : [{ index: pending.index, suggestion: pending.suggestion }];
  const updatedTracks = entries.map(({ index, suggestion }) => {
    const track = state.tracks[index];
    if (!track) return null;
    track.eqBands = suggestion.bands.map((band) => ({ ...band }));
    applyTrack(track);
    return track;
  }).filter(Boolean);
  closeAnalysis();
  render();
  status(updatedTracks.length === 1 ? `Auto EQ was applied to ${updatedTracks[0].file.name}.` : `Auto EQ was applied to ${updatedTracks.length} stems.`, 'success');
}

function renderEqEditor() {
  const track = state.tracks[state.eqEditingIndex];
  if (!track) return;
  const band = track.eqBands[state.eqBandIndex];
  els['eq-track-name'].textContent = track.file.name;
  els['eq-band-tabs'].innerHTML = track.eqBands.map((_, index) => `<button type="button" class="${index === state.eqBandIndex ? 'active' : ''}" data-eq-band="${index}">${index + 1}</button>`).join('');
  els['eq-filter-type'].value = band.filterType;
  els['eq-frequency'].value = band.frequencyHz;
  els['eq-gain'].value = band.gainDb;
  els['eq-q'].value = band.q;
  const points = Array.from({ length: 70 }, (_, index) => {
    const frequency = 20 * ((20000 / 20) ** (index / 69)); let gain = 0;
    track.eqBands.forEach((item) => { const distance = Math.log2(frequency / item.frequencyHz); if (item.filterType === 'highpass') gain += frequency < item.frequencyHz ? -18 * Math.min(1, -distance / 2) : 0; else if (item.filterType === 'lowpass') gain += frequency > item.frequencyHz ? -18 * Math.min(1, distance / 2) : 0; else if (item.filterType === 'lowshelf') gain += item.gainDb / (1 + Math.exp(distance * 5)); else if (item.filterType === 'highshelf') gain += item.gainDb / (1 + Math.exp(-distance * 5)); else gain += (item.filterType === 'notch' ? -Math.abs(item.gainDb || 6) : item.gainDb) * Math.exp(-((distance * item.q) ** 2)); });
    return `${(index / 69) * 100},${50 - Math.max(-20, Math.min(20, gain)) * 2}`;
  }).join(' ');
  els['eq-curve-line'].setAttribute('points', points);
}

function openEq(index) {
  state.eqEditingIndex = index;
  state.eqBandIndex = 0;
  renderEqEditor();
  els['eq-dialog'].showModal();
}

function updateEqBand() {
  const track = state.tracks[state.eqEditingIndex];
  if (!track) return;
  const band = track.eqBands[state.eqBandIndex];
  band.filterType = els['eq-filter-type'].value;
  band.frequencyHz = Number(els['eq-frequency'].value);
  band.gainDb = Number(els['eq-gain'].value);
  band.q = Number(els['eq-q'].value);
  applyTrack(track);
  renderEqEditor();
}

function clearSources() {
  cancelAnimationFrame(state.progressFrame);
  state.tracks.forEach((track) => {
    if (track.source) {
      try { track.source.stop(); } catch {}
      track.source.disconnect();
      track.source = null;
      track.gainNode = null;
      track.panNode = null;
      track.eqNodes = [];
    }
  });
}
function stop() {
  clearSources(); state.playOffset = 0;
  state.playing = false;
  els['pause-preview'].disabled = true;
  els['stop-preview'].disabled = true;
  els['play-preview'].textContent = '▶ Preview mix';
  updatePlaybackLabel();
  updateProgress();
}

function pause() {
  if (!state.playing) return;
  state.playOffset = Math.min(maxDuration(), state.playOffset + (context().currentTime - state.startedAt));
  clearSources(); state.playing = false;
  els['pause-preview'].disabled = true; els['stop-preview'].disabled = false;
  els['play-preview'].textContent = '▶ Resume'; updatePlaybackLabel(); updateProgress();
}

async function play() {
  if (!state.tracks.length) return;
  clearSources();
  const audio = context();
  await audio.resume();
  const start = audio.currentTime + 0.04;
  state.tracks.forEach((track) => {
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    const eqNodes = track.eqBands.map(() => audio.createBiquadFilter());
    const pan = audio.createStereoPanner ? audio.createStereoPanner() : audio.createGain();
    source.buffer = track.buffer;
    let chain = source.connect(gain);
    eqNodes.forEach((eq) => { chain = chain.connect(eq); });
    chain.connect(pan).connect(state.master);
    track.source = source;
    track.gainNode = gain;
    track.panNode = pan;
    track.eqNodes = eqNodes;
    applyTrack(track);
    source.start(start, state.playOffset);
  });
  state.playing = true;
  state.startedAt = start;
  els['play-preview'].textContent = '▶ Playing';
  els['pause-preview'].disabled = false;
  els['stop-preview'].disabled = false;
  updatePlaybackLabel();
  updateProgress();
}

function bounceSettings() {
  return state.tracks.map((track) => ({ gain_db: track.gainDb, pan: track.pan, muted: track.muted, eq_bands: track.eqBands.map((band) => ({ filter_type: band.filterType, frequency_hz: band.frequencyHz, gain_db: band.gainDb, q: band.q, enabled: true })) }));
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
els['pause-preview'].addEventListener('click', pause);
els['stop-preview'].addEventListener('click', stop);
els['playback-progress'].addEventListener('input', (event) => { const wasPlaying = state.playing; state.playOffset = maxDuration() * Number(event.target.value) / 100; if (wasPlaying) { clearSources(); state.playing = false; play(); } else updateProgress(); });
els['bounce-button'].addEventListener('click', bounce);
els['analyze-all'].addEventListener('click', () => openAnalysisAll().catch((error) => { state.analyzingAll = false; render(); status(error.message || 'The stems could not be analyzed.', 'error'); }));
els['apply-auto-eq'].addEventListener('click', applyAutoEq);
els['cancel-analysis'].addEventListener('click', closeAnalysis);
els['analysis-dialog'].querySelectorAll('[data-cancel-analysis]').forEach((button) => button.addEventListener('click', closeAnalysis));
els['analysis-dialog'].addEventListener('cancel', () => { state.pendingAnalysis = null; });
els['eq-close'].addEventListener('click', () => els['eq-dialog'].close());
els['eq-dialog'].addEventListener('cancel', () => { state.eqEditingIndex = null; });
els['eq-band-tabs'].addEventListener('click', (event) => { const button = event.target.closest('[data-eq-band]'); if (!button) return; updateEqBand(); state.eqBandIndex = Number(button.dataset.eqBand); renderEqEditor(); });
['eq-filter-type', 'eq-frequency', 'eq-gain', 'eq-q'].forEach((id) => els[id].addEventListener('input', updateEqBand));
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
  if (button.dataset.action === 'eq') return openEq(Number(button.dataset.track));
  applyAllTracks();
  render();
});
