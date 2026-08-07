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
    LowShelfFilter,
    LowpassFilter,
    Limiter,
    Pedalboard,
    PeakFilter,
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
    # Electronic
    "edm": GenreProfile(-9.0, -20.0, 4.0, 5.0, 80.0, 14.0, "A dense, controlled master suits EDM."),
    "house": GenreProfile(-9.0, -19.0, 3.0, 8.0, 95.0, 13.0, "A firm, rhythmic master supports a four-on-the-floor groove."),
    "techno": GenreProfile(-9.0, -19.0, 4.0, 4.0, 75.0, 14.0, "Fast control keeps the low-end pulse focused for techno."),
    "drum-and-bass": GenreProfile(-8.5, -18.0, 4.0, 3.0, 70.0, 15.0, "A tight, high-energy profile suits fast drum and bass."),
    # Urban / pop
    "hip-hop": GenreProfile(-10.0, -18.0, 3.0, 12.0, 110.0, 12.0, "Keep the low end focused and vocals forward."),
    "trap": GenreProfile(-9.0, -17.0, 4.0, 6.0, 100.0, 13.0, "Fast compression adds consistency while keeping 808s powerful."),
    "rnb": GenreProfile(-11.0, -22.0, 2.0, 18.0, 150.0, 10.0, "Smooth, gentle control keeps the vocal and groove intimate."),
    "rock": GenreProfile(-10.0, -18.0, 2.5, 18.0, 130.0, 12.0, "Moderate bus compression preserves guitar impact."),
    "metal": GenreProfile(-9.0, -17.0, 4.0, 8.0, 95.0, 13.0, "Firm control helps dense guitars and drums remain defined."),
    "pop": GenreProfile(-10.0, -19.0, 3.0, 10.0, 100.0, 12.0, "A polished, even dynamic profile suits pop."),
    "indie": GenreProfile(-11.0, -21.0, 2.0, 20.0, 160.0, 10.0, "Moderate dynamics retain the character of an indie mix."),
    # Organic
    "classical": GenreProfile(-16.0, None, None, None, None, 6.0, "Dynamics are preserved for classical material."),
    "acoustic": GenreProfile(-14.0, -24.0, 1.5, 30.0, 180.0, 7.0, "Gentle compression retains the natural performance."),
    "jazz": GenreProfile(-14.0, -25.0, 1.5, 35.0, 240.0, 7.0, "Slow, gentle compression preserves the feel of a jazz ensemble."),
    "country": GenreProfile(-12.0, -22.0, 2.0, 22.0, 170.0, 9.0, "Natural transients and vocal clarity suit country recordings."),
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


