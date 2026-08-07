# Clearwave

Clearwave is a local web application for analysing and automatically mastering lossless WAV files. Audio processing happens on your computer: uploaded files are stored only in the local runtime directory and are never sent to a third-party service.

## Features

- WAV upload with validation and a 1 GB limit
- Stem-session upload for two to 32 aligned mono/stereo WAVs, mixed locally into a headroom-safe premaster
- Separate DAW Lite Mix Desk for stem sessions: live per-track solo, gain, stereo pan, mute and parametric EQ (Hz, gain, resonance/Q), single-stem or all-stem analysis with apply-or-cancel auto-EQ suggestions, optional per-stem pre-mastering (or None), and server-side bounce to one WAV
- Loudness, true-peak, loudness-range, and spectral-centroid diagnostics
- Genre-tuned Pedalboard mastering profiles for EDM, House, Techno, Drum & Bass, Hip-Hop, Trap, R&B / Soul, Pop, Rock, Metal, Indie, Acoustic, Jazz, Country, and Classical
- Custom mastering mode with controls for the high-pass filter, compressor, high shelf, loudness target, makeup-gain limit, and limiter ceiling
- Release Quality Gate on every master: true-peak ceiling, digital-clipping scan, DC-offset check, loudness-target check, and source-clipping advisory
- Before/after waveform playback and mastered WAV download

## Run locally

Requirements: Python 3.10 or newer.

```powershell
python -m pip install -r backend\requirements.txt
python -m uvicorn main:app --reload --app-dir backend --port 8001
```

Open <http://127.0.0.1:8001> in your browser. If port 8001 is unavailable, replace it with another available port; the frontend automatically uses the same port as the API.

### macOS

Clearwave runs on both Apple Silicon and Intel Macs. Install Python 3.10 or newer, then run:

```bash
git clone https://github.com/AlexViseee/clearwave.git
cd clearwave
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
python -m uvicorn main:app --reload --app-dir backend --port 8001
```

Open <http://127.0.0.1:8001>. For large WAV or stem sessions, use a Mac with at least 16 GB RAM; 32 GB or more is recommended for long high-resolution sessions because the current DSP pipeline keeps audio in memory while it analyses and masters it.

## Project structure

```text
backend/
  main.py          FastAPI endpoints and local static-file server
  dsp_engine.py    Diagnostics and Pedalboard mastering chain
  requirements.txt Python dependencies
frontend/
  index.html       Single-page interface
  app.js           Upload, API, waveform, and custom-control logic
  style.css        Custom visual styling
```

## API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/upload` | Upload and validate a WAV file. |
| `POST /api/upload-stems` | Upload aligned WAV stems and create one local premaster mix. |
| `GET /api/analyze/{file_id}` | Return non-destructive audio diagnostics. |
| `POST /api/master/{file_id}` | Create a genre or custom-settings master. |
| `GET /api/download/{master_id}` | Download a mastered WAV. |

Interactive endpoint documentation is available at `/docs` while the server is running.

## Git policy

Runtime audio, local environments, secrets, and editor-specific files are ignored. Source, dependency definitions, and project documentation are safe to commit.
