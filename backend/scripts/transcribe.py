#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def normalize_text(raw: str) -> str:
    return " ".join(raw.split()).strip()


def has_faster_whisper_backend() -> bool:
    try:
        import faster_whisper  # noqa: F401
    except Exception:
        return False
    return True


def transcribe_with_faster_whisper(
    audio_file: Path,
    model_name: str,
    language: str | None,
    device: str,
    compute_type: str,
) -> str | None:
    try:
        from faster_whisper import WhisperModel
    except Exception:
        return None

    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    segments, _ = model.transcribe(
        str(audio_file),
        language=language,
        task="transcribe",
        beam_size=1,
        vad_filter=True,
    )
    text = " ".join((segment.text or "").strip() for segment in segments)
    normalized = normalize_text(text)
    return normalized or None


def transcribe_with_whisper_cli(
    audio_file: Path,
    model_name: str,
    language: str | None,
) -> str | None:
    whisper_bin = shutil.which("whisper")
    if whisper_bin is None:
        return None

    with tempfile.TemporaryDirectory(prefix="radio-stt-") as tmpdir:
        command = [
            whisper_bin,
            str(audio_file),
            "--model",
            model_name,
            "--task",
            "transcribe",
            "--output_dir",
            tmpdir,
            "--output_format",
            "txt",
        ]
        if language:
            command.extend(["--language", language])

        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            return None

        txt_file = Path(tmpdir) / f"{audio_file.stem}.txt"
        if not txt_file.exists():
            return None
        normalized = normalize_text(
            txt_file.read_text(encoding="utf-8", errors="ignore")
        )
        return normalized or None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Transcribe radio chunk audio and print transcript to stdout."
    )
    parser.add_argument("audio_file", help="Path to temporary audio file")
    parser.add_argument(
        "--model",
        default=os.getenv("RADIO_STT_MODEL", "small"),
        help="Whisper model name",
    )
    parser.add_argument(
        "--language",
        default=os.getenv("RADIO_STT_LANGUAGE", "ru").strip() or None,
        help="Language code (for example: ru, en). Empty means auto-detect.",
    )
    parser.add_argument(
        "--device",
        default=os.getenv("RADIO_STT_DEVICE", "cpu"),
        help="Device for faster-whisper (cpu, cuda, auto)",
    )
    parser.add_argument(
        "--compute-type",
        default=os.getenv("RADIO_STT_COMPUTE_TYPE", "int8"),
        help="Compute type for faster-whisper",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    audio_file = Path(args.audio_file)
    if not audio_file.exists() or not audio_file.is_file():
        print(f"Audio file not found: {audio_file}", file=sys.stderr)
        return 2

    has_faster = has_faster_whisper_backend()
    has_whisper_cli = shutil.which("whisper") is not None

    transcript: str | None = None
    if has_faster:
        transcript = transcribe_with_faster_whisper(
            audio_file=audio_file,
            model_name=args.model,
            language=args.language,
            device=args.device,
            compute_type=args.compute_type,
        )

    if transcript is None and has_whisper_cli:
        transcript = transcribe_with_whisper_cli(
            audio_file=audio_file,
            model_name=args.model,
            language=args.language,
        )

    if transcript:
        print(transcript)
        return 0

    if not has_faster and not has_whisper_cli:
        print(
            "No transcription backend available. Install faster-whisper or whisper CLI.",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
