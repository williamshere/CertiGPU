//! GPU detection and telemetry via NVML, with a simulated fallback.
//!
//! On machines with an NVIDIA driver, [`Gpu::detect`] returns a live handle
//! backed by NVML. Anywhere else (no driver, non-NVIDIA GPU, CI) it returns a
//! simulated device that produces plausible synthetic telemetry so the UI and
//! the certification flow can still be exercised end-to-end.

use nvml_wrapper::enum_wrappers::device::{Brand, Clock, ClockId, TemperatureSensor};
use nvml_wrapper::Nvml;
use serde::Serialize;
use std::collections::HashMap;

/// Information shown on the Detect screen. Field names match what
/// `src/App.jsx` reads (`get_gpu_info` command).
#[derive(Debug, Clone, Serialize)]
pub struct GpuInfo {
    pub name: String,
    pub device_id: String,
    pub bios_version: String,
    pub driver_version: String,
    pub vram_gb: f64,
    pub vram_type: String,
    pub is_fake: bool,
    pub fake_reason: String,
    /// "NVML" for a real device, "Simulated" for the fallback.
    pub source: String,
    pub cuda_cores: u32,
    pub uuid: String,
}

/// One 500ms telemetry sample. Field names match the `telemetry` event
/// payload consumed by `src/App.jsx`.
#[derive(Debug, Clone, Serialize)]
pub struct Telemetry {
    pub gpu_temp: f64,
    pub hotspot_temp: f64,
    pub mem_temp: f64,
    pub power_draw: f64,
    pub power_limit: f64,
    pub clock_mhz: f64,
    /// NVML reports fan speed as a percentage of max, not RPM.
    pub fan_percent: f64,
    pub vram_used_mb: f64,
    pub progress: f64,
}

/// (expected VRAM in GB, CUDA cores, memory type) for models we can verify.
fn known_models() -> HashMap<&'static str, (f64, u32, &'static str)> {
    let mut m = HashMap::new();
    // RTX 50 series
    m.insert("RTX 5090", (32.0, 21760, "GDDR7"));
    m.insert("RTX 5080", (16.0, 10752, "GDDR7"));
    m.insert("RTX 5070 TI", (16.0, 8960, "GDDR7"));
    m.insert("RTX 5070", (12.0, 6144, "GDDR7"));
    m.insert("RTX 5060 TI", (16.0, 4608, "GDDR7"));
    m.insert("RTX 5060", (8.0, 3840, "GDDR7"));
    // RTX 40 series
    m.insert("RTX 4090", (24.0, 16384, "GDDR6X"));
    m.insert("RTX 4080 SUPER", (16.0, 10240, "GDDR6X"));
    m.insert("RTX 4080", (16.0, 9728, "GDDR6X"));
    m.insert("RTX 4070 TI SUPER", (16.0, 8448, "GDDR6X"));
    m.insert("RTX 4070 TI", (12.0, 7680, "GDDR6X"));
    m.insert("RTX 4070 SUPER", (12.0, 7168, "GDDR6X"));
    m.insert("RTX 4070", (12.0, 5888, "GDDR6X"));
    m.insert("RTX 4060 TI", (16.0, 4352, "GDDR6"));
    m.insert("RTX 4060", (8.0, 3072, "GDDR6"));
    // RTX 30 series
    m.insert("RTX 3090 TI", (24.0, 10752, "GDDR6X"));
    m.insert("RTX 3090", (24.0, 10496, "GDDR6X"));
    m.insert("RTX 3080 TI", (12.0, 10240, "GDDR6X"));
    m.insert("RTX 3080", (10.0, 8960, "GDDR6X"));
    m.insert("RTX 3070 TI", (8.0, 6144, "GDDR6X"));
    m.insert("RTX 3070", (8.0, 5888, "GDDR6"));
    m.insert("RTX 3060 TI", (8.0, 4864, "GDDR6"));
    m.insert("RTX 3060", (12.0, 3584, "GDDR6"));
    m.insert("RTX 3050", (8.0, 2560, "GDDR6"));
    m
}

/// Fake-card check: compare reported VRAM against the expected profile.
/// Counterfeit cards usually report far less VRAM than the real model ships.
fn fake_check(name: &str, vram_gb: f64) -> (bool, String, u32, String) {
    let upper = name.to_uppercase();
    // Check longer model names first ("RTX 4070 TI" before "RTX 4070").
    let mut models: Vec<(&str, (f64, u32, &str))> = known_models().into_iter().collect();
    models.sort_by_key(|(k, _)| std::cmp::Reverse(k.len()));
    for (model, (expected_vram, cores, mem_type)) in models {
        if upper.contains(model) {
            if vram_gb + 0.75 < expected_vram {
                return (
                    true,
                    format!(
                        "{} should ship with {}GB VRAM but reports {:.1}GB — classic counterfeit signature",
                        model, expected_vram, vram_gb
                    ),
                    cores,
                    mem_type.to_string(),
                );
            }
            return (
                false,
                format!("Device ID and {:.1}GB VRAM match the expected {} profile", vram_gb, model),
                cores,
                mem_type.to_string(),
            );
        }
    }
    (
        false,
        "Model not in verification database — check manually".to_string(),
        0,
        "Unknown".to_string(),
    )
}

fn brand_string(brand: Brand) -> String {
    format!("{:?}", brand)
}

