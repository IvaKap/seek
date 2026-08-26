# Seek — post-download spectral analysis.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# WHY THIS EXISTS
#
# RECON.md §4 established that the metadata transcode check cannot run on
# lossless files. The Soulseek protocol sends no bitrate for FLAC/WAV/AIFF
# (FileListMessage.pack_file_info only sends BITRATE for lossy files), so there
# is no advertised claim to contradict. The feature BRIEF_SEEK.md called the
# project's justification structurally does not work on the format the target
# user cares most about.
#
# Spectral analysis closes exactly that gap. Lossy encoders apply a lowpass
# filter — MP3 at 128 kbps discards everything above roughly 16 kHz, 320 kbps
# above roughly 20 kHz. That filter survives re-encoding to FLAC. A sharp shelf
# at 16 kHz in a file claiming to be lossless is evidence of an MP3 source, and
# it requires no cooperation from the uploader's metadata.
#
# WHAT IT IS NOT
#
# It is not proof, and this module never says it is. Quiet, sparse, old or
# deliberately dark recordings genuinely lack high-frequency energy; a 1968
# analogue master has a rolloff that is not an encoder's fault. So:
#
#   * The shelf must be SHARP to count. Sharpness (drop over width) is weighted
#     more heavily than the cutoff frequency itself, because a gentle acoustic
#     rolloff and an encoder cliff can share a cutoff and mean opposite things.
#   * Confidence is reported and is meant to be shown.
#   * The vocabulary tops out at "strong signs of a lossy source". There is
#     deliberately no "fake" value in SpectralAssessment.
#
# Approach credited to Spek (GPLv3), which visualises exactly this. Not vendored
# — we need decode plus FFT, a few hundred lines against numpy, not an
# application with a GUI.
#
# Everything returned is raw measurement. No labels, no colours, no formatted
# strings. Rendering is the frontend's job.

import logging
import os
import subprocess

import numpy as np

log = logging.getLogger("seek.spectral")

FFT_SIZE = 8192
MAX_WINDOWS = 96          # averaged across the file; plenty for a stable curve
SPECTRUM_POINTS = 256     # what we ship to the frontend, log-spaced
SKIP_EDGE_SECONDS = 5.0   # fade-ins and run-out grooves are not representative

# Containers whose contents are lossless. A shelf here is the interesting case.
LOSSLESS_EXTENSIONS = {".flac", ".wav", ".wave", ".aiff", ".aif", ".aifc",
                       ".alac", ".ape", ".wv", ".tta", ".m4a"}

# Approximate MP3/AAC lowpass points, for a hint about the likely source.
# Deliberately coarse — encoders and versions vary and this is not a measurement.
CUTOFF_TO_KBPS = [
    (15_200, 128), (16_400, 160), (17_600, 192), (18_600, 224),
    (19_400, 256), (20_200, 320),
]


class AnalysisError(Exception):
    """Decoding or analysis could not be completed."""


# ------------------------------------------------------------------- decode

def _decode_soundfile(path):
    import soundfile

    with soundfile.SoundFile(path) as handle:
        sample_rate = handle.samplerate
        channels = handle.channels
        frames = len(handle)
        if frames <= 0:
            raise AnalysisError("file contains no audio frames")
        duration = frames / float(sample_rate)

        windows, analysed = _read_windows_soundfile(handle, sample_rate, frames)

    return windows, sample_rate, channels, duration, analysed, "soundfile"


