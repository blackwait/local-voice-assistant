#!/usr/bin/env python3
"""Paraformer-large ASR 服务（带可选 VAD/标点恢复），接口与 funasr_server.py 完全兼容。

默认模型: iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch
可选 VAD : iic/speech_fsmn_vad_zh-cn-16k-common-pytorch
可选标点: iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch
"""
import argparse
import json
import os
import tempfile
import urllib.error
import urllib.request
from typing import Any, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from funasr import AutoModel
from funasr.utils.postprocess_utils import rich_transcription_postprocess
from pydantic import BaseModel


class PolishRequest(BaseModel):
    input: str
    prompt: Optional[str] = None


class TranslateRequest(BaseModel):
    input: str
    target_language: str = "中文"


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


def deepseek_model() -> str:
    return os.getenv("DEEPSEEK_MODEL", "deepseek-chat").strip() or "deepseek-chat"


def deepseek_api_key() -> str:
    return os.getenv("DEEPSEEK_API_KEY", "").strip()


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
        "deepseek_configured": bool(deepseek_api_key()),
        "deepseek_model": deepseek_model(),
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


@app.post("/polish")
def polish(request: PolishRequest) -> dict[str, Any]:
    system_prompt = (
        request.prompt.strip()
        if request.prompt and request.prompt.strip()
        else correction_prompt()
    )
    content = call_deepseek(request.input, system_prompt, json_object=True)
    if not content.strip():
        return fallback_correction(request.input, "AI 纠错返回空内容，已保留识别文本。")
    try:
        data = json.loads(content)
    except json.JSONDecodeError as error:
        return fallback_correction(
            request.input,
            f"AI 纠错结果不是有效 JSON，已保留识别文本：{error}",
        )
    return {
        "corrected_text": str(data.get("corrected_text", request.input)).strip()
        or request.input.strip(),
        "notes": data.get("notes") if isinstance(data.get("notes"), list) else [],
        "confidence": data.get("confidence")
        if data.get("confidence") in ("high", "medium", "low")
        else "medium",
    }


@app.post("/translate")
def translate(request: TranslateRequest) -> dict[str, str]:
    content = call_deepseek(
        request.input,
        translation_prompt(request.target_language),
        json_object=True,
    )
    if not content.strip():
        return {"translation": ""}
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return {"translation": ""}
    return {"translation": str(data.get("translation", "")).strip()}


def call_deepseek(user_input: str, system_prompt: str, json_object: bool) -> str:
    api_key = deepseek_api_key()
    if not api_key:
        raise HTTPException(status_code=400, detail="DeepSeek key 未配置")

    payload: dict[str, Any] = {
        "model": deepseek_model(),
        "temperature": 0.1,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input},
        ],
    }
    if json_object:
        payload["response_format"] = {"type": "json_object"}

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        "https://api.deepseek.com/chat/completions",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise HTTPException(
            status_code=502,
            detail=f"DeepSeek 请求失败：{error.code} {detail}",
        ) from error
    except urllib.error.URLError as error:
        raise HTTPException(
            status_code=502,
            detail=f"DeepSeek 请求失败：{error}",
        ) from error

    choices = data.get("choices") if isinstance(data, dict) else None
    if not choices:
        return ""
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        return ""
    return str(message.get("content", "")).strip()


def fallback_correction(input_text: str, note: str) -> dict[str, Any]:
    return {
        "corrected_text": input_text.strip(),
        "notes": [note],
        "confidence": "low",
    }


def correction_prompt() -> str:
    return """你是一个语音识别纠错助手。
你的任务：
1. 修正 ASR 语音识别导致的错字、同音词、断句错误和口语停顿。
2. 保留说话人的原意，不扩写、不编造事实。
3. 专有名词、代码标识符、产品名、英文缩写尽量保持原文。
4. 只返回 JSON，不要返回 Markdown。

JSON 字段：
- corrected_text: string，纠正后的原文。
- notes: string[]，最多 3 条，说明关键纠错点；没有就返回空数组。
- confidence: string，只能是 high / medium / low。
"""


def translation_prompt(target_language: str) -> str:
    return f"""你是一个实时翻译助手。
你的任务：
1. 将用户输入翻译为：{target_language}。
2. 保留原文含义，不扩写、不编造事实。
3. 专有名词、代码标识符、产品名、英文缩写尽量保持原文。
4. 只返回 JSON，不要返回 Markdown。

JSON 字段：
- translation: string，翻译结果。
"""


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)
