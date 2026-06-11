import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = resolve(rootDir, "models", "ggml-tiny.bin");
const tmpPath = `${modelPath}.tmp`;
const modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin";
const minSizeBytes = 70_000_000;

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

console.log(`Downloading Whisper tiny model to ${modelPath}`);
const response = await fetch(modelUrl, { redirect: "follow" });
if (!response.ok || !response.body) {
  throw new Error(`Failed to download model: ${response.status} ${response.statusText}`);
}

await pipeline(response.body, createWriteStream(tmpPath));
renameSync(tmpPath, modelPath);
console.log(`Whisper tiny model ready: ${modelPath}`);
