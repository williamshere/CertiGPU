//! Free GPU and CPU stress testing commands and event orchestration.
mod cpu;
mod gpu;
mod stress;

use gpu::{Gpu, GpuInfo};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tauri::{Emitter, State};

const OVERHEAT_C: f64 = 92.0;
#[derive(Default, Clone)]
struct TestState {
    running: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
struct Report {
    health_score: u32,
    verdict: String,
    summary: String,
    verify_url: String,
    cert_id: String,
    avg_temp: Option<f64>,
    max_hotspot: Option<f64>,
    vram_errors: Option<u32>,
    cpu_errors: Option<u64>,
    perf_vs_avg: String,
}
#[derive(Serialize)]
struct CpuInfo {
    name: String,
    logical_threads: usize,
    arch: String,
}

#[tauri::command]
async fn get_gpu_info() -> Result<GpuInfo, String> {
    Ok(Gpu::detect().info())
}
#[tauri::command]
fn get_cpu_info() -> CpuInfo {
    let name = std::fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|text| {
            text.lines().find_map(|line| {
                line.strip_prefix("model name")
                    .and_then(|rest| rest.split_once(':'))
                    .map(|(_, name)| name.trim().to_owned())
            })
        })
        .or_else(|| std::env::var("PROCESSOR_IDENTIFIER").ok())
        .unwrap_or_else(|| format!("{} processor", std::env::consts::ARCH));
    CpuInfo {
        name,
        logical_threads: cpu::logical_threads(),
        arch: std::env::consts::ARCH.into(),
    }
}

fn begin(state: &TestState) -> Result<Arc<AtomicBool>, String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("A hardware test is already running".into());
    }
    state.stop.store(false, Ordering::SeqCst);
    Ok(state.stop.clone())
}
// Reset both flags after every exit, including panics; cancel any surviving workers.
struct RunGuard {
    running: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}
impl Drop for RunGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.running.store(false, Ordering::SeqCst);
    }
}
fn launch<F>(app: tauri::AppHandle, state: &TestState, task: F)
where
    F: std::future::Future<Output = Result<Report, String>> + Send + 'static,
{
    let running = state.running.clone();
    let stop = state.stop.clone();
    tokio::spawn(async move {
        let result = {
            let _guard = RunGuard { running, stop };
            tokio::spawn(task).await
        };
        match result {
            Ok(Ok(report)) => {
                let _ = app.emit("test-done", report);
            }
            Ok(Err(error)) => {
                let _ = app.emit("test-error", error);
            }
            Err(error) => {
                let _ = app.emit("test-error", format!("Worker terminated: {error}"));
            }
        }
    });
}

#[tauri::command]
async fn start_certification(
    app: tauri::AppHandle,
    state: State<'_, TestState>,
    duration_secs: Option<u64>,
    workload: Option<String>,
    intensity: Option<u64>,
    temperature_limit: Option<f64>,
    sample_ms: Option<u64>,
) -> Result<(), String> {
    let workload = workload.unwrap_or_else(|| "full".into());
    if !["full", "compute", "vram"].contains(&workload.as_str()) {
        return Err("Unknown GPU workload".into());
    }
    let limit = temperature_limit.unwrap_or(85.0);
    if !limit.is_finite() || !(60.0..=OVERHEAT_C).contains(&limit) {
        return Err("GPU temperature limit must be 60–92°C".into());
    }
    let stop = begin(&state)?;
    launch(
        app.clone(),
        &state,
        run_gpu(
            app,
            stop,
            duration_secs.unwrap_or(300).clamp(60, 3600),
            workload,
            intensity.unwrap_or(80).clamp(10, 100),
            limit,
            sample_ms.unwrap_or(1000).clamp(500, 2000),
        ),
    );
    Ok(())
}
#[tauri::command]
async fn start_cpu_test(
    app: tauri::AppHandle,
    state: State<'_, TestState>,
    duration_secs: Option<u64>,
    workload: Option<String>,
    intensity: Option<u64>,
    threads: Option<usize>,
    sample_ms: Option<u64>,
) -> Result<(), String> {
    let workload = workload.unwrap_or_else(|| "mixed".into());
    if !["mixed", "integer", "float", "memory"].contains(&workload.as_str()) {
        return Err("Unknown CPU workload".into());
    }
    let stop = begin(&state)?;
    launch(
        app.clone(),
        &state,
        run_cpu(
            app,
            stop,
            duration_secs.unwrap_or(300).clamp(60, 3600),
            workload,
            intensity.unwrap_or(80).clamp(10, 100),
            threads
                .unwrap_or(4)
                .clamp(1, cpu::logical_threads().min(32)),
            sample_ms.unwrap_or(1000).clamp(500, 2000),
        ),
    );
    Ok(())
}
#[tauri::command]
async fn stop_certification(state: State<'_, TestState>) -> Result<(), String> {
    state.stop.store(true, Ordering::SeqCst);
    Ok(())
}

