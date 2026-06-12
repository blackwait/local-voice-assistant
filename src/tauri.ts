import { invoke } from "@tauri-apps/api/core";

export interface AppConfig {
  whisper_cli_path: string;
  whisper_model_path: string;
  whisper_model_profiles: WhisperModelProfile[];
  whisper_threads: string;
  asr_engine: string;
  funasr_endpoint: string;
  funasr_model: string;
  funasr_device: string;
  deepseek_api_key: string;
  deepseek_model: string;
  deepseek_endpoint: string;
  deepseek_key_configured: boolean;
  translation_enabled: boolean;
  target_language: string;
  config_path: string;
  record_shortcut: string;
  shortcut_enabled: boolean;
  polish_prompt: string;
}

export interface WhisperModelProfile {
  name: string;
  path: string;
  speed_hint: string;
}

export interface AssistantResult {
  corrected_text: string;
  translation: string;
  notes: string[];
  confidence: "high" | "medium" | "low";
}

export interface CorrectionResult {
  corrected_text: string;
  notes: string[];
  confidence: "high" | "medium" | "low";
}

export interface FunAsrHealthView {
  ok: boolean;
  message: string;
  model: string;
  device: string;
}

export interface AccessibilityPermissionView {
  trusted: boolean;
  platform: string;
}

export interface NativeRecordingHealthView {
  ok: boolean;
  message: string;
  device: string;
  sample_rate: number;
  channels: number;
}

export interface VoiceHistoryItem {
  id: string;
  text: string;
  created_at: number;
}

export function getAppConfig() {
  return invoke<AppConfig>("get_app_config");
}

export function loadConfig() {
  return invoke<AppConfig>("load_config");
}

export function saveConfig(config: AppConfig) {
  return invoke<AppConfig>("save_config", { config });
}

export function startNativeRecording() {
  return invoke<void>("start_native_recording");
}

export function cancelNativeRecording() {
  return invoke<void>("cancel_native_recording");
}

export function closeVoiceOverlay() {
  return invoke<void>("close_voice_overlay");
}

export function stopRecordingAndTranscribe() {
  return invoke<string>("stop_recording_and_transcribe");
}

export function startFunasrService() {
  return invoke<string>("start_funasr_service");
}

export function checkFunasrService() {
  return invoke<FunAsrHealthView>("check_funasr_service");
}

export function polishText(input: string) {
  return invoke<CorrectionResult>("polish_text", { input });
}

export function getDefaultPolishPrompt() {
  return invoke<string>("default_polish_prompt");
}

export function translateText(input: string, targetLanguage: string) {
  return invoke<string>("translate_text", {
    input,
    targetLanguage
  });
}

export function outputTextToCursor(text: string) {
  return invoke<void>("output_text_to_cursor", { text });
}

export function checkAccessibilityPermission() {
  return invoke<AccessibilityPermissionView>("check_accessibility_permission");
}

export function checkNativeRecording() {
  return invoke<NativeRecordingHealthView>("check_native_recording");
}

export function openAccessibilitySettings() {
  return invoke<void>("open_accessibility_settings");
}

export function copyTextToClipboard(text: string) {
  return invoke<void>("copy_text_to_clipboard", { text });
}

export function recordVoiceHistory(text: string) {
  return invoke<VoiceHistoryItem>("record_voice_history", { text });
}

export function listVoiceHistory() {
  return invoke<VoiceHistoryItem[]>("list_voice_history");
}

export function deleteVoiceHistory(id: string) {
  return invoke<VoiceHistoryItem[]>("delete_voice_history", { id });
}

export function clearVoiceHistory() {
  return invoke<void>("clear_voice_history");
}

export function polishAndTranslate(input: string, targetLanguage: string) {
  return invoke<AssistantResult>("polish_and_translate", {
    input,
    targetLanguage
  });
}
