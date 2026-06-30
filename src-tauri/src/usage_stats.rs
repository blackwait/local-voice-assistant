use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::app_data_dir;
use crate::AppConfig;
use crate::AppError;

const MAX_USAGE_EVENTS: usize = 2000;
const DEFAULT_TYPING_SPEED_CPM: u32 = 28;
const SAVINGS_CREDIT_RATIO: f64 = 0.7;
const MAX_SAVED_SECONDS_PER_SESSION: f64 = 120.0;
const MIN_CHARS_FOR_SAVINGS: u32 = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionMetrics {
    pub recording_seconds: f64,
    pub transcribe_seconds: f64,
    pub polish_seconds: f64,
    pub translation_seconds: f64,
}

impl Default for SessionMetrics {
    fn default() -> Self {
        Self {
            recording_seconds: 0.0,
            transcribe_seconds: 0.0,
            polish_seconds: 0.0,
            translation_seconds: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct UsageEvent {
    pub id: String,
    pub created_at: u64,
    pub char_count: u32,
    pub recording_seconds: f64,
    pub transcribe_seconds: f64,
    pub polish_seconds: f64,
    pub translation_seconds: f64,
    pub total_seconds: f64,
    pub estimated_typing_seconds: f64,
    pub saved_seconds: f64,
    pub polish_enabled: bool,
    pub translation_enabled: bool,
    pub service_profile: String,
    pub success: bool,
}

impl Default for UsageEvent {
    fn default() -> Self {
        Self {
            id: String::new(),
            created_at: 0,
            char_count: 0,
            recording_seconds: 0.0,
            transcribe_seconds: 0.0,
            polish_seconds: 0.0,
            translation_seconds: 0.0,
            total_seconds: 0.0,
            estimated_typing_seconds: 0.0,
            saved_seconds: 0.0,
            polish_enabled: true,
            translation_enabled: false,
            service_profile: "stable".to_string(),
            success: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DailyUsageBucket {
    pub date: String,
    pub sessions: u32,
    pub chars: u64,
    pub saved_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct HourlyUsageBucket {
    pub hour: u8,
    pub sessions: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageStatsSummary {
    pub total_sessions: u32,
    pub successful_sessions: u32,
    pub today_sessions: u32,
    pub week_sessions: u32,
    pub month_sessions: u32,
    pub active_days: u32,
    pub total_chars: u64,
    pub today_chars: u64,
    pub week_chars: u64,
    pub month_chars: u64,
    pub avg_chars_per_session: f64,
    pub total_recording_seconds: f64,
    pub total_processing_seconds: f64,
    pub total_estimated_typing_seconds: f64,
    pub total_saved_seconds: f64,
    pub today_saved_seconds: f64,
    pub week_saved_seconds: f64,
    pub month_saved_seconds: f64,
    pub avg_saved_per_session: f64,
    pub avg_total_seconds: f64,
    pub avg_transcribe_seconds: f64,
    pub avg_polish_seconds: f64,
    pub polish_usage_count: u32,
    pub translation_usage_count: u32,
    pub longest_session_chars: u32,
    pub typing_speed_cpm: u32,
    pub daily_last_14_days: Vec<DailyUsageBucket>,
    pub hourly_distribution: Vec<HourlyUsageBucket>,
    pub recent_events: Vec<UsageEvent>,
}

pub fn default_typing_speed_cpm() -> u32 {
    DEFAULT_TYPING_SPEED_CPM
}

pub fn wav_duration_seconds(audio: &[u8]) -> f64 {
    let cursor = std::io::Cursor::new(audio);
    let reader = match hound::WavReader::new(cursor) {
        Ok(reader) => reader,
        Err(_) => return 0.0,
    };
    let spec = reader.spec();
    if spec.sample_rate == 0 {
        return 0.0;
    }
    round_tenths(reader.len() as f64 / spec.sample_rate as f64)
}

pub fn count_typing_chars(text: &str) -> u32 {
    text.chars().filter(|ch| !ch.is_whitespace()).count() as u32
}

pub fn estimate_typing_seconds(char_count: u32, typing_speed_cpm: u32) -> f64 {
    if char_count < MIN_CHARS_FOR_SAVINGS {
        return 0.0;
    }
    let cpm = typing_speed_cpm.max(20) as f64;
    round_tenths((char_count as f64 / cpm) * 60.0)
}

pub fn compute_saved_seconds(
    char_count: u32,
    recording_seconds: f64,
    transcribe_seconds: f64,
    polish_seconds: f64,
    translation_seconds: f64,
    typing_speed_cpm: u32,
) -> (f64, f64) {
    let estimated = estimate_typing_seconds(char_count, typing_speed_cpm);
    if char_count < MIN_CHARS_FOR_SAVINGS || estimated <= 0.0 {
        return (estimated, 0.0);
    }

    let actual = round_tenths(
        recording_seconds.max(0.0)
            + transcribe_seconds.max(0.0)
            + polish_seconds.max(0.0)
            + translation_seconds.max(0.0),
    );
    let raw_saved = estimated - actual;
    if raw_saved <= 0.0 {
        return (estimated, 0.0);
    }

    let mut credited = raw_saved * SAVINGS_CREDIT_RATIO;
    if char_count < 20 {
        credited *= 0.6;
    } else if char_count < 50 {
        credited *= 0.8;
    }

    (
        estimated,
        round_tenths(credited.min(MAX_SAVED_SECONDS_PER_SESSION).max(0.0)),
    )
}

pub fn record_usage_event_inner(
    app: &AppHandle,
    config: &AppConfig,
    text: &str,
    metrics: &SessionMetrics,
) -> Result<UsageEvent, AppError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::Io("统计文本为空".to_string()));
    }

    let char_count = count_typing_chars(text);
    let typing_speed_cpm = config.typing_speed_cpm.max(20);
    let (estimated_typing_seconds, saved_seconds) = compute_saved_seconds(
        char_count,
        metrics.recording_seconds,
        metrics.transcribe_seconds,
        metrics.polish_seconds,
        metrics.translation_seconds,
        typing_speed_cpm,
    );
    let created_at = current_timestamp_millis();
    let event = UsageEvent {
        id: format!("usage-{created_at}-{char_count}"),
        created_at,
        char_count,
        recording_seconds: round_tenths(metrics.recording_seconds.max(0.0)),
        transcribe_seconds: round_tenths(metrics.transcribe_seconds.max(0.0)),
        polish_seconds: round_tenths(metrics.polish_seconds.max(0.0)),
        translation_seconds: round_tenths(metrics.translation_seconds.max(0.0)),
        total_seconds: round_tenths(
            metrics.recording_seconds.max(0.0)
                + metrics.transcribe_seconds.max(0.0)
                + metrics.polish_seconds.max(0.0)
                + metrics.translation_seconds.max(0.0),
        ),
        estimated_typing_seconds,
        saved_seconds,
        polish_enabled: config.polish_enabled,
        translation_enabled: config.translation_enabled,
        service_profile: normalize_service_profile(&config.service_profile),
        success: true,
    };

    let mut events = read_usage_events(app)?;
    events.insert(0, event.clone());
    normalize_usage_events(&mut events);
    write_usage_events(app, &events)?;
    Ok(event)
}

pub fn get_usage_stats_summary(app: &AppHandle, config: &AppConfig) -> Result<UsageStatsSummary, AppError> {
    let events = read_usage_events(app)?;
    let now = current_timestamp_millis();
    let today_start = start_of_local_day_millis(now);
    let week_start = today_start.saturating_sub(6 * 24 * 60 * 60 * 1000);
    let month_start = today_start.saturating_sub(29 * 24 * 60 * 60 * 1000);

    let mut summary = UsageStatsSummary {
        typing_speed_cpm: config.typing_speed_cpm.max(20),
        hourly_distribution: (0..24)
            .map(|hour| HourlyUsageBucket { hour, sessions: 0 })
            .collect(),
        daily_last_14_days: Vec::new(),
        recent_events: events.iter().take(12).cloned().collect(),
        ..Default::default()
    };

    let mut day_buckets: Vec<DailyUsageBucket> = Vec::new();
    for offset in (0..14).rev() {
        let day_start = today_start.saturating_sub(offset * 24 * 60 * 60 * 1000);
        day_buckets.push(DailyUsageBucket {
            date: format_day_label(day_start),
            sessions: 0,
            chars: 0,
            saved_seconds: 0.0,
        });
    }

    let mut active_day_set = std::collections::BTreeSet::new();

    for event in events.iter().filter(|event| event.success) {
        summary.total_sessions += 1;
        summary.successful_sessions += 1;
        summary.total_chars += event.char_count as u64;
        summary.total_recording_seconds += event.recording_seconds;
        summary.total_processing_seconds +=
            event.transcribe_seconds + event.polish_seconds + event.translation_seconds;
        summary.total_estimated_typing_seconds += event.estimated_typing_seconds;
        summary.total_saved_seconds += event.saved_seconds;
        summary.longest_session_chars = summary.longest_session_chars.max(event.char_count);
        if event.polish_seconds > 0.0 {
            summary.polish_usage_count += 1;
        }
        if event.translation_seconds > 0.0 {
            summary.translation_usage_count += 1;
        }

        if event.created_at >= today_start {
            summary.today_sessions += 1;
            summary.today_chars += event.char_count as u64;
            summary.today_saved_seconds += event.saved_seconds;
        }
        if event.created_at >= week_start {
            summary.week_sessions += 1;
            summary.week_chars += event.char_count as u64;
            summary.week_saved_seconds += event.saved_seconds;
        }
        if event.created_at >= month_start {
            summary.month_sessions += 1;
            summary.month_chars += event.char_count as u64;
            summary.month_saved_seconds += event.saved_seconds;
        }

        active_day_set.insert(start_of_local_day_millis(event.created_at));
        let hour = local_hour(event.created_at);
        if let Some(bucket) = summary.hourly_distribution.get_mut(hour as usize) {
            bucket.sessions += 1;
        }

        if let Some(bucket) = day_buckets.iter_mut().find(|bucket| {
            bucket.date == format_day_label(start_of_local_day_millis(event.created_at))
        }) {
            bucket.sessions += 1;
            bucket.chars += event.char_count as u64;
            bucket.saved_seconds += event.saved_seconds;
        }
    }

    summary.active_days = active_day_set.len() as u32;
    summary.daily_last_14_days = day_buckets;
    if summary.successful_sessions > 0 {
        let count = summary.successful_sessions as f64;
        summary.avg_chars_per_session = round_tenths(summary.total_chars as f64 / count);
        summary.avg_saved_per_session = round_tenths(summary.total_saved_seconds / count);
        summary.avg_total_seconds =
            round_tenths((summary.total_recording_seconds + summary.total_processing_seconds) / count);
        summary.avg_transcribe_seconds = round_tenths(
            events
                .iter()
                .filter(|event| event.success)
                .map(|event| event.transcribe_seconds)
                .sum::<f64>()
                / count,
        );
        summary.avg_polish_seconds = round_tenths(
            events
                .iter()
                .filter(|event| event.success)
                .map(|event| event.polish_seconds)
                .sum::<f64>()
                / count,
        );
    }

    Ok(summary)
}

pub fn clear_usage_events(app: &AppHandle) -> Result<(), AppError> {
    write_usage_events(app, &[])
}

fn usage_events_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    app_data_dir(app)
        .map_err(|error| AppError::Io(error))
        .map(|dir| dir.join("usage-events.json"))
}

fn read_usage_events(app: &AppHandle) -> Result<Vec<UsageEvent>, AppError> {
    let path = usage_events_path(app)?;
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|error| AppError::Io(error.to_string()))?;
    let mut events: Vec<UsageEvent> =
        serde_json::from_str(&text).map_err(|error| AppError::Io(error.to_string()))?;
    normalize_usage_events(&mut events);
    Ok(events)
}

fn write_usage_events(app: &AppHandle, events: &[UsageEvent]) -> Result<(), AppError> {
    let path = usage_events_path(app)?;
    ensure_parent(&path).map_err(AppError::Io)?;
    let mut next_events = events.to_vec();
    normalize_usage_events(&mut next_events);
    let text = serde_json::to_string_pretty(&next_events)
        .map_err(|error| AppError::Io(error.to_string()))?;
    fs::write(path, text).map_err(|error| AppError::Io(error.to_string()))
}

fn normalize_usage_events(events: &mut Vec<UsageEvent>) {
    events.retain(|event| event.success && event.char_count > 0);
    events.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    events.dedup_by(|left, right| left.id == right.id);
    if events.len() > MAX_USAGE_EVENTS {
        events.truncate(MAX_USAGE_EVENTS);
    }
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn normalize_service_profile(profile: &str) -> String {
    match profile.trim() {
        "fast" => "fast".to_string(),
        "custom" => "custom".to_string(),
        _ => "stable".to_string(),
    }
}

fn current_timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn start_of_local_day_millis(timestamp: u64) -> u64 {
    let seconds = (timestamp / 1000) as i64;
    let days = seconds / 86_400;
    (days * 86_400) as u64 * 1000
}

fn local_hour(timestamp: u64) -> u8 {
    let seconds = (timestamp / 1000) as i64;
    ((seconds % 86_400) / 3600).clamp(0, 23) as u8
}

fn format_day_label(day_start_millis: u64) -> String {
    let days = (day_start_millis / 1000 / 86_400) as i64;
    format!("day-{days}")
}

fn round_tenths(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

impl Default for UsageStatsSummary {
    fn default() -> Self {
        Self {
            total_sessions: 0,
            successful_sessions: 0,
            today_sessions: 0,
            week_sessions: 0,
            month_sessions: 0,
            active_days: 0,
            total_chars: 0,
            today_chars: 0,
            week_chars: 0,
            month_chars: 0,
            avg_chars_per_session: 0.0,
            total_recording_seconds: 0.0,
            total_processing_seconds: 0.0,
            total_estimated_typing_seconds: 0.0,
            total_saved_seconds: 0.0,
            today_saved_seconds: 0.0,
            week_saved_seconds: 0.0,
            month_saved_seconds: 0.0,
            avg_saved_per_session: 0.0,
            avg_total_seconds: 0.0,
            avg_transcribe_seconds: 0.0,
            avg_polish_seconds: 0.0,
            polish_usage_count: 0,
            translation_usage_count: 0,
            longest_session_chars: 0,
            typing_speed_cpm: DEFAULT_TYPING_SPEED_CPM,
            daily_last_14_days: Vec::new(),
            hourly_distribution: Vec::new(),
            recent_events: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_should_not_overestimate_savings() {
        let (estimated, saved) = compute_saved_seconds(5, 2.0, 1.0, 1.0, 0.0, 28);
        assert_eq!(estimated, 0.0);
        assert_eq!(saved, 0.0);
    }

    #[test]
    fn medium_text_should_credit_conservative_savings() {
        let (estimated, saved) = compute_saved_seconds(80, 12.0, 2.0, 1.5, 0.0, 28);
        assert!(estimated > 0.0);
        assert!(saved > 0.0);
        assert!(saved < estimated);
        assert!(saved <= MAX_SAVED_SECONDS_PER_SESSION);
    }
}
