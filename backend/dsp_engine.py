"""Audio analysis and mastering helpers for the local mastering application.

All audio is kept as floating-point samples while it is being analysed and
processed.  Files are only decoded/encoded at the edge of the application so
24-bit WAV input is handled without the integer arithmetic pitfalls of the
standard ``wave`` module.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import librosa
import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from pedalboard import (
    Compressor,
    Gain,
    HighpassFilter,
    HighShelfFilter,
    Limiter,
    Pedalboard,
)
from scipy.signal import resample_poly


class AudioProcessingError(RuntimeError):
    """Raised when an input WAV cannot safely be analysed or mastered."""


@dataclass(frozen=True)
class GenreProfile:
    target_lufs: float
    compressor_threshold_db: float | None
    compressor_ratio: float | None
    attack_ms: float | None
    release_ms: float | None
    max_makeup_gain_db: float
    feedback: str


GENRE_PROFILES: dict[str, GenreProfile] = {
    "edm": GenreProfile(-9.0, -20.0, 4.0, 5.0, 80.0, 14.0, "A dense, controlled master suits EDM."),
    "hip-hop": GenreProfile(-10.0, -18.0, 3.0, 12.0, 110.0, 12.0, "Keep the low end focused and vocals forward."),
    "rock": GenreProfile(-10.0, -18.0, 2.5, 18.0, 130.0, 12.0, "Moderate bus compression preserves guitar impact."),
    "pop": GenreProfile(-10.0, -19.0, 3.0, 10.0, 100.0, 12.0, "A polished, even dynamic profile suits pop."),
    "classical": GenreProfile(-16.0, None, None, None, None, 6.0, "Dynamics are preserved for classical material."),
    "acoustic": GenreProfile(-14.0, -24.0, 1.5, 30.0, 180.0, 7.0, "Gentle compression retains the natural performance."),
}


def supported_genres() -> list[str]:
    return list(GENRE_PROFILES)


def _read_audio(path: str | Path) -> tuple[np.ndarray, int]:
    """Read a WAV as channel-major float32 audio and validate its contents."""
    try:
        samples, sample_rate = sf.read(str(path), dtype="float32", always_2d=True)
    except (RuntimeError, OSError, ValueError) as exc:
        raise AudioProcessingError("The file could not be decoded as a WAV file.") from exc

    if sample_rate < 8_000 or sample_rate > 384_000:
        raise AudioProcessingError("The WAV has an unsupported sample rate.")
    if samples.size == 0 or samples.shape[0] == 0:
        raise AudioProcessingError("The WAV contains no audio samples.")
    if not np.isfinite(samples).all():
        raise AudioProcessingError("The WAV contains invalid audio samples.")

    # soundfile returns (frames, channels); Pedalboard expects (channels, frames).
    return np.ascontiguousarray(samples.T), int(sample_rate)


def _mono(audio: np.ndarray) -> np.ndarray:
    return np.mean(audio, axis=0, dtype=np.float64)


def _integrated_lufs(audio: np.ndarray, sample_rate: int) -> float:
    # pyloudnorm needs at least one 400 ms block.  Short upload previews get a
    # transparent RMS estimate instead of causing a 500 error.
    mono = _mono(audio)
    if len(mono) < max(1, int(sample_rate * 0.4)):
        rms = float(np.sqrt(np.mean(np.square(mono))))
        return -70.0 if rms <= 0 else max(-70.0, 20.0 * math.log10(rms))
    try:
        # Preserve channel information for the BS.1770 channel summing step.
        value = float(pyln.Meter(sample_rate).integrated_loudness(np.ascontiguousarray(audio.T)))
        return value if math.isfinite(value) else -70.0
    except (ValueError, RuntimeError):
        return -70.0


def _true_peak_dbtp(audio: np.ndarray) -> float:
    """Estimate true peak with 4x polyphase oversampling."""
    oversampled = resample_poly(audio.astype(np.float64, copy=False), up=4, down=1, axis=1)
    peak = float(np.max(np.abs(oversampled)))
    return -120.0 if peak <= 0 else 20.0 * math.log10(peak)


def _loudness_range(audio: np.ndarray, sample_rate: int) -> float:
    """Approximate EBU LRA from 3-second sliding loudness blocks.

    pyloudnorm provides BS.1770 integrated loudness, but not an LRA helper.
    This follows the useful percentile/gating behaviour of EBU Tech 3342 while
    remaining reliable for short local uploads.
    """
    mono = _mono(audio)
    block = int(sample_rate * 3.0)
    hop = int(sample_rate * 1.0)
    if len(mono) < block:
        return 0.0
    loudness: list[float] = []
    for start in range(0, len(mono) - block + 1, hop):
        rms = float(np.sqrt(np.mean(np.square(mono[start : start + block]))))
        if rms > 0:
            loudness.append(20.0 * math.log10(rms))
    if len(loudness) < 2:
        return 0.0
    values = np.asarray(loudness)
    gated = values[values >= max(-70.0, float(np.mean(values)) - 20.0)]
    if len(gated) < 2:
        return 0.0
    return float(max(0.0, np.percentile(gated, 95) - np.percentile(gated, 10)))


def _spectral_centroid_hz(audio: np.ndarray, sample_rate: int) -> float:
    """Calculate the mean spectral centroid from bounded Hann-windowed FFTs.

    This is the same frequency-weighted magnitude feature exposed by Librosa.
    It is implemented locally because some Windows Librosa/Numba combinations
    can spend minutes compiling the helper on first use, which is unsuitable
    for an interactive local upload endpoint.
    """
    mono = _mono(audio).astype(np.float64, copy=False)
    if len(mono) < 32:
        return 0.0
    # A three-minute representative excerpt caps response time and memory for
    # long high-resolution files while retaining enough frames for diagnostics.
    mono = mono[: min(len(mono), sample_rate * 180)]
    n_fft = min(2_048, len(mono))
    hop = max(1, n_fft // 2)
    window = np.hanning(n_fft)
    frequencies = np.fft.rfftfreq(n_fft, d=1.0 / sample_rate)
    numerator = 0.0
    denominator = 0.0
    for start in range(0, len(mono) - n_fft + 1, hop):
        magnitude = np.abs(np.fft.rfft(mono[start : start + n_fft] * window))
        energy = float(np.sum(magnitude))
        if energy:
            numerator += float(np.dot(frequencies, magnitude))
            denominator += energy
    return numerator / denominator if denominator else 0.0


def _feedback(metrics: dict[str, float], genre: str | None) -> list[str]:
    notes: list[str] = []
    profile = GENRE_PROFILES.get(genre or "")
    lufs = metrics["integrated_lufs"]
    lra = metrics["loudness_range_lu"]
    centroid = metrics["spectral_centroid_hz"]
    peak = metrics["true_peak_dbtp"]

    if profile and lufs < profile.target_lufs - 5:
        notes.append(f"The mix is quieter than the {genre.upper()} target; controlled gain will be applied.")
    if profile and lra > (10.0 if genre in {"edm", "hip-hop", "pop"} else 14.0):
        notes.append(f"Mix is very dynamic for {genre.upper()}; gentle compression may improve consistency.")
    if centroid < 1_600:
        notes.append("The mix is relatively dark; the mastering chain will add a small amount of air.")
    elif centroid > 4_500:
        notes.append("The mix is already bright; no high-frequency lift is recommended.")
    if peak > -1.0:
        notes.append("True peak is above the recommended -1.0 dBTP ceiling; limiting is recommended.")
    if not notes:
        notes.append(profile.feedback if profile else "The mix is within a healthy range for mastering.")
    return notes


def analyze_file(path: str | Path, genre: str | None = None) -> dict[str, Any]:
    """Return JSON-serialisable diagnostics without modifying the source file."""
    audio, sample_rate = _read_audio(path)
    metrics = {
        "integrated_lufs": round(_integrated_lufs(audio, sample_rate), 2),
        "true_peak_dbtp": round(_true_peak_dbtp(audio), 2),
        "loudness_range_lu": round(_loudness_range(audio, sample_rate), 2),
        "spectral_centroid_hz": round(_spectral_centroid_hz(audio, sample_rate), 1),
    }
    return {
        "sample_rate": sample_rate,
        "channels": int(audio.shape[0]),
        "duration_seconds": round(audio.shape[1] / sample_rate, 3),
        "metrics": metrics,
        "feedback": _feedback(metrics, genre.lower() if genre else None),
    }


def _air_gain_db(spectral_centroid_hz: float) -> float:
    """Choose a restrained 10 kHz shelf boost for dark material."""
    return float(np.clip((2_800.0 - spectral_centroid_hz) / 400.0, 0.0, 4.0))


def master_file(
    source_path: str | Path,
    destination_path: str | Path,
    genre: str,
    custom_settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Master ``source_path`` and write a 24-bit WAV to ``destination_path``.

    The chain is intentionally built in this exact order: high-pass,
    compressor, high-shelf, gain, limiter.
    """
    normalized_genre = genre.strip().lower()
    profile = GENRE_PROFILES.get(normalized_genre)
    is_custom = normalized_genre == "custom"
    if profile is None and not is_custom:
        allowed = ", ".join(supported_genres())
        raise AudioProcessingError(f"Unsupported genre. Choose one of: {allowed}.")
    if is_custom and custom_settings is None:
        raise AudioProcessingError("Custom mastering settings are required for Custom mode.")

    audio, sample_rate = _read_audio(source_path)
    before = analyze_file(source_path, normalized_genre)
    centroid = float(before["metrics"]["spectral_centroid_hz"])

    settings = custom_settings or {}
    # Custom requests always contain these values after API validation.  The
    # fallback keeps direct library use safe as well.
    defaults = profile or GenreProfile(-14.0, -18.0, 3.0, 10.0, 100.0, 12.0, "")
    highpass_hz = float(settings.get("highpass_hz", 25.0))
    shelf_frequency_hz = float(settings.get("high_shelf_frequency_hz", 10_000.0))
    air_gain_db = float(settings.get("high_shelf_gain_db", _air_gain_db(centroid)))
    compressor_enabled = bool(settings.get("compressor_enabled", defaults.compressor_threshold_db is not None))
    target_lufs = float(settings.get("target_lufs", defaults.target_lufs))
    max_makeup_gain_db = float(settings.get("max_makeup_gain_db", defaults.max_makeup_gain_db))
    limiter_ceiling_dbtp = float(settings.get("limiter_ceiling_dbtp", -1.0))

    plugins: list[Any] = [HighpassFilter(cutoff_frequency_hz=highpass_hz)]
    if compressor_enabled:
        plugins.append(
            Compressor(
                threshold_db=float(settings.get("compressor_threshold_db", defaults.compressor_threshold_db)),
                ratio=float(settings.get("compressor_ratio", defaults.compressor_ratio)),
                attack_ms=float(settings.get("compressor_attack_ms", defaults.attack_ms)),
                release_ms=float(settings.get("compressor_release_ms", defaults.release_ms)),
            )
        )
    plugins.append(HighShelfFilter(cutoff_frequency_hz=shelf_frequency_hz, gain_db=air_gain_db))

    # Measure after the tone/dynamics processors, then calculate makeup gain.
    pre_gain = Pedalboard(plugins)(audio, sample_rate)
    current_lufs = _integrated_lufs(pre_gain, sample_rate)
    makeup_gain = float(np.clip(target_lufs - current_lufs, -12.0, max_makeup_gain_db))
    plugins.extend([Gain(gain_db=makeup_gain), Limiter(threshold_db=limiter_ceiling_dbtp)])

    try:
        mastered = Pedalboard(plugins)(audio, sample_rate)
        sf.write(str(destination_path), mastered.T, sample_rate, subtype="PCM_24")
    except (RuntimeError, OSError, ValueError) as exc:
        raise AudioProcessingError("Mastering failed while processing the WAV file.") from exc

    after = analyze_file(destination_path, normalized_genre)
    return {
        "genre": normalized_genre,
        "target_lufs": target_lufs,
        "applied_makeup_gain_db": round(makeup_gain, 2),
        "applied_air_gain_db": round(air_gain_db, 2),
        "settings": {
            "highpass_hz": highpass_hz,
            "compressor_enabled": compressor_enabled,
            "high_shelf_frequency_hz": shelf_frequency_hz,
            "high_shelf_gain_db": air_gain_db,
            "limiter_ceiling_dbtp": limiter_ceiling_dbtp,
        },
        "before": before,
        "after": after,
    }
