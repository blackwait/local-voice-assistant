# Cloud FunASR DeepSeek Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deploy FunASR SenseVoice and DeepSeek proxy to `10.254.81.32` under `/opt`, then let the desktop client use them by configuring a cloud endpoint.

**Architecture:** Run one FastAPI service on port `10095` so the existing FunASR client protocol stays unchanged: `GET /health` and `POST /transcribe`. Add DeepSeek proxy routes on the same service: `POST /polish` and `POST /translate`; the desktop app uses the proxy only when `deepseek_endpoint` is configured, otherwise it keeps the current local direct DeepSeek behavior.

**Tech Stack:** Tauri v2, Rust `reqwest`, React, FastAPI, FunASR `iic/SenseVoiceSmall`, systemd.

---

### Task 1: Add Cloud Service Script

**Files:**
- Create: `scripts/cloud_voice_service.py`

**Steps:**
1. Reuse the existing FunASR request contract: multipart `file` upload returns `{ "text": "..." }`.
2. Add `/health`, `/polish`, and `/translate`.
3. Read DeepSeek key and model from environment variables.

### Task 2: Add Client DeepSeek Endpoint

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/tauri.ts`
- Modify: `src/App.tsx`

**Steps:**
1. Add `deepseek_endpoint` to config and view model with empty default.
2. Route correction and translation to cloud proxy when endpoint is configured.
3. Add a UI field in AI settings for cloud endpoint.

### Task 3: Verify Local Build

**Command:**
- `npm run build`

**Expected:**
- TypeScript and Vite build exit with code 0.

### Task 4: Deploy Remote Service

**Remote Host:**
- `root@10.254.81.32`

**Remote Paths:**
- App: `/opt/local-voice-services`
- Venv: `/opt/local-voice-services/.venv`
- Service: `/etc/systemd/system/local-voice-services.service`
- Environment: `/opt/local-voice-services/.env`

**Steps:**
1. Probe Python version and systemd availability.
2. Upload scripts and requirements.
3. Create venv and install dependencies.
4. Write systemd unit.
5. Start service.

### Task 5: Verify Remote Service

**Commands:**
- `curl http://127.0.0.1:10095/health` on remote.
- `curl http://10.254.81.32:10095/health` from local.

**Expected:**
- JSON shows `ok: true`, FunASR model, device, and `deepseek_configured: true`.
