# Clearwave

Clearwave is a local web application for analysing and automatically mastering lossless WAV files. Audio processing happens on your computer: uploaded files are stored only in the local runtime directory and are never sent to a third-party service.

## Features

- WAV upload with validation and a 250 MB limit
- Loudness, true-peak, loudness-range, and spectral-centroid diagnostics
- Genre-tuned Pedalboard mastering profiles for EDM, Hip-Hop, Rock, Pop, Classical, and Acoustic
- Custom mastering mode with controls for the high-pass filter, compressor, high shelf, loudness target, makeup-gain limit, and limiter ceiling
- Before/after waveform playback and mastered WAV download

## Run locally

Requirements: Python 3.10 or newer.

```powershell
python -m pip install -r backend\requirements.txt
python -m uvicorn main:app --reload --app-dir backend --port 8001
```

Open <http://127.0.0.1:8001> in your browser. If port 8001 is unavailable, replace it with another available port; the frontend automatically uses the same port as the API.

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
| `GET /api/analyze/{file_id}` | Return non-destructive audio diagnostics. |
| `POST /api/master/{file_id}` | Create a genre or custom-settings master. |
| `GET /api/download/{master_id}` | Download a mastered WAV. |

Interactive endpoint documentation is available at `/docs` while the server is running.

## Git policy

Runtime audio, local environments, secrets, and editor-specific files are ignored. Source, dependency definitions, and project documentation are safe to commit.
