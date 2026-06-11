# FunASR Default Without Bundled Whisper Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make FunASR the default speech recognition path and stop shipping a bundled Whisper model.

**Architecture:** Keep both ASR engines in the app, but treat Whisper as an optional user-configured engine. Remove build-time model download, bundle resources, and automatic default Whisper profile creation.

**Tech Stack:** Tauri 2, Rust backend, React frontend, GitHub Actions release workflow.

---

### Task 1: Remove Bundled Whisper Model From Build

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `.github/workflows/release.yml`

**Steps:**
1. Remove `node scripts/download_whisper_tiny_model.mjs` from `beforeBuildCommand`.
2. Remove `bundle.resources` entry for `../models/ggml-tiny.bin`.
3. Remove GitHub Actions cache/download steps for `models/ggml-tiny.bin`.
4. Verify JSON and YAML parse.

### Task 2: Make Whisper Defaults Empty

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/App.tsx`

**Steps:**
1. Change default `whisper_model_path` to empty.
2. Change default `whisper_model_profiles` to empty.
3. Stop config normalization from re-adding bundled/local project model profiles.
4. Keep user-supplied Whisper paths and profiles intact.
5. Update UI status and copy so FunASR is the default capability and Whisper is optional.

### Task 3: Update Documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

**Steps:**
1. Document FunASR as the default path.
2. Move Whisper setup to optional local-recognition configuration.
3. Remove instructions that imply `ggml-tiny.bin` is downloaded or bundled by default.

### Verification

Run non-test checks only:
- `node` JSON parse for `package.json` and `src-tauri/tauri.conf.json`
- `ruby` YAML parse for `.github/workflows/release.yml`
- `cargo check`
- Optional TypeScript build only if needed; do not run test commands.
