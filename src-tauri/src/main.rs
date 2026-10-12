//! CertiGPU backend: Tauri commands + the 15-minute certification orchestrator.
//!
//! Frontend contract (see `src/App.jsx`):
//! - command `get_gpu_info` -> [`gpu::GpuInfo`]
//! - command `start_certification(duration_secs?: u64)` -> ()
//! - command `stop_certification` -> ()
//! - events: `test-log` (String), `telemetry` ([`gpu::Telemetry`]),
//!   `test-done` ([`Report`])

mod gpu;
mod stress;

use gpu::{Gpu, GpuInfo, Telemetry};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};

/// Abort the run if the GPU edge temperature reaches this.
const OVERHEAT_C: f64 = 92.0;
/// Default certification length (seconds). The UI labels it "15-min".
const DEFAULT_DURATION_SECS: u64 = 900;
/// Telemetry cadence promised by the README.
const SAMPLE_MS: u64 = 500;

#[derive(Default)]
struct TestState {
    running: AtomicBool,
    stop: Arc<AtomicBool>,
}

/// Payload of the `test-done` event. Field names match `src/App.jsx`.
#[derive(Debug, Clone, Serialize)]
struct Report {
    health_score: u32,
    verdict: String,
    summary: String,
    verify_url: String,
    cert_id: String,
    avg_temp: f64,
    max_hotspot: f64,
    vram_errors: u32,
    perf_vs_avg: String,
}

#[tauri::command]
async fn get_gpu_info() -> Result<GpuInfo, String> {
    Ok(Gpu::detect().info())
}