async fn run_cpu(
    app: tauri::AppHandle,
    stop: Arc<AtomicBool>,
    seconds: u64,
    workload: String,
    intensity: u64,
    threads: usize,
    sample_ms: u64,
) -> Result<Report, String> {
    let _ = app.emit("test-log", format!("CPU {workload}: {threads} threads at {intensity}% duty cycle. Temperature monitoring unavailable; monitor externally."));
    let batches = Arc::new(AtomicU64::new(0));
    let errors = Arc::new(AtomicU64::new(0));
    let start = Instant::now();
    let deadline = start + Duration::from_secs(seconds);
    let handles: Vec<_> = (0..threads)
        .map(|_| {
            let (stop, batches, errors, workload) = (
                stop.clone(),
                batches.clone(),
                errors.clone(),
                workload.clone(),
            );
            tokio::task::spawn_blocking(move || {
                cpu::run_worker(stop, batches, errors, workload, intensity, deadline)
            })
        })
        .collect();
    let mut ticker = tokio::time::interval(Duration::from_millis(sample_ms));
    while Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
        ticker.tick().await;
        let _ = app.emit("telemetry", serde_json::json!({ "progress": (start.elapsed().as_secs_f64() / seconds as f64 * 100.0).min(100.0), "cpu_ops": batches.load(Ordering::Relaxed) }));
        if handles.iter().any(|h| h.is_finished()) && Instant::now() < deadline {
            stop.store(true, Ordering::SeqCst);
        }
    }
    let stopped = stop.load(Ordering::SeqCst);
    stop.store(true, Ordering::SeqCst);
    for handle in handles {
        handle
            .await
            .map_err(|e| format!("CPU worker failed: {e}"))?;
    }
    let errors = errors.load(Ordering::Relaxed);
    let verdict = if errors > 0 {
        "FAILED — CPU ERRORS"
    } else if stopped {
        "STOPPED BY USER"
    } else {
        "COMPLETED"
    };
    let _ = app.emit(
        "test-log",
        format!(
            "{verdict}: {} verified batches, {errors} errors.",
            batches.load(Ordering::Relaxed)
        ),
    );
    Ok(Report { health_score: 0, verdict: verdict.into(), summary: format!("{threads} threads; {} verified batches; {errors} errors. CPU temperature was not measured. This is a workload result, not a thermal certification.", batches.load(Ordering::Relaxed)), verify_url: String::new(), cert_id: format!("CPU-{:016X}", rand::random::<u64>()), avg_temp: None, max_hotspot: None, vram_errors: None, cpu_errors: Some(errors), perf_vs_avg: format!("{:.0} batches/s", batches.load(Ordering::Relaxed) as f64 / start.elapsed().as_secs_f64().max(0.001)) })
}

