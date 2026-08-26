# Seek — post-download spectral analysis.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Synthetic signals with KNOWN spectra, plus one genuine round trip through
# ffmpeg's MP3 encoder. The synthetic cases pin the maths; the ffmpeg case
# proves the thing that actually matters — that a real encoder's lowpass,
# laundered through FLAC, is still detectable.

import os
import shutil
import subprocess

import numpy as np
import pytest
import soundfile

from seek_sidecar import protocol, spectral

SAMPLE_RATE = 44100
DURATION = 12.0
HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def noise(seconds=DURATION, sample_rate=SAMPLE_RATE, seed=7):
    rng = np.random.default_rng(seed)
    return rng.normal(0.0, 0.18, int(seconds * sample_rate))


def brickwall(signal, cutoff_hz, sample_rate=SAMPLE_RATE):
    """Hard lowpass in the frequency domain — stands in for an encoder's
    filter, which is close to a cliff."""
    spectrum = np.fft.rfft(signal)
    freqs = np.fft.rfftfreq(signal.size, d=1.0 / sample_rate)
    spectrum[freqs > cutoff_hz] = 0.0
    return np.fft.irfft(spectrum, n=signal.size)


def gentle_rolloff(signal, knee_hz, sample_rate=SAMPLE_RATE):
    """A soft, wide rolloff — what a dark acoustic recording looks like. Must
    NOT read as a transcode."""
    spectrum = np.fft.rfft(signal)
    freqs = np.fft.rfftfreq(signal.size, d=1.0 / sample_rate)
    shape = np.ones_like(freqs)
    above = freqs > knee_hz
    nyquist = sample_rate / 2.0
    shape[above] = np.linspace(1.0, 0.16, int(above.sum()))
    return np.fft.irfft(spectrum * shape, n=signal.size)


def write(tmp_path, name, samples, sample_rate=SAMPLE_RATE):
    path = os.path.join(str(tmp_path), name)
    peak = np.max(np.abs(samples)) or 1.0
    soundfile.write(path, (samples / peak * 0.85), sample_rate)
    return path


# ------------------------------------------------------------------ decoding

def test_decodes_a_wav(tmp_path):
    path = write(tmp_path, "a.wav", noise())
    windows, rate, channels, duration, analysed, decoder = spectral.decode(path)
    assert rate == SAMPLE_RATE
    assert channels == 1
    assert duration == pytest.approx(DURATION, abs=0.1)
    assert decoder == "soundfile"
    assert len(windows) > 5
    assert analysed > 0


def test_decodes_a_flac(tmp_path):
    path = write(tmp_path, "a.flac", noise())
    _windows, rate, _ch, _dur, _an, decoder = spectral.decode(path)
    assert rate == SAMPLE_RATE and decoder == "soundfile"


def test_missing_file_raises():
    with pytest.raises(spectral.AnalysisError, match="no such file"):
        spectral.decode("/nonexistent/nope.flac")


def test_file_shorter_than_one_window_raises(tmp_path):
    path = write(tmp_path, "tiny.wav", noise(seconds=0.05))
    with pytest.raises(spectral.AnalysisError, match="shorter than one FFT window"):
        spectral.analyse(path)


def test_digital_silence_raises(tmp_path):
    path = write(tmp_path, "silence.wav", np.zeros(int(DURATION * SAMPLE_RATE)))
    with pytest.raises(spectral.AnalysisError, match="silence"):
        spectral.analyse(path)


# ------------------------------------------------------------ cutoff finding

def test_full_spectrum_noise_has_no_cutoff(tmp_path):
    """Energy runs to Nyquist. This is what genuine lossless looks like and it
    must not be flagged."""
    result = spectral.analyse(write(tmp_path, "full.wav", noise()))
    assert result["cutoffHz"] is None
    assert result["assessment"] == "likely_lossless"
    assert result["declaredLossless"] is True
    assert result["impliedSourceKbps"] is None
    protocol.validate_event("analysis.result", result)


