import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = resolve(rootDir, "models", "ggml-tiny.bin");
const tmpPath = `${modelPath}.tmp`;
const modelUrls = [
  process.env.WHISPER_TINY_MODEL_URL,
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"
].filter(Boolean);
const minSizeBytes = 70_000_000;
const maxAttempts = 3;

mkdirSync(dirname(modelPath), { recursive: true });

if (existsSync(modelPath) && statSync(modelPath).size >= minSizeBytes) {
  console.log(`Whisper tiny model already exists: ${modelPath}`);
  process.exit(0);
}

if (existsSync(modelPath)) {
  console.log(`Existing model file is incomplete, re-downloading: ${modelPath}`);
  rmSync(modelPath);
}
if (existsSync(tmpPath)) {
  rmSync(tmpPath);
}

let lastError;
for (const modelUrl of modelUrls) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await downloadModel(modelUrl, attempt);
      console.log(`Whisper tiny model ready: ${modelPath}`);
      process.exit(0);
    } catch (error) {
      lastError = error;
      if (existsSync(tmpPath)) {
        rmSync(tmpPath);
      }
      console.warn(
        `Download attempt ${attempt}/${maxAttempts} failed for ${modelUrl}: ${formatError(error)}`
      );
    }
  }
}

throw new Error(`Failed to download Whisper tiny model: ${formatError(lastError)}`);

async function downloadModel(modelUrl, attempt) {
  console.log(`Downloading Whisper tiny model to ${modelPath} (attempt ${attempt}/${maxAttempts})`);
  const response = await fetch(modelUrl, {
    redirect: "follow",
    headers: {
      "user-agent": "local-voice-assistant-release-build"
    }
  });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(tmpPath));

  const downloadedSize = statSync(tmpPath).size;
  if (downloadedSize < minSizeBytes) {
    throw new Error(`downloaded file is too small: ${downloadedSize} bytes`);
  }

  renameSync(tmpPath, modelPath);
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "unknown error";
}
