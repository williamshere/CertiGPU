<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:11594122c9d1c47ad162dca0e8c2ad981bf8a3db05d6f07b9e5887405037f8a2 -->

# CertiGPU

Free hardware testing and configuration tools built with React, Vite, Tauri 2, Rust and wgpu. All tests, reports, local QR codes, settings and script exports are available without payment, subscriptions, accounts or cloud services.

## Tools

- **GPU tests:** full compute and VRAM run, compute-only stress, or repeated VRAM integrity passes. Four address/XOR patterns are verified in a bounded 32 MiB window (128 MiB of transfers per pass, not a full-capacity VRAM test). <!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:ff7fbbfff82e4e03d527bc1348746dc3a3d5188dede4e2766a62cbc182ff51e1 -->

NVIDIA NVML supplies telemetry; wgpu must match the monitored GPU. Native testing currently requires one NVIDIA GPU; multiple NVIDIA devices and other vendors are unsupported.

<!-- /coderabbit-ai-generated:v1 --> Missing compute contexts or sensors produce errors rather than certification.
- **CPU tests:** mixed, integer hash, floating-point arithmetic and memory verification workloads. Choose 1–32 workers (bounded by native logical threads), 10–100% duty cycle and 1–60 minutes. Memory use is bounded to 1 MiB per worker. CPU temperature is unavailable: monitor cooling externally. CPU reports describe verified workloads, not thermal health certification.
- **Settings:** persistent duration, intensity, CPU workers, GPU temperature cutoff (60–92°C), telemetry interval, temperature units, appearance and local report saving. Defaults apply to new sessions.
- **Reports:** keep up to 50 reports locally, inspect results and export JSON and local QR payloads for free. QR codes contain an ID and verdict, not a digital signature or online verification link. Stopped, demo, failed and limited-scope runs are labeled explicitly.
- **Optimization:** customize and export Windows PowerShell power-plan scripts or Linux CPU governor scripts. Templates save previous state before writing and include restore commands. They never change voltage or clock offsets. Higher performance can increase heat and power use; gains depend on hardware and workloads. Linux requires cpufreq policy support and sudo; Windows power plans must exist on the target system.

The browser preview uses explicitly labeled sample devices and simulated sessions. It does not detect or stress local hardware. Use the desktop app for native tests. No results are uploaded.

## Development

Node 18+ and npm are required for the web interface:

```bash
npm ci
npm run dev -- --host 0.0.0.0
npm run build
npm test
```

Vite listens on port 1420. For the desktop app, install Rust and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). Windows requires C++ Build Tools and WebView2; Linux requires GTK3 and WebKitGTK 4.1 development packages.

```bash
python src-tauri/icons/generate_icons.py
npm run tauri dev
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

## Hardware behavior

Stress tests generate sustained load. Keep vents clear and monitor cooling. GPU workloads abort at the selected edge-temperature limit (never above 92°C); stop requests are checked between bounded GPU dispatches and VRAM readbacks. CPU cancellation is checked between verified batches. Long driver calls can delay cancellation. Hotspot and memory junction sensors are not separately measured.

This release expands the previous observation-only contract: users may now export scripts that change OS power policy. Scripts are editable and executed manually, outside the application. Review edits and keep saved state until rollback succeeds. Templates refuse to overwrite a previous rollback snapshot. CertiGPU does not execute arbitrary scripts or silently apply tuning.

Power-policy references: [Microsoft powercfg](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/powercfg-command-line-options), [Linux CPU frequency governors](https://docs.kernel.org/admin-guide/pm/cpufreq.html).

## Layout

- `src/App.jsx`, `src/styles.css`: dashboard, tests, settings, reports and script builder
- `src/hardware.js`: settings normalization, persistence and script templates
- `src-tauri/src/main.rs`: commands, shared session lock and result orchestration
- `src-tauri/src/cpu.rs`: cancellable CPU verification workloads
- `src-tauri/src/gpu.rs`: NVIDIA detection and telemetry
- `src-tauri/src/stress.rs`: GPU compute and VRAM readback


<!-- /coderabbit-ai-generated:v1 -->