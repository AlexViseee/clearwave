# Clearwave

Clearwave is a local WAV mastering application with a dedicated stem-mixing workspace. It runs on your own computer: audio is processed in the local runtime only and is not sent to a third-party service.

## What it can do

### Master a finished mix

- Upload one mono or stereo WAV file, up to 1 GB.
- Analyze integrated loudness, true peak, loudness range and spectral centroid.
- Select a genre profile: EDM, House, Techno, Drum & Bass, Hip-Hop, Trap, R&B / Soul, Pop, Rock, Metal, Indie, Acoustic, Jazz, Country or Classical.
- Use Custom mode to directly control the high-pass filter, compressor, high shelf, loudness target, makeup gain and limiter ceiling.
- Preview source and master waveforms, then download the rendered WAV.

Every rendered master goes through the Release Quality Gate. It checks true peak, digital clipping, DC offset, loudness-target compliance and reports an advisory if the source itself was already clipped.

### Mix and master stems in DAW Lite

Open `/daw` to load a session of two to 32 aligned mono or stereo WAV stems, with a 1 GB total session limit.

- Per-stem gain, stereo pan, Solo and Mute.
- Live mix preview with pause, resume, stop, seekable playback bar and time display.
- A growing stem list: all loaded channels remain visible rather than being constrained to an inner scroll area.
- Optional per-stem pre-mastering with a chosen genre profile, or `None — mix only` to skip it.
- Bounce the complete session to one 24-bit WAV premaster, then open it automatically in the mastering workspace.

### PRO Master arrangement view

Open `PRO Master` from the home screen or DAW Lite when a session needs more than a static aligned-stem mix. It can start with a fresh stem upload, or it can bring over the currently loaded DAW Lite stem files, gain, pan, mute, EQ, pre-master profile and existing arrangement settings.

- A horizontal time ruler displays the real duration of every stem clip.
- Drag a clip to delay or place it in the session; drag its left or right edge to trim it.
- Every clip includes a lightweight waveform preview generated from its WAV audio.
- Use `Fit session` to fit the complete song in the timeline without horizontal scrolling, or use manual zoom controls for detailed editing.
- Gain, pan, Solo, Mute, Analyze and EQ are available beside each stem directly in the arrangement header; no duplicate mixer track list is shown in PRO Master.
- Add removable markers, loop the beginning of a session, run `Analyze all`, and use the shared preview transport directly above the timeline.
- Session setup, stem upload, optional per-stem pre-mastering, render status and the premaster action are placed above the arrangement.
- Playback, seeking and the 24-bit premaster bounce use the same clip placement, trim and channel settings, so an arrangement is not merely visual.
- `Sync to mixer` can return the current PRO Master settings to the DAW Lite window that opened it.

### Six-band per-stem EQ

Each stem has its own `EQ` window with six independently editable bands. For every band you can set:

- Filter type: Low cut, Low shelf, Bell, Notch, High shelf or High cut.
- Frequency (Hz).
- Gain (dB).
- Resonance / Q.

EQ changes are heard immediately in the preview, the curve updates as controls move, and the exact band settings are applied when the premaster is rendered.

### Stem analysis and auto EQ

- `Analyze` evaluates one stem and proposes a six-band starting point based on its own decoded audio and spectral balance.
- `Analyze all` prepares a review for every loaded stem at once.
- Suggestions take the stem's tonal content and common role cues such as kick/bass, vocal and cymbal stems into account.
- `Apply auto master` applies the proposed EQ only to the selected stem or all reviewed stems. `Cancel` leaves the existing EQ untouched.

## Run locally

Requirements: Python 3.10 or newer.

### Windows

```powershell
python -m pip install -r backend\requirements.txt
python -m uvicorn main:app --reload --app-dir backend --port 8001
```

Open <http://127.0.0.1:8001> for mastering, or <http://127.0.0.1:8001/daw> for DAW Lite.

If port 8001 is unavailable, choose another port. The frontend automatically uses the same port as the API.

### macOS

Clearwave supports both Apple Silicon and Intel Macs.

```bash
git clone https://github.com/AlexViseee/clearwave.git
cd clearwave
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
python -m uvicorn main:app --reload --app-dir backend --port 8001
```

For large or long sessions, 16 GB RAM is recommended; 32 GB or more is preferable because audio is decoded into memory for local analysis, preview and processing.

## Project structure

```text
backend/
  main.py          FastAPI API, upload handling and local file serving
  dsp_engine.py    Analysis, mastering, quality gate and stem rendering
  requirements.txt Python dependencies
frontend/
  index.html       Finished-mix mastering workspace
  app.js           Main workspace behaviour
  daw.html         DAW Lite stem-mixing workspace
  daw.js           Live playback, analysis, EQ and stem bounce behaviour
  style.css        Shared interface styling
```

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Return application status and supported genres. |
| `POST /api/upload` | Upload and validate a finished WAV. |
| `POST /api/upload-stems` | Upload aligned stems, apply optional per-stem processing/EQ and create one premaster. |
| `GET /api/analyze/{file_id}` | Return non-destructive diagnostics for an uploaded mix. |
| `POST /api/master/{file_id}` | Render a genre-profile or custom master and quality-gate it. |
| `GET /api/download/{master_id}` | Download a mastered WAV. |

Interactive API documentation is available at `/docs` while the server is running.

## Git policy

Runtime audio, local environments, secrets and editor-specific files are ignored. Source code, dependency definitions and this documentation are safe to commit.
