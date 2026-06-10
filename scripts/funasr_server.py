#!/usr/bin/env python3
import argparse
import os
import tempfile
from typing import Any

from fastapi import FastAPI, File, UploadFile
from funasr import AutoModel
from funasr.utils.postprocess_utils import rich_transcription_postprocess


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local FunASR HTTP service")
    parser.add_argument("--host", default=os.getenv("FUNASR_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("FUNASR_PORT", "10095")))
    parser.add_argument("--model", default=os.getenv("FUNASR_MODEL", "iic/SenseVoiceSmall"))
    parser.add_argument("--device", default=os.getenv("FUNASR_DEVICE", "cpu"))
    return parser.parse_args()


args = parse_args()
app = FastAPI(title="Local Voice Assistant FunASR Service")
model = AutoModel(model=args.model, device=args.device)


def extract_text(result: Any) -> str:
    text = ""
    if isinstance(result, list) and result:
        item = result[0]
        if isinstance(item, dict):
            text = str(item.get("text", "")).strip()
    elif isinstance(result, dict):
        text = str(result.get("text", "")).strip()
    else:
        text = str(result).strip()
    return rich_transcription_postprocess(text)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model": args.model,
        "device": args.device,
    }


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)) -> dict[str, str]:
    suffix = os.path.splitext(file.filename or "input.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        audio_path = tmp.name
    try:
        result = model.generate(
            input=audio_path,
            cache={},
            language="auto",
            use_itn=True,
            batch_size_s=60,
        )
        return {"text": extract_text(result)}
    finally:
        try:
            os.remove(audio_path)
        except OSError:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)