def mix_stem_files(
    stem_paths: list[str | Path],
    destination_path: str | Path,
    track_settings: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Create one headroom-safe mix from aligned mono/stereo WAV stems.

    Stems are assumed to begin at the same musical zero point.  Shorter stems
    are padded with silence; mono stems are duplicated into a stereo session.
    All stems must share a sample rate so no hidden resampling changes a mix.
    """
    if len(stem_paths) < 2:
        raise AudioProcessingError("A stem session needs at least two WAV files.")

    decoded = [_read_audio(path) for path in stem_paths]
    sample_rates = {sample_rate for _, sample_rate in decoded}
    if len(sample_rates) != 1:
        raise AudioProcessingError("All stems must use the same sample rate before they can be mixed.")
    if any(audio.shape[0] > 2 for audio, _ in decoded):
        raise AudioProcessingError("Only mono and stereo stems are supported.")

    sample_rate = sample_rates.pop()
    # A DAW mix bus is always stereo: this lets mono stems use meaningful pan.
    output_channels = 2
    settings_list = track_settings or [{} for _ in decoded]
    if len(settings_list) != len(decoded):
        raise AudioProcessingError("Every stem needs one set of mix controls.")
    arranged_stems: list[tuple[np.ndarray, dict[str, Any], int]] = []
    for (audio, _), settings in zip(decoded, settings_list):
        clip_start = int(round(float(settings.get("clip_start_seconds", 0.0)) * sample_rate))
        raw_end = settings.get("clip_end_seconds")
        clip_end = audio.shape[1] if raw_end is None else int(round(float(raw_end) * sample_rate))
        clip_start = int(np.clip(clip_start, 0, audio.shape[1]))
        clip_end = int(np.clip(clip_end, clip_start, audio.shape[1]))
        if clip_end <= clip_start:
            raise AudioProcessingError("A PRO Master clip trim removes an entire stem.")
        timeline_start = int(round(float(settings.get("timeline_start_seconds", 0.0)) * sample_rate))
        arranged_stems.append((audio[:, clip_start:clip_end], settings, max(0, timeline_start)))
    max_frames = max(offset + audio.shape[1] for audio, _, offset in arranged_stems)
    mix = np.zeros((output_channels, max_frames), dtype=np.float32)
    active_stems = 0
    for audio, settings, timeline_start in arranged_stems:
        if bool(settings.get("muted", False)):
            continue
        active_stems += 1
        was_mono = audio.shape[0] == 1
        processed = np.array(audio, dtype=np.float32, copy=True)
        eq_bands = settings.get("eq_bands") or []
        if eq_bands:
            plugins = []
            for band in eq_bands:
                if not bool(band.get("enabled", True)):
                    continue
                kind = str(band.get("filter_type", "peaking"))
                frequency = float(band.get("frequency_hz", 1_000.0))
                gain = float(band.get("gain_db", 0.0))
                q = float(band.get("q", 0.7))
                if kind == "highpass": plugins.append(HighpassFilter(cutoff_frequency_hz=frequency))
                elif kind == "lowpass": plugins.append(LowpassFilter(cutoff_frequency_hz=frequency))
                elif kind == "lowshelf": plugins.append(LowShelfFilter(cutoff_frequency_hz=frequency, gain_db=gain, q=q))
                elif kind == "highshelf": plugins.append(HighShelfFilter(cutoff_frequency_hz=frequency, gain_db=gain, q=q))
                else: plugins.append(PeakFilter(cutoff_frequency_hz=frequency, gain_db=(-abs(gain) if kind == "notch" else gain), q=q))
            if plugins:
                processed = Pedalboard(plugins)(processed, sample_rate)
        else:
            eq_gain_db = float(settings.get("eq_gain_db", 0.0))
            if abs(eq_gain_db) > 1e-6:
            # The DAW's live peaking EQ is rendered here as the same bell
            # filter, so the bounced premaster matches the audition.
                eq = Pedalboard([PeakFilter(cutoff_frequency_hz=float(settings.get("eq_frequency_hz", 1_000.0)), gain_db=eq_gain_db, q=float(settings.get("eq_q", 0.7)))])
                processed = eq(processed, sample_rate)
        if output_channels == 2 and was_mono:
            processed = np.repeat(processed, 2, axis=0)
        gain = float(10 ** (float(settings.get("gain_db", 0.0)) / 20.0))
        processed *= gain
        if output_channels == 2:
            # Equal-power pan for mono material; balance control for stereo.
            pan = float(np.clip(float(settings.get("pan", 0.0)), -100.0, 100.0)) / 100.0
            if was_mono:
                processed[0] *= math.cos((pan + 1.0) * math.pi / 4.0)
                processed[1] *= math.sin((pan + 1.0) * math.pi / 4.0)
            elif pan < 0:
                processed[1] *= 1.0 + pan
            elif pan > 0:
                processed[0] *= 1.0 - pan
        mix[:, timeline_start : timeline_start + processed.shape[1]] += processed

    if active_stems == 0:
        raise AudioProcessingError("At least one stem must be audible in the mix.")

    peak = float(np.max(np.abs(mix)))
    # Reserve 3 dB before the mastering chain, preventing a summed session
    # from clipping before its compressor and limiter are reached.
    pre_master_gain_db = 0.0
    if peak > 0:
        desired_peak = 10 ** (-3.0 / 20.0)
        if peak > desired_peak:
            gain = desired_peak / peak
            mix *= gain
            pre_master_gain_db = 20.0 * math.log10(gain)

    try:
        sf.write(str(destination_path), mix.T, sample_rate, subtype="PCM_24")
    except (RuntimeError, OSError, ValueError) as exc:
        raise AudioProcessingError("The stem session could not be written as a WAV mix.") from exc
    return {
        "sample_rate": sample_rate,
        "channels": output_channels,
        "duration_seconds": round(max_frames / sample_rate, 3),
        "stem_count": len(stem_paths),
        "active_stems": active_stems,
        "pre_master_gain_db": round(pre_master_gain_db, 2),
    }


def _air_gain_db(spectral_centroid_hz: float) -> float:
    """Choose a restrained 10 kHz shelf boost for dark material."""
    return float(np.clip((2_800.0 - spectral_centroid_hz) / 400.0, 0.0, 4.0))


def _longest_true_run(values: np.ndarray) -> int:
    """Return the longest consecutive True sequence without Python sample loops."""
    if not np.any(values):
        return 0
    padded = np.concatenate(([False], values, [False]))
    changes = np.flatnonzero(padded[1:] != padded[:-1])
    return int(np.max(changes[1::2] - changes[::2]))


def _quality_gate(path: str | Path, target_lufs: float, source_audio: np.ndarray) -> dict[str, Any]:
    """Run release-blocking technical checks on the rendered master."""
    audio, sample_rate = _read_audio(path)
    true_peak = _true_peak_dbtp(audio)
    sample_peak = float(np.max(np.abs(audio)))
    near_full_scale = np.abs(audio) >= 0.999
    clipped_samples = int(np.count_nonzero(near_full_scale))
    longest_clipped_run = _longest_true_run(np.any(near_full_scale, axis=0))
    dc_offset = float(np.max(np.abs(np.mean(audio, axis=1))))
    measured_lufs = _integrated_lufs(audio, sample_rate)

    source_near_full = np.abs(source_audio) >= 0.999
    source_clip_runs = _longest_true_run(np.any(source_near_full, axis=0))
    checks = [
        {
            "id": "true_peak",
            "label": "True-peak ceiling",
            "status": "passed" if true_peak <= -1.0 else "failed",
            "value": round(true_peak, 2),
            "unit": "dBTP",
            "limit": "≤ -1.0 dBTP",
            "message": "Safe DAC headroom is preserved." if true_peak <= -1.0 else "True peak exceeds the release ceiling.",
        },
        {
            "id": "digital_clipping",
            "label": "Digital clipping scan",
            "status": "passed" if clipped_samples == 0 else "failed",
            "value": clipped_samples,
            "unit": "samples",
            "limit": "0 clipped samples",
            "message": "No full-scale clipping detected." if clipped_samples == 0 else f"{longest_clipped_run} consecutive full-scale samples detected.",
        },
        {
            "id": "dc_offset",
            "label": "DC offset",
            "status": "passed" if dc_offset <= 0.02 else "warning",
            "value": round(dc_offset * 100, 3),
            "unit": "%",
            "limit": "≤ 2.0%",
            "message": "No material DC bias detected." if dc_offset <= 0.02 else "A noticeable DC bias remains in the render.",
        },
        {
            "id": "loudness_target",
            "label": "Loudness target",
            "status": "passed" if abs(measured_lufs - target_lufs) <= 2.0 else "warning",
            "value": round(measured_lufs, 2),
            "unit": "LUFS",
            "limit": f"{target_lufs:.1f} LUFS ±2",
            "message": "The rendered loudness is within the selected target window." if abs(measured_lufs - target_lufs) <= 2.0 else "The limiter or source dynamics kept the render outside the target window.",
        },
        {
            "id": "source_clipping_history",
            "label": "Source clipping history",
            "status": "warning" if source_clip_runs >= 3 else "passed",
            "value": source_clip_runs,
            "unit": "sample run",
            "limit": "No sustained full-scale runs",
            "message": "No sustained clipping was found in the source." if source_clip_runs < 3 else "The source appears to contain existing clipping; mastering cannot fully restore lost detail.",
        },
    ]
    failures = [check["id"] for check in checks if check["status"] == "failed"]
    warnings = [check["id"] for check in checks if check["status"] == "warning"]
    return {
        "approved": not failures,
        "status": "passed" if not warnings else "warning",
        "checks": checks,
        "sample_peak_dbfs": round(-120.0 if sample_peak <= 0 else 20.0 * math.log10(sample_peak), 2),
    }


def _apply_true_peak_safety_trim(path: str | Path, true_peak_dbtp: float) -> None:
    """Apply the smallest transparent gain trim needed to restore -1.1 dBTP."""
    audio, sample_rate = _read_audio(path)
    trim_db = -1.1 - true_peak_dbtp
    if trim_db >= 0:
        return
    audio *= float(10 ** (trim_db / 20.0))
    sf.write(str(path), audio.T, sample_rate, subtype="PCM_24")


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

    quality_gate = _quality_gate(destination_path, target_lufs, audio)
    if not quality_gate["approved"]:
        # Pedalboard's limiter is sample-peak based.  A tiny post-render trim
        # makes the promised true-peak ceiling robust on real DAC playback.
        true_peak_check = next(check for check in quality_gate["checks"] if check["id"] == "true_peak")
        _apply_true_peak_safety_trim(destination_path, float(true_peak_check["value"]))
        quality_gate = _quality_gate(destination_path, target_lufs, audio)
    if not quality_gate["approved"]:
        raise AudioProcessingError("Quality gate rejected the master because safe peak or clipping requirements were not met.")

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
        "quality_gate": quality_gate,
    }
