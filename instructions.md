Project: Local Web Application for Automated Audio Mastering (.wav)
1. System Persona & Objective
You are an elite Full-Stack Software Engineer and Audio DSP Expert. Your task is to build a complete, production-ready local web application for automated audio mastering and diagnostics of high-resolution lossless .wav files. The application must run locally, providing a modern web interface for users to upload audio, select target genres, view diagnostics, and download the mastered tracks.

2. Technology Stack
Backend:

Framework: FastAPI (Python) for handling asynchronous file uploads and API endpoints.

Audio DSP: pedalboard (by Spotify) for C++ backend signal processing.

Analysis: librosa for feature extraction and pyloudnorm for ITU-R BS.1770-4 standard LUFS metering.

File Handling: soundfile / scipy.io.wavfile (ensure 24-bit/32-bit float support).

Frontend:

HTML5 / Vanilla JavaScript (ES6 Modules).

CSS Framework: Tailwind CSS (via CDN for local simplicity).

Visualization: Wavesurfer.js for interactive audio waveform visualization.

3. Expected Directory Structure
Generate the code to fit the following structure:text
/mastering-app
├── backend/
│   ├── main.py          # FastAPI server and endpoints
│   ├── dsp_engine.py    # Audio processing and analysis logic
│   └── requirements.txt # Python dependencies
├── frontend/
│   ├── index.html       # Main UI
│   ├── app.js           # Frontend logic and API calls
│   └── style.css        # Custom overrides (if any)
└── instructions.md


## 4. Backend Specifications (API & DSP Logic)
Implement RESTful endpoints in `main.py`:
- `POST /api/upload`: Accepts a `.wav` file, saves it to a local temporary directory, and returns a session/file ID.
- `GET /api/analyze/{file_id}`: Performs non-destructive analysis and returns JSON with metrics:
  - LUFS (Integrated)
  - True Peak (dBTP)
  - Loudness Range (LRA)
  - Spectral Centroid
  - Actionable feedback (e.g., "Mix is too dynamic for EDM, compression needed").
- `POST /api/master/{file_id}`: Processes the audio based on a selected `genre` payload.

**The DSP Mastering Chain (`dsp_engine.py`):**
Must use `pedalboard.Pedalboard`. The chain order is strict:
1. **HighpassFilter:** 25Hz (removes subsonic rumble).
2. **Compressor:** Dynamically configured based on the `genre` payload (e.g., fast attack for 'EDM', slow attack for 'Jazz', bypassed for 'Classical').
3. **HighShelfFilter:** Fixed at 10kHz, gain dynamically calculated inversely to the Spectral Centroid (add 'air' if the mix is dark).
4. **Gain:** Automated makeup gain calculated to hit a genre-specific LUFS target (e.g., -14 LUFS).
5. **Limiter:** Hard ceiling at -1.0 dBTP to prevent inter-sample clipping on DAC conversion.

## 5. Frontend Specifications (UI/UX)
Create a modern, dark-mode single-page application in `index.html` and `app.js`.
**Features:**
- **Drag & Drop Zone:** For `.wav` file uploads.
- **Waveform Viewer:** Initialize `Wavesurfer.js` to render the uploaded file.
- **Control Panel:** 
  - A dropdown menu to select the musical genre (EDM, Hip-Hop, Rock, Pop, Classical, Acoustic).
  - Two primary buttons: "Analyze Only" and "Automaster".
- **Dashboard/Results Area:** 
  - Display diagnostic JSON data in a clean, readable UI using Tailwind cards.
  - Upon successful mastering, render a second `Wavesurfer.js` instance for the mastered track so the user can A/B test (Before/After).
  - Provide a highly visible "Download Mastered WAV" button.

## 6. Execution & Quality Constraints
- Write robust error handling. Do not crash the server if the uploaded file is not a valid `.wav`.
- Memory Management: Ensure the DSP engine deletes temporary files or handles I/O efficiently using streaming or buffering if files are larger than 50MB.
- Return fully complete files (`main.py`, `dsp_engine.py`, `index.html`, `app.js`). Do not use placeholders like `// Add logic