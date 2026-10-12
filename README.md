# CertiGPU — "The Carfax for GPUs"

Desktop app (Tauri v2 + React) that detects your NVIDIA GPU, runs a
**15-minute certification** (VRAM integrity test, thermal stability under
real compute load, performance baseline, fan & power), and produces a
health-score report with a verification QR code.

## What was fixed (Oct 2026 revival)

The project was a complete frontend with **no backend at all** — the Rust
code (`src-tauri/src/`) was missing, so nothing could ever run. Fixed:

- Wrote the full Tauri backend: `get_gpu_info` / `start_certification` /
  `stop_certification` commands plus `test-log`, `telemetry`, `test-done`
  events the UI already expected.
- Real GPU telemetry via NVML (`nvml-wrapper`), with a simulated fallback
  when no NVIDIA driver is present (UI badge shows the source).
- Real load generation: a WGSL compute shader (via `wgpu`, no CUDA toolkit
  needed) for the thermal soak, plus a 512MB VRAM pattern read-back test.
- Fake-card check: reported VRAM vs. the expected profile for known models.
- Added the missing Tauri v2 `capabilities/default.json` — without it the
  frontend's `invoke()` calls are silently denied.
- Removed the phantom `bin/cuda-memtest` sidecar from `tauri.conf.json`
  (the binary never existed; referencing it breaks the build).
- Wired the "Mint Certificate" button to the existing Supabase uploader
  (was a `TODO` alert) and added a **Stop Test** button.
- Auto-abort at 92°C to protect hardware.

## Stack

- Frontend: React 18 + Vite 6
- Backend: Tauri 2 + Rust (tokio, serde, `nvml-wrapper`, `wgpu`)
- Cert upload: Supabase (mock mode unless `VITE_SUPABASE_URL` is set)

## Run it (Windows)

1. Install Rust: https://rustup.rs (or `rustup-init.exe` if you still have it)
2. Install Node 18+
3. Install VS Build Tools (C++ workload) — WebView2 is already on Win11

```bash
npm install
python src-tauri/icons/generate_icons.py   # one-time: generate app icons
npm run tauri dev
```

Release build:

```bash
npm run tauri build
```

## Safety — read this before the 15-minute test

- The certification pins your GPU at ~100% compute load for 15 minutes.
  That is the point, but respect it: **do not run it with blocked vents**,
  and keep an eye on the live temperature chart.
- The app **auto-aborts at 92°C** and you can hit **Stop Test** anytime.
- On laptops or small-form-factor PCs, consider a shorter run — the
  duration is a parameter (`start_certification` accepts seconds; the UI
  uses the 900s default).
- No overclocking or voltage changes are made. Ever. This app only
  observes and loads; it never writes GPU settings.

## Still TODO (from the original plan)

- [ ] Stripe integration for the $3.99 certificate unlock
- [ ] AMD support (ADL / ROCm SMI)
- [ ] Point `verify_url` at a real verification backend (currently
      `https://certigpu.app/verify/<id>`, a placeholder)

## Project layout

- `src/App.jsx` — full UI (Detect → Testing → Report)
- `src/supabase.js` — certificate upload (mock unless configured)
- `src-tauri/src/main.rs` — Tauri commands + certification orchestrator
- `src-tauri/src/gpu.rs` — NVML detection/telemetry + simulated fallback
- `src-tauri/src/stress.rs` — wgpu compute load + VRAM pattern test
- `src-tauri/capabilities/default.json` — Tauri v2 permission grant