@pytest.mark.parametrize("cutoff", [15_000, 16_000, 17_500, 19_000])
def test_sharp_lowpass_is_located_accurately(tmp_path, cutoff):
    path = write(tmp_path, f"lp{cutoff}.flac", brickwall(noise(), cutoff))
    result = spectral.analyse(path)
    assert result["cutoffHz"] is not None, "no cutoff found"
    # Within a few hundred Hz: bin spacing at 8192/44100 is ~5.4 Hz, but the
    # shelf threshold sits partway down the transition.
    assert abs(result["cutoffHz"] - cutoff) < 600, result["cutoffHz"]
    assert result["shelfDropDb"] > 20


def test_sharp_lowpass_in_a_flac_reads_as_lossy_source(tmp_path):
    """The headline case: a FLAC that was an MP3."""
    path = write(tmp_path, "fake.flac", brickwall(noise(), 16_000))
    result = spectral.analyse(path)
    assert result["declaredLossless"] is True
    assert result["assessment"] == "strong_signs_of_lossy_source"
    assert result["confidence"] >= 0.6
    assert result["impliedSourceKbps"] == 160
    protocol.validate_event("analysis.result", result)


def test_the_same_shelf_in_an_mp3_is_not_a_finding(tmp_path):
    """A lowpass in an MP3 is what an MP3 IS. Reporting it would train the user
    to ignore the indicator."""
    path = write(tmp_path, "honest.mp3", brickwall(noise(), 16_000))
    result = spectral.analyse(path)
    assert result["declaredLossless"] is False
    assert result["assessment"] == "inconclusive"
    protocol.validate_event("analysis.result", result)


def test_gentle_rolloff_is_not_called_a_transcode(tmp_path):
    """A dark or old recording rolls off gradually. Sharpness, not cutoff
    frequency, is what separates an encoder from a room."""
    path = write(tmp_path, "dark.flac", gentle_rolloff(noise(), 12_000))
    result = spectral.analyse(path)
    assert result["assessment"] != "strong_signs_of_lossy_source", (
        f"gentle rolloff misread: cutoff={result['cutoffHz']} "
        f"drop={result['shelfDropDb']} width={result['shelfWidthHz']}"
    )


def test_cutoff_at_nyquist_is_not_a_filter(tmp_path):
    """A brickwall at ~Nyquist is just the sample rate, not a lowpass."""
    path = write(tmp_path, "nyq.flac", brickwall(noise(), 21_800))
    result = spectral.analyse(path)
    assert result["cutoffHz"] is None
    assert result["assessment"] == "likely_lossless"


def test_genuine_hires_file_is_not_flagged(tmp_path):
    """A real 96 kHz master has little content above 20 kHz, but it ROLLS OFF —
    it does not cliff. Judging hi-res against a 44.1 kHz assumption, or reading
    its natural rolloff as a filter, would flag every hi-res file ever."""
    path = write(tmp_path, "hires.flac",
                 gentle_rolloff(noise(sample_rate=96_000), 18_000,
                                sample_rate=96_000),
                 sample_rate=96_000)
    result = spectral.analyse(path)
    assert result["sampleRate"] == 96_000
    assert result["nyquistHz"] == 48_000
    assert result["assessment"] != "strong_signs_of_lossy_source", (
        f"hi-res rolloff misread (cutoff={result['cutoffHz']}, "
        f"drop={result['shelfDropDb']}, width={result['shelfWidthHz']})"
    )


def test_upsampled_44k_content_in_a_96k_container_is_caught(tmp_path):
    """The other hi-res fakery: a 44.1 kHz source upsampled to 96 kHz. Content
    cliffs at ~22 kHz with half the band empty. Sharpness-first catches this for
    the same reason it catches MP3 sources."""
    path = write(tmp_path, "upsampled.flac",
                 brickwall(noise(sample_rate=96_000), 22_000, sample_rate=96_000),
                 sample_rate=96_000)
    result = spectral.analyse(path)
    assert result["cutoffHz"] is not None
    assert result["cutoffHz"] < 23_000
    assert result["assessment"] == "strong_signs_of_lossy_source"


# ------------------------------------------------------------------ payload

