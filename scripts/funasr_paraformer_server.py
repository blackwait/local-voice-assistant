#!/usr/bin/env python3
"""Paraformer-large ASR 服务（带可选 VAD/标点恢复），接口与 funasr_server.py 完全兼容。

默认模型: iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch
可选 VAD : iic/speech_fsmn_vad_zh-cn-16k-common-pytorch
可选标点: iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch
"""
import argparse
import os
import tempfile
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from funasr import AutoModel
from funasr.utils.postprocess_utils import rich_transcription_postprocess


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local Paraformer ASR HTTP service")
    parser.add_argument("--host", default=os.getenv("FUNASR_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("FUNASR_PORT", "10095")))
    parser.add_argument(
        "--model",
        default=os.getenv(
            "FUNASR_MODEL",
            "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        ),
    )
    parser.add_argument(
        "--vad-model",
        default=os.getenv("FUNASR_VAD_MODEL", "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"),
    )
    parser.add_argument(
        "--punc-model",
        default=os.getenv(
            "FUNASR_PUNC_MODEL",
            "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
        ),
    )
    parser.add_argument("--device", default=os.getenv("FUNASR_DEVICE", "cpu"))
    parser.add_argument(
        "--disable-vad",
        action="store_true",
        default=os.getenv("FUNASR_DISABLE_VAD", "0") == "1",
    )
    parser.add_argument(
        "--disable-punc",
        action="store_true",
        default=os.getenv("FUNASR_DISABLE_PUNC", "0") == "1",
    )
    parser.add_argument(
        "--quantize",
        action="store_true",
        default=os.getenv("FUNASR_QUANTIZE", "0") == "1",
    )
    return parser.parse_args()


args = parse_args()

vad_model = None if args.disable_vad else args.vad_model
punc_model = None if args.disable_punc else args.punc_model

print(
    f"[paraformer] loading model={args.model} vad={vad_model} punc={punc_model} "
    f"device={args.device} quantize={args.quantize}",
    flush=True,
)
model = AutoModel(
    model=args.model,
    vad_model=vad_model,
    punc_model=punc_model,
    device=args.device,
    quantize=args.quantize,
)
print("[paraformer] model ready", flush=True)

app = FastAPI(title="Local Voice Assistant Paraformer Service")


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
        "engine": "funasr-paraformer",
        "model": args.model,
        "vad_model": vad_model,
        "punc_model": punc_model,
        "device": args.device,
        "quantize": args.quantize,
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
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"transcribe failed: {exc}") from exc
    finally:
        try:
            os.remove(audio_path)
        except OSError:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)
