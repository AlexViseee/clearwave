"""FastAPI application exposing upload, analysis, and mastering endpoints."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from dsp_engine import AudioProcessingError, analyze_file, master_file, supported_genres


BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
STORAGE_DIR = BASE_DIR / "storage"
UPLOADS_DIR = STORAGE_DIR / "uploads"
MASTERS_DIR = STORAGE_DIR / "masters"
for directory in (UPLOADS_DIR, MASTERS_DIR):
    directory.mkdir(parents=True, exist_ok=True)

MAX_UPLOAD_BYTES = 250 * 1024 * 1024

app = FastAPI(title="Local Audio Mastering API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000", "null"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CustomMasterSettings(BaseModel):
    highpass_hz: float = Field(25.0, ge=20.0, le=80.0)
    compressor_enabled: bool = True
    compressor_threshold_db: float = Field(-18.0, ge=-60.0, le=0.0)
    compressor_ratio: float = Field(3.0, ge=1.0, le=20.0)
    compressor_attack_ms: float = Field(10.0, ge=0.1, le=200.0)
    compressor_release_ms: float = Field(100.0, ge=10.0, le=1_000.0)
    high_shelf_frequency_hz: float = Field(10_000.0, ge=4_000.0, le=18_000.0)
    high_shelf_gain_db: float = Field(0.0, ge=-12.0, le=12.0)
    target_lufs: float = Field(-14.0, ge=-24.0, le=-6.0)
    max_makeup_gain_db: float = Field(12.0, ge=0.0, le=24.0)
    limiter_ceiling_dbtp: float = Field(-1.0, ge=-6.0, le=-0.1)


class MasterRequest(BaseModel):
    genre: str = Field(..., description="One of the supported mastering genres, or 'custom'")
    custom_settings: CustomMasterSettings | None = None


def _source_path(file_id: str) -> Path:
    if not file_id or any(char not in "0123456789abcdef-" for char in file_id.lower()):
        raise HTTPException(status_code=404, detail="File not found.")
    path = UPLOADS_DIR / f"{file_id}.wav"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File not found or expired.")
    return path


@app.get("/api/health")
def health() -> dict[str, object]:
    return {"status": "ok", "genres": supported_genres()}


@app.post("/api/upload", status_code=201)
async def upload_wav(request: Request, file: Annotated[UploadFile, File(...)]) -> dict[str, object]:
    filename = file.filename or ""
    if Path(filename).suffix.lower() != ".wav" or file.content_type not in {None, "audio/wav", "audio/x-wav", "audio/wave", "application/octet-stream"}:
        raise HTTPException(status_code=415, detail="Only WAV files are supported.")

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            declared_size = int(content_length)
        except ValueError:
            declared_size = 0
        if declared_size > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="The WAV is larger than the 250 MB upload limit.")

    file_id = str(uuid.uuid4())
    destination = UPLOADS_DIR / f"{file_id}.wav"
    total_bytes = 0
    try:
        with destination.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                total_bytes += len(chunk)
                if total_bytes > MAX_UPLOAD_BYTES:
                    output.close()
                    destination.unlink(missing_ok=True)
                    raise HTTPException(status_code=413, detail="The WAV is larger than the 250 MB upload limit.")
                output.write(chunk)
        # Decode once immediately so an extension cannot masquerade as audio.
        analysis = analyze_file(destination)
    except HTTPException:
        raise
    except (AudioProcessingError, OSError) as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        await file.close()

    return {
        "file_id": file_id,
        "filename": Path(filename).name,
        "bytes_received": total_bytes,
        "audio": {key: analysis[key] for key in ("sample_rate", "channels", "duration_seconds")},
    }


@app.get("/api/analyze/{file_id}")
def analyze(file_id: str, genre: str | None = None) -> dict[str, object]:
    source = _source_path(file_id)
    if genre is not None and genre.lower() not in {*supported_genres(), "custom"}:
        raise HTTPException(status_code=422, detail="Unsupported genre.")
    try:
        return {"file_id": file_id, **analyze_file(source, genre)}
    except AudioProcessingError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/master/{file_id}")
def master(file_id: str, payload: MasterRequest) -> dict[str, object]:
    source = _source_path(file_id)
    genre = payload.genre.lower().strip()
    if genre not in {*supported_genres(), "custom"}:
        raise HTTPException(status_code=422, detail=f"Unsupported genre. Valid options: {', '.join(supported_genres())}, custom.")
    if genre == "custom" and payload.custom_settings is None:
        raise HTTPException(status_code=422, detail="Custom mode requires custom_settings.")

    master_id = str(uuid.uuid4())
    destination = MASTERS_DIR / f"{master_id}.wav"
    try:
        settings = payload.custom_settings.model_dump() if payload.custom_settings else None
        result = master_file(source, destination, genre, settings)
    except AudioProcessingError as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {
        "file_id": file_id,
        "master_id": master_id,
        "download_url": f"/api/download/{master_id}",
        "stream_url": f"/api/stream/master/{master_id}",
        **result,
    }


@app.get("/api/download/{master_id}")
def download_master(master_id: str) -> FileResponse:
    path = MASTERS_DIR / f"{master_id}.wav"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Mastered file not found or expired.")
    return FileResponse(path, media_type="audio/wav", filename="mastered-{0}.wav".format(master_id))


@app.get("/api/stream/source/{file_id}")
def stream_source(file_id: str) -> FileResponse:
    return FileResponse(_source_path(file_id), media_type="audio/wav")


@app.get("/api/stream/master/{master_id}")
def stream_master(master_id: str) -> FileResponse:
    path = MASTERS_DIR / f"{master_id}.wav"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Mastered file not found or expired.")
    return FileResponse(path, media_type="audio/wav")


@app.delete("/api/files/{file_id}", status_code=204)
def delete_source_and_masters(file_id: str) -> None:
    """Optional cleanup endpoint for a browser session."""
    _source_path(file_id).unlink(missing_ok=True)
    # Masters use random IDs and are deliberately retained until the client
    # downloads them; a scheduled cleanup job can be added for long-running use.
    return None


# Mounted last so every /api route above remains available while a single
# Uvicorn process can serve the user interface at http://127.0.0.1:8000/.
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