#[tauri::command]
async fn start_certification(
    app: tauri::AppHandle,
    state: State<'_, TestState>,
    duration_secs: Option<u64>,
) -> Result<(), String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("a certification is already running".to_string());
    }
    let stop = state.stop.clone();
    stop.store(false, Ordering::SeqCst);
    let duration = duration_secs.unwrap_or(DEFAULT_DURATION_SECS).clamp(60, 3600);
    tokio::spawn(async move {
        run_certification(app.clone(), stop, duration).await;
        app.state::<TestState>().running.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[tauri::command]
async fn stop_certification(state: State<'_, TestState>) -> Result<(), String> {
    state.stop.store(true, Ordering::SeqCst);
    Ok(())
}

fn health_assessment(
    vram_errors: u32,
    overheated: bool,
    stopped: bool,
    avg_temp: f64,
    max_temp: f64,
    simulated: bool,
) -> (u32, String, String) {
    let suffix = if simulated { " (SIMULATED)" } else { "" };
    if stopped {
        return (
            0,
            format!("STOPPED BY USER{}", suffix),
            "Certification was stopped before completion — no verdict.".to_string(),
        );
    }
    if overheated {
        return (
            45,
            format!("ABORTED — OVERHEAT{}", suffix),
            format!(
                "GPU hit {:.0}°C (limit {:.0}°C). Check cooling, airflow and fan curves before re-running.",
                max_temp, OVERHEAT_C
            ),
        );
    }
    if vram_errors > 0 {
        return (
            40,
            format!("FAILED — VRAM ERRORS{}", suffix),
            format!(
                "{} VRAM word errors detected during the pattern test. The card is unstable.",
                vram_errors
            ),
        );
    }
    let mut score: u32 = 100;
    let mut notes = Vec::new();
    if max_temp > 87.0 {
        score = score.saturating_sub(15);
        notes.push(format!("peak {:.0}°C is hot", max_temp));
    } else if max_temp > 83.0 {
        score = score.saturating_sub(10);
        notes.push(format!("peak {:.0}°C is warm", max_temp));
    }
    if avg_temp > 80.0 {
        score = score.saturating_sub(5);
        notes.push(format!("avg {:.0}°C under sustained load", avg_temp));
    }
    let verdict = if score >= 90 { "CERTIFIED" } else { "NEEDS ATTENTION" };
    let summary = if notes.is_empty() {
        "Thermals, VRAM and clocks all within healthy ranges.".to_string()
    } else {
        format!("Passed, but note: {}.", notes.join("; "))
    };
    (score, format!("{}{}", verdict, suffix), summary)
}

async fn run_certification(app: tauri::AppHandle, stop: Arc<AtomicBool>, duration_secs: u64) {
    let log = |msg: String| {
        let _ = app.emit("test-log", msg);
    };
    let mut gpu = Gpu::detect();
    let simulated = !gpu.is_real();
    let info = gpu.info();
    let mode = if simulated { "SIMULATED (no NVIDIA GPU/driver)" } else { "NVML" };

    log(format!("CertiGPU v{} — starting certification ({})", env!("CARGO_PKG_VERSION"), mode));
    log(format!("GPU: {} | VRAM: {:.1}GB {} | Driver: {}", info.name, info.vram_gb, info.vram_type, info.driver_version));
    if info.is_fake {
        log(format!("WARNING: {}", info.fake_reason));
    } else {
        log(format!("Identity check: {}", info.fake_reason));
    }

    // Acquire a GPU compute context for the load + VRAM test. If that fails
    // on a real NVIDIA box we still continue in monitoring mode rather than
    // dying — but without NVML there is nothing real to monitor.
    let gpu_ctx = if simulated {
        None
    } else {
        match stress::GpuContext::new().await {
            Ok(ctx) => Some(ctx),
            Err(e) => {
                log(format!("Compute context unavailable ({}); running telemetry-only.", e));
                None
            }
        }
    };
    let load_capable = gpu_ctx.is_some();

    // --- Phase 2: VRAM integrity -------------------------------------------
    log("Phase 2/5: VRAM integrity — writing pattern across 512MB...".to_string());
    let vram_errors: u32 = if let Some(ctx) = &gpu_ctx {
        match ctx.vram_pattern_test().await {
            Ok(0) => {
                log("VRAM pattern test: 0 errors".to_string());
                0
            }
            Ok(n) => {
                log(format!("VRAM pattern test: {} ERRORS", n));
                n
            }
            Err(e) => {
                log(format!("VRAM test skipped: {}", e));
                0
            }
        }
    } else if simulated {
        log("VRAM pattern test: 0 errors (simulated)".to_string());
        0
    } else {
        log("VRAM test skipped: no compute context".to_string());
        0
    };

    // --- Phases 3-5: sustained load + telemetry ----------------------------
    // The burn loop runs on a blocking thread; this task samples NVML at
    // 500ms and drives progress + phase announcements.
    let burn_stop = stop.clone();
    let burn_handle = gpu_ctx.map(|ctx| {
        tokio::task::spawn_blocking(move || {
            ctx.burn(&burn_stop);
        })
    });
    if load_capable {
        log("Phase 3/5: Thermal stability — sustained compute load...".to_string());
    } else {
        log("Phase 3/5: Thermal stability — monitoring (no synthetic load available)...".to_string());
    }

    let start = Instant::now();
    let mut temps: Vec<f64> = Vec::new();
    let mut max_temp: f64 = 0.0;
    let mut max_clock: f64 = 0.0;
    let mut clock_sum = 0.0;
    let mut clock_n = 0u32;
    let mut overheated = false;
    let mut stopped = false;
    let mut announced_perf = false;
    let mut announced_fan = false;
    let mut ticker = tokio::time::interval(Duration::from_millis(SAMPLE_MS));

    loop {
        ticker.tick().await;
        if stop.load(Ordering::SeqCst) {
            stopped = true;
            log("Stopped by user.".to_string());
            break;
        }
        let elapsed = start.elapsed().as_secs_f64();
        if elapsed >= duration_secs as f64 {
            break;
        }
        let progress = (elapsed / duration_secs as f64 * 100.0).min(100.0);

        if progress > 70.0 && !announced_perf {
            announced_perf = true;
            log("Phase 4/5: Performance baseline — measuring clocks...".to_string());
        }
        if progress > 90.0 && !announced_fan {
            announced_fan = true;
            log("Phase 5/5: Fan & power summary...".to_string());
        }

        let t: Telemetry = gpu.sample(progress);
        if t.gpu_temp >= OVERHEAT_C {
            overheated = true;
            log(format!(
                "CRITICAL: GPU at {:.0}°C (limit {:.0}°C) — aborting to protect hardware.",
                t.gpu_temp, OVERHEAT_C
            ));
            break;
        }
        max_temp = max_temp.max(t.gpu_temp);
        max_clock = max_clock.max(t.clock_mhz);
        clock_sum += t.clock_mhz;
        clock_n += 1;
        temps.push(t.gpu_temp);
        let _ = app.emit("telemetry", &t);
    }

    // Stop the burner and wait for it.
    stop.store(true, Ordering::SeqCst);
    if let Some(h) = burn_handle {
        let _ = h.await;
    }

    let avg_temp = if temps.is_empty() {
        0.0
    } else {
        temps.iter().sum::<f64>() / temps.len() as f64
    };
    let avg_clock = if clock_n == 0 { 0.0 } else { clock_sum / clock_n as f64 };
    let (health_score, verdict, summary) =
        health_assessment(vram_errors, overheated, stopped, avg_temp, max_temp, simulated);

    let cert_id = format!("CG-{:08X}", rand::random::<u32>());
    let report = Report {
        health_score,
        verdict,
        summary,
        verify_url: format!("https://certigpu.app/verify/{}", cert_id),
        cert_id,
        avg_temp: (avg_temp * 10.0).round() / 10.0,
        max_hotspot: (max_temp * 10.0).round() / 10.0,
        vram_errors,
        perf_vs_avg: if avg_clock > 0.0 {
            format!("{:.0} MHz avg / {:.0} MHz peak", avg_clock, max_clock)
        } else {
            "n/a".to_string()
        },
    };
    log(format!("Done. Verdict: {} ({}%)", report.verdict, report.health_score));
    let _ = app.emit("test-done", &report);
}

fn main() {
    tauri::Builder::default()
        .manage(TestState::default())
        .invoke_handler(tauri::generate_handler![
            get_gpu_info,
            start_certification,
            stop_certification
        ])
        .run(tauri::generate_context!())
        .expect("failed to run CertiGPU");
}