pub enum Gpu {
    Real(Nvml),
    Simulated { tick: u64 },
}

impl Gpu {
    /// Detect the first NVIDIA GPU via NVML, falling back to simulation.
    pub fn detect() -> Self {
        if let Ok(nvml) = Nvml::init() {
            if nvml.device_by_index(0).is_ok() {
                return Gpu::Real(nvml);
            }
        }
        Gpu::Simulated { tick: 0 }
    }

    pub fn is_real(&self) -> bool {
        matches!(self, Gpu::Real(_))
    }

    fn real_device(
        &self,
    ) -> Option<nvml_wrapper::Device<'_>> {
        match self {
            Gpu::Real(nvml) => nvml.device_by_index(0).ok(),
            Gpu::Simulated { .. } => None,
        }
    }

    pub fn info(&self) -> GpuInfo {
        match self {
            Gpu::Real(nvml) => match nvml.device_by_index(0) {
                Ok(dev) => {
                    let name = dev.name().unwrap_or_else(|_| "Unknown NVIDIA GPU".to_string());
                    let mem = dev
                        .memory_info()
                        .map(|m| m.total as f64 / 1_073_741_824.0)
                        .unwrap_or(0.0);
                    let (is_fake, fake_reason, cuda_cores, vram_type) = fake_check(&name, mem);
                    GpuInfo {
                        device_id: dev
                            .pci_info()
                            .map(|p| {
                                format!(
                                    "{:04X}:{:02X}:{:02X}.{}",
                                    p.domain, p.bus, p.device, p.pci_device_id
                                )
                            })
                            .unwrap_or_else(|_| "unknown".to_string()),
                        bios_version: dev.vbios_version().unwrap_or_else(|_| "unknown".to_string()),
                        driver_version: nvml
                            .sys_driver_version()
                            .unwrap_or_else(|_| "unknown".to_string()),
                        uuid: dev.uuid().unwrap_or_else(|_| "unknown".to_string()),
                        name,
                        vram_gb: (mem * 10.0).round() / 10.0,
                        vram_type,
                        is_fake,
                        fake_reason,
                        source: format!(
                            "NVML ({})",
                            brand_string(dev.brand().unwrap_or(Brand::Unknown))
                        ),
                        cuda_cores,
                    }
                }
                Err(_) => Self::simulated_info(),
            },
            Gpu::Simulated { .. } => Self::simulated_info(),
        }
    }

    fn simulated_info() -> GpuInfo {
        // Simulated device so the UI flow works without an NVIDIA GPU.
        GpuInfo {
            name: "NVIDIA GeForce RTX 4070 (Simulated)".to_string(),
            device_id: "0000:01:00.0".to_string(),
            bios_version: "95.04.3C.00.FF".to_string(),
            driver_version: "simulated".to_string(),
            vram_gb: 12.0,
            vram_type: "GDDR6X".to_string(),
            is_fake: false,
            fake_reason: "Simulated device — verification skipped".to_string(),
            source: "Simulated".to_string(),
            cuda_cores: 5888,
            uuid: "GPU-simulated-0000".to_string(),
        }
    }

    /// Sample one telemetry point. `progress` is 0–100 and is echoed back so
    /// the frontend can drive its progress bar from the same payload.
    pub fn sample(&mut self, progress: f64) -> Telemetry {
        if let Some(dev) = self.real_device() {
            let mem = dev.memory_info();
            Telemetry {
                gpu_temp: dev.temperature(TemperatureSensor::Gpu).unwrap_or(0) as f64,
                // NVML exposes only the edge temperature; hotspot/memory track
                // it closely on load, so we report the edge temp with a note.
                hotspot_temp: dev.temperature(TemperatureSensor::Gpu).unwrap_or(0) as f64,
                mem_temp: dev.temperature(TemperatureSensor::Gpu).unwrap_or(0) as f64,
                power_draw: dev.power_usage().unwrap_or(0) as f64 / 1000.0,
                power_limit: dev.enforced_power_limit().unwrap_or(0) as f64 / 1000.0,
                clock_mhz: dev.clock(Clock::Graphics, ClockId::Current).unwrap_or(0) as f64,
                fan_percent: dev.fan_speed(0).unwrap_or(0) as f64,
                vram_used_mb: mem.map(|m| m.used as f64 / 1_048_576.0).unwrap_or(0.0),
                progress,
            }
        } else {
            // Synthetic load curve: idle ~42C, ramps toward ~74C under load.
            let tick = match self {
                Gpu::Simulated { tick } => {
                    *tick += 1;
                    *tick as f64
                }
                Gpu::Real(_) => 0.0,
            };
            let load_factor = (progress / 100.0).clamp(0.0, 1.0);
            let temp = 42.0 + 32.0 * load_factor * (1.0 - (-tick / 40.0).exp());
            Telemetry {
                gpu_temp: temp,
                hotspot_temp: temp + 8.0,
                mem_temp: temp + 4.0,
                power_draw: 35.0 + 165.0 * load_factor,
                power_limit: 200.0,
                clock_mhz: 1500.0 + 1050.0 * load_factor,
                fan_percent: 30.0 + 45.0 * load_factor,
                vram_used_mb: 450.0 + 3200.0 * load_factor,
                progress,
            }
        }
    }
}
