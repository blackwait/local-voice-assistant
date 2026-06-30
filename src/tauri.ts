import { invoke } from "@tauri-apps/api/core";

export type ServiceProfile = "stable" | "fast" | "custom";

export interface SessionMetrics {
  recording_seconds: number;
  transcribe_seconds: number;
  polish_seconds: number;
  translation_seconds: number;
}

export interface DailyUsageBucket {
  date: string;
  sessions: number;
  chars: number;
  saved_seconds: number;
}

export interface HourlyUsageBucket {
  hour: number;
  sessions: number;
}

export interface UsageEvent {
  id: string;
  created_at: number;
  char_count: number;
  recording_seconds: number;
  transcribe_seconds: number;
  polish_seconds: number;
  translation_seconds: number;
  total_seconds: number;
  estimated_typing_seconds: number;
  saved_seconds: number;
  polish_enabled: boolean;
  translation_enabled: boolean;
  service_profile: string;
  success: boolean;
}

export interface UsageStatsSummary {
  total_sessions: number;
  successful_sessions: number;
  today_sessions: number;
  week_sessions: number;
  month_sessions: number;
  active_days: number;
  total_chars: number;
  today_chars: number;
  week_chars: number;
  month_chars: number;
  avg_chars_per_session: number;
  total_recording_seconds: number;
  total_processing_seconds: number;
  total_estimated_typing_seconds: number;
  total_saved_seconds: number;
  today_saved_seconds: number;
  week_saved_seconds: number;
  month_saved_seconds: number;
  avg_saved_per_session: number;
  avg_total_seconds: number;
  avg_transcribe_seconds: number;
  avg_polish_seconds: number;
  polish_usage_count: number;
  translation_usage_count: number;
  longest_session_chars: number;
  typing_speed_cpm: number;
  daily_last_14_days: DailyUsageBucket[];
  hourly_distribution: HourlyUsageBucket[];
  recent_events: UsageEvent[];
}

export interface AppConfig {
  whisper_cli_path: string;
  whisper_model_path: string;
  whisper_model_profiles: WhisperModelProfile[];
  whisper_threads: string;
  asr_engine: string;
  service_profile: ServiceProfile;
  funasr_endpoint: string;
  funasr_model: string;
  funasr_device: string;
  deepseek_api_key: string;
  deepseek_model: string;
  deepseek_endpoint: string;
  llm_base_url: string;
  deepseek_key_configured: boolean;
  translation_enabled: boolean;
  polish_enabled: boolean;
  target_language: string;
  config_path: string;
  record_shortcut: string;
  shortcut_enabled: boolean;
  polish_prompt: string;
  typing_speed_cpm: number;
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

export interface FunAsrResolveView {
  ok: boolean;
  service_profile: string;
  funasr_endpoint: string;
  deepseek_endpoint: string;
  message: string;
  model: string;
  device: string;
  fallback_used: boolean;
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

export function resolveFunasrService() {
  return invoke<FunAsrResolveView>("resolve_funasr_service");
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

export function recordVoiceSession(text: string, metrics: SessionMetrics) {
  return invoke<VoiceHistoryItem>("record_voice_session", { text, metrics });
}

export function getUsageStats() {
  return invoke<UsageStatsSummary>("get_usage_stats");
}

export function clearUsageStats() {
  return invoke<void>("clear_usage_stats");
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