def _read_windows_soundfile(handle, sample_rate, frames):
    """Read up to MAX_WINDOWS evenly spaced FFT windows.

    Sampling windows rather than reading the whole file keeps a 60-minute DJ set
    as cheap as a 3-minute track, and the averaged spectrum is just as stable.
    """
    skip = int(SKIP_EDGE_SECONDS * sample_rate)
    start = skip if frames > 4 * skip else 0
    end = frames - skip if frames > 4 * skip else frames
    usable = max(0, end - start - FFT_SIZE)

    if usable <= 0:
        start, usable = 0, max(0, frames - FFT_SIZE)
    if usable <= 0:
        raise AnalysisError(
            f"file is shorter than one FFT window ({FFT_SIZE} samples)"
        )

    count = min(MAX_WINDOWS, max(1, usable // FFT_SIZE))
    offsets = np.linspace(start, start + usable, count, dtype=np.int64)

    windows = []
    for offset in offsets:
        handle.seek(int(offset))
        block = handle.read(FFT_SIZE, dtype="float64", always_2d=True)
        if block.shape[0] < FFT_SIZE:
            continue
        # Mono-sum. A transcode's lowpass applies to both channels, and summing
        # improves the noise floor of the average.
        windows.append(block.mean(axis=1))

    if not windows:
        raise AnalysisError("could not read any complete FFT window")

    return windows, len(windows) * FFT_SIZE / float(sample_rate)


def _decode_ffmpeg(path):
    """Fallback for anything libsndfile cannot open (AAC, ALAC, Opus, WMA).

    Decodes to mono float32 on stdout. Only used when soundfile fails.
    """
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate,channels,duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, timeout=30,
    )
    if probe.returncode != 0:
        raise AnalysisError(f"ffprobe failed: {probe.stderr.strip()[:200]}")

    fields = [line for line in probe.stdout.split() if line]
    try:
        sample_rate = int(fields[0])
        channels = int(fields[1])
    except (IndexError, ValueError) as error:
        raise AnalysisError("ffprobe returned no usable stream info") from error

    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1",
         "-f", "f32le", "-acodec", "pcm_f32le", "-"],
        capture_output=True, timeout=300,
    )
    if result.returncode != 0 or not result.stdout:
        raise AnalysisError(f"ffmpeg failed: {result.stderr.decode()[:200]}")

    samples = np.frombuffer(result.stdout, dtype=np.float32).astype(np.float64)
    if samples.size < FFT_SIZE:
        raise AnalysisError("decoded audio is shorter than one FFT window")

    duration = samples.size / float(sample_rate)
    skip = int(SKIP_EDGE_SECONDS * sample_rate)
    start = skip if samples.size > 4 * skip else 0
    end = samples.size - skip if samples.size > 4 * skip else samples.size
    usable = max(0, end - start - FFT_SIZE)
    if usable <= 0:
        start, usable = 0, samples.size - FFT_SIZE

    count = min(MAX_WINDOWS, max(1, usable // FFT_SIZE))
    offsets = np.linspace(start, start + usable, count, dtype=np.int64)
    windows = [samples[o:o + FFT_SIZE] for o in offsets
               if o + FFT_SIZE <= samples.size]
    if not windows:
        raise AnalysisError("could not extract any complete FFT window")

    analysed = len(windows) * FFT_SIZE / float(sample_rate)
    return windows, sample_rate, channels, duration, analysed, "ffmpeg"


def decode(path):
    if not os.path.isfile(path):
        raise AnalysisError(f"no such file: {path}")
    try:
        return _decode_soundfile(path)
    except AnalysisError:
        raise
    except Exception as error:
        log.debug("soundfile could not open %s (%s); trying ffmpeg", path, error)
        return _decode_ffmpeg(path)


# ------------------------------------------------------------------ spectrum

def average_spectrum(windows):
    """Hann-windowed rFFT magnitude, averaged over windows, in dB peak-normalised."""
    taper = np.hanning(FFT_SIZE)
    accumulator = np.zeros(FFT_SIZE // 2 + 1)

    for window in windows:
        spectrum = np.fft.rfft(window * taper)
        accumulator += np.abs(spectrum) ** 2

    power = accumulator / len(windows)
    peak = power.max()
    if peak <= 0:
        raise AnalysisError("audio is digital silence")

    # Floor well below any real content so log10 is safe and the curve is stable.
    return 10.0 * np.log10(np.maximum(power / peak, 1e-16))


# Heatmap grid. Small on purpose: this crosses a socket as JSON and is drawn as
# rectangles, and a Spek-style picture is about texture, not per-bin precision.
HEATMAP_TIME_BINS = 96
HEATMAP_FREQ_BINS = 64


def spectrogram(windows):
    """A coarse time x frequency magnitude grid, in dB, for the heatmap.

    This is the picture Spek draws, and it answers a different question from
    `average_spectrum`: the average resolves whether a lowpass cliff exists,
    while this shows WHERE in the track the energy sits and whether the ceiling
    is constant throughout. A file lowpassed at 16 kHz shows a flat dark band
    across the whole width; a quiet passage shows a vertical dark stripe. Being
    able to tell those two apart is exactly why the heatmap earns its place
    next to the curve rather than replacing it.

    Returned as (flat, time_bins, freq_bins), flattened freq-major so the wire
    schema stays one-dimensional, low frequency first, peak-normalised to 0 dB
    so the scale matches the curve.
    """
    taper = np.hanning(FFT_SIZE)
    columns = []
    for window in windows:
        spectrum = np.fft.rfft(window * taper)
        columns.append(np.abs(spectrum) ** 2)

    if not columns:
        raise AnalysisError("no windows to render")

    grid = np.array(columns)                      # (time, freq)
    peak = grid.max()
    if peak <= 0:
        raise AnalysisError("audio is digital silence")

    # Bin down to the display grid. Windows are already evenly spaced across the
    # file, so a mean over each block is a fair summary rather than a sample.
    def _bin(arr, axis, target):
        n = arr.shape[axis]
        if n <= target:
            return arr
        edges = np.linspace(0, n, target + 1).astype(int)
        parts = [arr.take(range(edges[i], max(edges[i + 1], edges[i] + 1)), axis=axis)
                 .mean(axis=axis) for i in range(target)]
        return np.stack(parts, axis=axis)

    grid = _bin(grid, 0, HEATMAP_TIME_BINS)
    grid = _bin(grid, 1, HEATMAP_FREQ_BINS)

    db = 10.0 * np.log10(np.maximum(grid / peak, 1e-16))
    # Flattened freq-major, and rounded: a tenth of a dB is far below what a
    # pixel can show and full precision doubles the payload for nothing.
    rows = db.T
    return (
        [round(float(v), 1) for row in rows for v in row],
        int(rows.shape[1]),   # time bins
        int(rows.shape[0]),   # freq bins
    )


def find_cutoff(freqs, db, nyquist):
    """Locate a lowpass shelf.

    Returns (cutoff_hz, drop_db, width_hz) or (None, None, None).

    The search is for the point above which energy collapses and stays
    collapsed. A single narrow notch is not a cutoff; the floor has to persist
    all the way to Nyquist, which is what an encoder's lowpass actually does.
    """
    # Only look above 10 kHz. Below that, a "shelf" is just music.
    search_start = np.searchsorted(freqs, 10_000.0)
    if search_start >= len(freqs) - 8:
        return None, None, None

    band = db[search_start:]
    band_freqs = freqs[search_start:]

    # Reference level: the median of the 10 kHz -> 90%-of-Nyquist region gives a
    # robust "how loud is the top end normally" without being dragged by peaks.
    reference = float(np.median(band[: max(4, int(len(band) * 0.6))]))

    # The floor is what the very top of the spectrum looks like.
    tail = band[int(len(band) * 0.92):]
    if tail.size == 0:
        return None, None, None
    floor = float(np.median(tail))

    drop = reference - floor
    if drop < 12.0:
        # No meaningful collapse: energy continues to Nyquist. That is what a
        # genuine lossless file looks like.
        return None, None, None

    # Cutoff = last frequency at which energy is still clearly above the floor.
    threshold = floor + drop * 0.5
    above = np.nonzero(band > threshold)[0]
    if above.size == 0:
        return None, None, None
    cutoff_index = int(above[-1])
    cutoff = float(band_freqs[cutoff_index])

    # A cutoff at the very top is just Nyquist, not a filter.
    if cutoff >= nyquist * 0.97:
        return None, None, None

    # Width: how far it takes to fall from near-reference to near-floor. An
    # encoder does this in a few hundred Hz; a room does it over kilohertz.
    high_threshold = floor + drop * 0.9
    low_threshold = floor + drop * 0.1
    high_idx = np.nonzero(band > high_threshold)[0]
    low_idx = np.nonzero(band > low_threshold)[0]
    if high_idx.size and low_idx.size:
        width = float(band_freqs[int(low_idx[-1])] - band_freqs[int(high_idx[-1])])
        width = max(width, float(freqs[1] - freqs[0]))
    else:
        width = float(nyquist)

    return cutoff, float(drop), width


def implied_source_kbps(cutoff_hz):
    if cutoff_hz is None:
        return None
    for limit, kbps in CUTOFF_TO_KBPS:
        if cutoff_hz <= limit:
            return kbps
    return None


def assess(cutoff_hz, drop_db, width_hz, nyquist, declared_lossless):
    """Turn measurements into a hedged assessment plus a confidence.

    Never returns a definitive verdict. The strongest available conclusion is
    "strong signs of a lossy source", and even that is paired with a confidence
    the UI is expected to show.
    """
    if cutoff_hz is None:
        # Energy runs to Nyquist. For a lossless container that is the expected,
        # reassuring result; for a lossy one it tells us nothing new.
        if declared_lossless:
            return "likely_lossless", 0.75
        return "inconclusive", 0.3

    if not declared_lossless:
        # A lowpass in an MP3 is what an MP3 is. Not a finding.
        return "inconclusive", 0.15

    # Sharpness is the real signal: dB per kHz of transition.
    sharpness = drop_db / max(width_hz / 1000.0, 0.05)

    # How far below Nyquist the cutoff sits, as a fraction.
    headroom = (nyquist - cutoff_hz) / nyquist

    confidence = 0.0
    confidence += min(sharpness / 60.0, 1.0) * 0.5      # cliff vs slope
    confidence += min(drop_db / 60.0, 1.0) * 0.25       # how deep
    confidence += min(headroom / 0.25, 1.0) * 0.25      # how far down
    confidence = round(min(max(confidence, 0.0), 1.0), 3)

    # SHARPNESS FIRST, deliberately.
    #
    # An encoder's lowpass is a cliff — tens of dB over a few hundred Hz.
    # Nothing acoustic, and no microphone, room or master, falls that fast.
    # Gating on cutoff FREQUENCY instead is the obvious-looking mistake: real
    # libmp3lame cuts at ~20.3 kHz at 192 kbps, comfortably above the ~19 kHz
    # line you would draw from the textbook table, so a frequency-first rule
    # quietly misses everything above 192 kbps. Measured on a real
    # encode->FLAC round trip: cutoff 20.3 kHz, drop 98 dB, width 700 Hz
    # — 140 dB/kHz. That is the signal.
    if sharpness >= 60.0 and drop_db >= 30.0:
        return "strong_signs_of_lossy_source", max(confidence, 0.7)

    # A softer cliff still counts when it sits well down the band, where no
    # lossless file has any business stopping.
    if cutoff_hz < 19_000 and sharpness >= 25.0 and drop_db >= 25.0:
        return "strong_signs_of_lossy_source", max(confidence, 0.6)
    if cutoff_hz < 20_500 and drop_db >= 18.0:
        return "possible_transcode", confidence
    if confidence < 0.35:
        return "inconclusive", confidence
    return "possible_transcode", confidence


def _downsample(freqs, db, points=SPECTRUM_POINTS):
    """Log-spaced resample for transport. Hearing is logarithmic and a linear
    4097-point curve wastes most of its resolution above 10 kHz."""
    usable = freqs[1:]  # drop DC
    usable_db = db[1:]
    if usable.size <= points:
        return [round(float(f), 2) for f in usable], \
               [round(float(v), 2) for v in usable_db]

    targets = np.logspace(np.log10(max(usable[0], 20.0)),
                          np.log10(usable[-1]), points)
    indices = np.unique(np.searchsorted(usable, targets).clip(0, usable.size - 1))
    return ([round(float(usable[i]), 2) for i in indices],
            [round(float(usable_db[i]), 2) for i in indices])


# --------------------------------------------------------------------- entry

def analyse(path, request_id="", transfer_id=None):
    """Analyse one downloaded file. Returns a SpectralAnalysis payload.

    Raises AnalysisError if the file cannot be decoded. CPU-bound — call it on a
    worker thread, never on the pynicotine main loop.
    """
    windows, sample_rate, channels, duration, analysed, decoder = decode(path)

    db = average_spectrum(windows)
    freqs = np.fft.rfftfreq(FFT_SIZE, d=1.0 / sample_rate)
    nyquist = sample_rate / 2.0

    declared_lossless = os.path.splitext(path)[1].lower() in LOSSLESS_EXTENSIONS
    cutoff, drop, width = find_cutoff(freqs, db, nyquist)
    # Never let the picture break the verdict: the heatmap is decoration for
    # the finding, so a failure to render one must not lose the other.
    try:
        heatmap, heat_t, heat_f = spectrogram(windows)
    except AnalysisError:
        heatmap, heat_t, heat_f = [], 0, 0

    assessment, confidence = assess(cutoff, drop, width, nyquist, declared_lossless)
    spectrum_hz, spectrum_db = _downsample(freqs, db)

    return {
        "requestId": request_id,
        "path": path,
        "transferId": transfer_id,
        "sampleRate": int(sample_rate),
        "channels": int(channels),
        "durationSeconds": round(float(duration), 3),
        "decodedWith": decoder,
        "nyquistHz": round(float(nyquist), 2),
        "cutoffHz": None if cutoff is None else round(float(cutoff), 2),
        "shelfDropDb": None if drop is None else round(float(drop), 2),
        "shelfWidthHz": None if width is None else round(float(width), 2),
        "confidence": float(confidence),
        "assessment": assessment,
        "declaredLossless": declared_lossless,
        "impliedSourceKbps": implied_source_kbps(cutoff),
        "spectrumHz": spectrum_hz,
        "spectrumDb": spectrum_db,
        "heatmapDb": heatmap,
        "heatmapTimeBins": heat_t,
        "heatmapFreqBins": heat_f,
        "fftSize": FFT_SIZE,
        "windowCount": len(windows),
        "analysedSeconds": round(float(analysed), 3),
    }


# ------------------------------------------------------------------ preview

PREVIEW_RATE = 22050
PREVIEW_MAX_SECONDS = 45


def excerpt_wav(path, start_seconds=0, seconds=20):
    """Decode a slice of a file and return (wav_bytes, start, length, duration).

    Mono, 22.05 kHz, 16-bit. This is for deciding whether a track is the one you
    want, not for listening properly — and it has to cross a WebSocket, where a
    full-rate stereo excerpt would be tens of megabytes.

    Reuses the decode path the spectral check already depends on, so a format
    that can be analysed can also be previewed.
    """
    import io
    import wave

    seconds = max(1, min(int(seconds or 20), PREVIEW_MAX_SECONDS))
    start_seconds = max(0, int(start_seconds or 0))

    try:
        import soundfile
    except ImportError as error:                      # pragma: no cover
        raise AnalysisError("soundfile is not available") from error

    try:
        with soundfile.SoundFile(path) as handle:
            rate = handle.samplerate
            duration = len(handle) / float(rate) if rate else 0.0
            if duration <= 0:
                raise AnalysisError("empty or unreadable audio")

            # A start past the end is a caller mistake, not a reason to fail —
            # clamp so "preview from 2:00" on a 90-second track still plays.
            if start_seconds >= duration:
                start_seconds = 0
            handle.seek(int(start_seconds * rate))
            frames = handle.read(int(seconds * rate), dtype="float32", always_2d=True)
    except AnalysisError:
        raise
    except Exception as error:                        # noqa: BLE001
        raise AnalysisError(f"could not decode: {error}") from error

    if frames.size == 0:
        raise AnalysisError("nothing to read at that position")

    mono = frames.mean(axis=1)

    # Cheap decimation rather than a proper resampler: this is a preview, and
    # pulling in scipy for it would be a dependency per second of audio.
    step = max(1, int(round(rate / PREVIEW_RATE)))
    mono = mono[::step]
    out_rate = int(rate / step)

    peak = float(np.max(np.abs(mono))) if mono.size else 0.0
    if peak > 0:
        mono = mono / peak * 0.89          # leave headroom; do not clip
    pcm = np.clip(mono * 32767.0, -32768, 32767).astype("<i2")

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(out_rate)
        wav.writeframes(pcm.tobytes())

    return buffer.getvalue(), start_seconds, len(mono) / float(out_rate), duration