async fn run_gpu(
    app: tauri::AppHandle,
    stop: Arc<AtomicBool>,
    seconds: u64,
    workload: String,
    intensity: u64,
    limit: f64,
    sample_ms: u64,
) -> Result<Report, String> {
    let mut gpu = Gpu::detect();
    if !gpu.is_real() {
        return Err("NVIDIA telemetry unavailable. Use the clearly labeled demo instead.".into());
    }
    if let Gpu::Real(nvml) = &gpu {
        if nvml.device_count().map_err(|e| e.to_string())? != 1 {
            return Err("GPU testing currently requires a single NVIDIA device to match telemetry and compute reliably.".into());
        }
    }
    let ctx = stress::GpuContext::new(&gpu.info().name).await?;
    let start = Instant::now();
    let deadline = start + Duration::from_secs(seconds);
    let mut temps = Vec::new();
    let mut peak = 0.0f64;
    let mut clock_sum = 0.0;
    let mut vram_errors = None;
    let mut overheated = false;
    let mut compute_dispatches = 0u64;
    let _ = app.emit(
        "test-log",
        format!("GPU {workload}: {seconds}s at {intensity}% duty cycle; thermal cutoff {limit}°C."),
    );
    let mut next_sample = start;
    while Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
        if Instant::now() >= next_sample {
            let sample =
                gpu.sample((start.elapsed().as_secs_f64() / seconds as f64 * 100.0).min(100.0));
            if sample.gpu_temp <= 0.0 {
                return Err("GPU temperature sensor unavailable; test aborted.".into());
            }
            peak = peak.max(sample.gpu_temp);
            temps.push(sample.gpu_temp);
            clock_sum += sample.clock_mhz;
            let _ = app.emit("telemetry", &sample);
            if sample.gpu_temp >= limit {
                overheated = true;
                break;
            }
            next_sample = Instant::now() + Duration::from_millis(sample_ms);
        }
        if stop.load(Ordering::SeqCst) || Instant::now() >= deadline {
            break;
        }
        // Dispatch continuously; telemetry sampling must not pace the GPU load.
        let dispatch_start = Instant::now();
        if workload == "vram" || (workload == "full" && vram_errors.is_none()) {
            let _ = app.emit(
                "test-log",
                "Verifying VRAM: zero, all-one, alternating and address patterns (32 MiB window)."
                    .to_owned(),
            );
            let result = ctx
                .vram_pattern_test(&stop, deadline, || {
                    let sample = gpu.sample(0.0);
                    if sample.gpu_temp <= 0.0 {
                        return Err("GPU temperature sensor lost".into());
                    }
                    peak = peak.max(sample.gpu_temp);
                    if sample.gpu_temp >= limit {
                        overheated = true;
                        return Err("GPU temperature limit reached".into());
                    }
                    Ok(())
                })
                .await;
            match result {
                Ok(n) => {
                    vram_errors = Some(vram_errors.unwrap_or(0u32).saturating_add(n));
                }
                Err(_) if overheated => break,
                Err(_) if stop.load(Ordering::SeqCst) || Instant::now() >= deadline => break,
                Err(e) => return Err(e),
            }
            if vram_errors.unwrap_or(0) > 0 {
                break;
            }
            let _ = app.emit("test-log", "VRAM pass complete: 0 errors.".to_owned());
        } else {
            ctx.burn_once();
            compute_dispatches += 1;
        }
        // Approximate duty cycle; thermal and telemetry checks remain bounded.
        let idle_until = Instant::now()
            + dispatch_start
                .elapsed()
                .mul_f64((100 - intensity) as f64 / intensity as f64);
        while Instant::now() < idle_until
            && Instant::now() < deadline
            && !stop.load(Ordering::SeqCst)
        {
            tokio::time::sleep(
                idle_until
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(100)),
            )
            .await;
        }
        tokio::task::yield_now().await;
    }
    let stopped = stop.load(Ordering::SeqCst);
    if temps.is_empty() {
        return Err("No telemetry collected".into());
    }
    let avg = temps.iter().sum::<f64>() / temps.len() as f64;
    let (mut score, mut verdict, mut summary) = health_assessment(
        vram_errors.unwrap_or(0),
        overheated,
        stopped,
        avg,
        peak,
        false,
    );
    if overheated {
        summary = format!("GPU reached {peak:.0}°C. Configured limit: {limit:.0}°C. Test aborted.");
    }
    if !stopped
        && !overheated
        && vram_errors.unwrap_or(0) == 0
        && (workload != "full" || vram_errors.is_none() || compute_dispatches == 0)
    {
        score = 0;
        verdict = "COMPLETED — LIMITED SCOPE".into();
        summary = format!("{workload} workload completed. A full compute and VRAM run is required for certification.");
    }
    if gpu.info().is_fake {
        score = 0;
        verdict = "IDENTITY CHECK FAILED".into();
        summary = gpu.info().fake_reason;
    }
    let _ = app.emit("test-log", format!("{verdict}. Peak {peak:.1}°C."));
    Ok(Report {
        health_score: score,
        verdict,
        summary,
        verify_url: String::new(),
        cert_id: format!("CG-{:016X}", rand::random::<u64>()),
        avg_temp: Some(avg),
        max_hotspot: Some(peak),
        vram_errors,
        cpu_errors: None,
        perf_vs_avg: format!(
            "{:.0} MHz average graphics clock",
            clock_sum / temps.len() as f64
        ),
    })
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
            "Certification was stopped before completion \u{2014} no verdict.".to_string(),
        );
    }
    if overheated {
        return (
            45,
            format!("ABORTED \u{2014} OVERHEAT{}", suffix),
            format!(
                "GPU hit {:.0}°C (limit {:.0}°C). Check cooling, airflow and fan curves before re-running.",
                max_temp, OVERHEAT_C
            ),
        );
    }
    if vram_errors > 0 {
        return (
            40,
            format!("FAILED \u{2014} VRAM ERRORS{}", suffix),
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
    let verdict = if score >= 90 {
        "CERTIFIED"
    } else {
        "NEEDS ATTENTION"
    };
    let summary = if notes.is_empty() {
        "Thermals, VRAM and clocks all within healthy ranges.".to_string()
    } else {
        format!("Passed, but note: {}.", notes.join("; "))
    };
    (score, format!("{}{}", verdict, suffix), summary)
}

fn main() {
    tauri::Builder::default()
        .manage(TestState::default())
        .invoke_handler(tauri::generate_handler![
            get_gpu_info,
            get_cpu_info,
            start_certification,
            start_cpu_test,
            stop_certification
        ])
        .run(tauri::generate_context!())
        .expect("failed to run CertiGPU");
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_health_assessment_stopped() {
        let (score, verdict, _) = health_assessment(0, false, true, 50.0, 60.0, false);
        assert_eq!(score, 0);
        assert_eq!(verdict, "STOPPED BY USER");
    }

    #[test]
    fn test_health_assessment_overheated() {
        let (score, verdict, _) = health_assessment(0, true, false, 80.0, 95.0, false);
        assert_eq!(score, 45);
        assert_eq!(verdict, "ABORTED — OVERHEAT");
    }

    #[test]
    fn test_health_assessment_vram_errors() {
        let (score, verdict, _) = health_assessment(5, false, false, 60.0, 70.0, false);
        assert_eq!(score, 40);
        assert_eq!(verdict, "FAILED — VRAM ERRORS");
    }

    #[test]
    fn test_health_assessment_perfect() {
        let (score, verdict, _) = health_assessment(0, false, false, 60.0, 70.0, false);
        assert_eq!(score, 100);
        assert_eq!(verdict, "CERTIFIED");
    }
}