def test_payload_shape_and_rawness(tmp_path):
    result = spectral.analyse(write(tmp_path, "x.flac", brickwall(noise(), 16_000)),
                              request_id="req-1", transfer_id="tid-1")
    protocol.validate_event("analysis.result", result)

    assert result["requestId"] == "req-1"
    assert result["transferId"] == "tid-1"
    assert result["fftSize"] == spectral.FFT_SIZE
    assert result["windowCount"] > 0
    assert len(result["spectrumHz"]) == len(result["spectrumDb"])
    assert 32 <= len(result["spectrumHz"]) <= spectral.SPECTRUM_POINTS
    # Peak-normalised: nothing above 0 dB.
    assert max(result["spectrumDb"]) <= 0.01
    # Log-spaced, so resolution is not wasted at the top.
    assert result["spectrumHz"][0] < result["spectrumHz"][-1]

    # Nothing formatted for display anywhere in the payload.
    for key, value in result.items():
        if isinstance(value, str):
            assert value in {"req-1", "tid-1", result["path"], "soundfile",
                             "ffmpeg", result["assessment"]}, \
                f"{key} looks like display text: {value!r}"


def test_assessment_vocabulary_is_never_definitive():
    """docs/PRODUCT.md §6: no verdict. The strongest value available is
    'strong signs of a lossy source'."""
    values = set(protocol.ENUM_VALUES["SpectralAssessment"])
    assert values == {"likely_lossless", "possible_transcode",
                      "strong_signs_of_lossy_source", "inconclusive"}
    for forbidden in ("fake", "transcode", "lossy", "confirmed", "definitely"):
        assert forbidden not in values


def test_confidence_is_a_unit_interval(tmp_path):
    for name, samples in (
        ("a.flac", noise()),
        ("b.flac", brickwall(noise(), 16_000)),
        ("c.flac", gentle_rolloff(noise(), 12_000)),
        ("d.mp3", brickwall(noise(), 15_000)),
    ):
        result = spectral.analyse(write(tmp_path, name, samples))
        assert 0.0 <= result["confidence"] <= 1.0, name


# ------------------------------------------------------- the real encoder

@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe not available")
@pytest.mark.parametrize("kbps,expect_strong", [(128, True), (192, True)])
def test_real_mp3_laundered_through_flac_is_still_detected(tmp_path, kbps, expect_strong):
    """The case the whole feature exists for.

    Encode noise to MP3 with a REAL encoder, decode it, re-encode to FLAC — the
    exact laundering a fake-lossless uploader performs — then analyse. LAME's
    lowpass must still be visible.
    """
    source = write(tmp_path, "src.wav", noise(seconds=15.0))
    mp3 = os.path.join(str(tmp_path), f"enc{kbps}.mp3")
    laundered = os.path.join(str(tmp_path), f"laundered{kbps}.flac")

    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", source,
         "-codec:a", "libmp3lame", "-b:a", f"{kbps}k", mp3],
        check=True, capture_output=True, timeout=120,
    )
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", mp3, "-codec:a", "flac", laundered],
        check=True, capture_output=True, timeout=120,
    )

    result = spectral.analyse(laundered)
    protocol.validate_event("analysis.result", result)

    assert result["declaredLossless"] is True
    assert result["cutoffHz"] is not None, "no lowpass found in a real MP3 transcode"
    assert result["cutoffHz"] < 21_000
    if expect_strong:
        assert result["assessment"] == "strong_signs_of_lossy_source", (
            f"{kbps}k transcode read as {result['assessment']} "
            f"(cutoff={result['cutoffHz']}, drop={result['shelfDropDb']}, "
            f"width={result['shelfWidthHz']}, conf={result['confidence']})"
        )


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe not available")
def test_genuine_flac_from_the_same_source_is_not_flagged(tmp_path):
    """Control for the test above: same noise, encoded straight to FLAC with no
    lossy step. If this flags, the detector is just calling everything a
    transcode."""
    source = write(tmp_path, "src2.wav", noise(seconds=15.0, seed=11))
    genuine = os.path.join(str(tmp_path), "genuine.flac")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", source, "-codec:a", "flac", genuine],
        check=True, capture_output=True, timeout=120,
    )
    result = spectral.analyse(genuine)
    assert result["assessment"] == "likely_lossless", (
        f"genuine FLAC misread as {result['assessment']} "
        f"(cutoff={result['cutoffHz']})"
    )
