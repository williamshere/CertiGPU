import React, { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { QRCodeSVG } from "qrcode.react";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  readSaved,
  download,
  optimizationScript,
  WORKLOADS,
} from "./hardware.js";

const native = isTauri();
const paths = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  chip: "M7 7h10v10H7z M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4 M10 10h4v4h-4z",
  gpu: "M3 5h18v13H3z M7 18v3m4-3v3m-8-9H1 M15 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M6 9h3m-3 4h3",
  bolt: "m13 2-9 12h7l-1 8 10-13h-8z",
  clock: "M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  settings:
    "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  check: "m5 12 4 4L19 6",
  shield: "m12 2 8 3v6c0 5-8 10-8 10S4 16 4 11V5z m-4 9 3 3 5-6",
  play: "m8 4 12 8-12 8z",
  down: "M12 3v12m-5-5 5 5 5-5 M4 16v5h16v-5",
  info: "M12 11v6m0-10v1 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  activity: "M2 12h5l3-8 4 16 3-8h5",
  terminal: "m4 6 6 6-6 6m9 0h7",
  chevron: "m9 5 7 7-7 7",
  refresh:
    "M20 7v5h-5 M4 17v-5h5 M5 8a8 8 0 0 1 13-3l2 3 M4 16l2 3a8 8 0 0 0 13-3",
  x: "m6 6 12 12M6 18 18 6",
  sun: "M12 2v2m0 16v2M2 12h2m16 0h2 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  heart: "M20 4c-3-3-7 0-8 2-1-2-5-5-8-2-5 5 8 16 8 16S25 9 20 4",
  memory: "M2 6h20v12H2z M6 9v5m4-5v5m4-5v5m4-5v5M5 18v3m5-3v3m5-3v3m5-3v3",
};
function Icon({ name, size = 19, ...props }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name] || paths.chip} />
    </svg>
  );
}
function Chart({ values, color = "#49d6b0", large = false }) {
  const data =
    values?.length > 1
      ? values
      : Array.from(
          { length: 48 },
          (_, i) => 30 + Math.sin(i * 0.65) * 5 + Math.cos(i * 1.7) * 3,
        );
  const points = data
    .map(
      (v, i) =>
        `${(i / (data.length - 1)) * 600},${120 - Math.max(0, Math.min(100, v))}`,
    )
    .join(" ");
  const id = React.useId().replace(/:/g, "");
  return (
    <svg
      className={large ? "chart large" : "chart"}
      viewBox="0 0 600 130"
      preserveAspectRatio="none"
      role="img"
      aria-label={
        values?.length > 1
          ? "Recorded telemetry trend"
          : "Sample telemetry trend"
      }
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".22" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[20, 60, 100].map((y) => (
        <line
          key={y}
          x1="0"
          y1={y}
          x2="600"
          y2={y}
          stroke="currentColor"
          strokeDasharray="3 5"
          opacity=".12"
        />
      ))}
      <polygon points={`0,130 ${points} 600,130`} fill={`url(#${id})`} />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={large ? "2" : "2.4"}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>
        {label}
        <small>{hint}</small>
      </span>
      {children}
    </label>
  );
}
function Switch({ value, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={value}
      className={`switch ${value ? "on" : ""}`}
      onClick={() => onChange(!value)}
    >
      <span />
    </button>
  );
}
function App() {
  const [page, setPage] = useState("dashboard");
  const [settings, setSettings] = useState(() =>
    normalizeSettings(readSaved("certigpu-settings", DEFAULT_SETTINGS)),
  );
  const [draft, setDraft] = useState(settings);
  const [gpu, setGpu] = useState(null);
  const [cpu, setCpu] = useState(null);
  const [target, setTarget] = useState("gpu");
  const [workload, setWorkload] = useState("full");
  const [duration, setDuration] = useState(settings.duration);
  const [intensity, setIntensity] = useState(settings.intensity);
  const [reports, setReports] = useState(() => {
    const saved = readSaved("certigpu-reports", []);
    return Array.isArray(saved)
      ? saved.filter((r) => r && typeof r.cert_id === "string").slice(0, 50)
      : [];
  });
  const [selectedReport, setSelectedReport] = useState(null);
  const [run, setRun] = useState(null);
  const [samples, setSamples] = useState([]);
  const [logs, setLogs] = useState([]);
  const [toast, setToast] = useState("");
  const [platform, setPlatform] = useState("windows");
  const [profile, setProfile] = useState("performance");
  const [script, setScript] = useState(() =>
    optimizationScript("windows", "performance"),
  );
  const runRef = useRef(null);
  const settingsRef = useRef(settings);
  const timer = useRef(null);
  const listenersReady = useRef(false);
  const [ready, setReady] = useState(!native);
  const notify = (text) => setToast(text);
  useEffect(() => {
    settingsRef.current = settings;
    document.documentElement.dataset.theme = settings.theme;
  }, [settings]);
  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(id);
    }
  }, [toast]);
  function finish(report) {
    const active = runRef.current;
    if (!active) return;
    clearInterval(timer.current);
    runRef.current = null;
    setRun(null);
    setDuration(settingsRef.current.duration);
    setIntensity(settingsRef.current.intensity);
    const result = {
      ...report,
      target: active.target,
      workload: active.workload,
      duration: active.duration,
      elapsed_secs: (Date.now() - active.started) / 1000,
      intensity: active.intensity,
      created_at: new Date().toISOString(),
      source: active.demo
        ? "Demo"
        : active.target === "cpu"
          ? "Native CPU"
          : gpu?.source || "Native GPU",
    };
    setSelectedReport(result);
    setReports((prev) => {
      const next = [result, ...prev].slice(0, 50);
      if (settingsRef.current.saveReports) {
        try {
          localStorage.setItem("certigpu-reports", JSON.stringify(next));
        } catch {
          notify(
            "Report ready. Local storage is full; export it to keep a copy.",
          );
        }
      }
      return next;
    });
    setPage("reports");
  }
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    const unlisteners = [];
    async function connect() {
      try {
        for (const [event, handler] of [
          [
            "test-log",
            (e) => setLogs((prev) => [...prev.slice(-199), e.payload]),
          ],
          [
            "telemetry",
            (e) => setSamples((prev) => [...prev.slice(-119), e.payload]),
          ],
          ["test-done", (e) => finish(e.payload)],
          [
            "test-error",
            (e) => {
              runRef.current = null;
              setRun(null);
              notify(`Test failed: ${e.payload}`);
            },
          ],
        ]) {
          const unlisten = await listen(event, handler);
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        }
        if (!disposed) {
          listenersReady.current = true;
          setReady(true);
        }
        const [gpuInfo, cpuInfo] = await Promise.all([
          invoke("get_gpu_info"),
          invoke("get_cpu_info"),
        ]);
        if (!disposed) {
          setGpu(gpuInfo);
          setCpu(cpuInfo);
        }
      } catch (e) {
        if (!disposed) notify(`Hardware connection failed: ${e}`);
      }
    }
    connect();
    return () => {
      disposed = true;
      listenersReady.current = false;
      unlisteners.forEach((fn) => fn());
    };
  }, []);
  useEffect(() => () => clearInterval(timer.current), []);
  const latest = samples.at(-1);
  const demo = !native || (target === "gpu" && gpu?.source !== "NVML");
  const temperature = (value) =>
    value == null
      ? "—"
      : `${Math.round(settings.units === "fahrenheit" ? (value * 9) / 5 + 32 : value)}°${settings.units === "fahrenheit" ? "F" : "C"}`;
  const navigate = (next) => {
    setPage(next);
    if (next === "settings") setDraft(settings);
  };
  const chooseTarget = (value) => {
    if (runRef.current) return;
    setTarget(value);
    setWorkload(value === "gpu" ? "full" : "mixed");
  };
  async function startTest() {
    if (runRef.current) {
      setPage("stress");
      return;
    }
    const active = {
      target,
      workload,
      duration,
      intensity,
      temperatureLimit: settings.temperatureLimit,
      threads: settings.threads,
      demo,
      started: Date.now(),
    };
    runRef.current = active;
    setRun(active);
    setSamples([]);
    setLogs([
      demo
        ? "Demo session started. Values are simulated; no hardware is being tested."
        : `Starting ${target.toUpperCase()} ${workload} workload…`,
    ]);
    setPage("stress");
    if (demo) {
      const complete = (stopped) =>
        finish({
          cert_id: `DEMO-${Date.now()}`,
          verdict: stopped ? "STOPPED · DEMO" : "COMPLETED · DEMO",
          summary:
            "Simulated session for exploring CertiGPU. This is not a hardware health certificate.",
          health_score: null,
          avg_temp: null,
          max_hotspot: null,
          vram_errors: null,
          perf_vs_avg: "Not measured",
          stopped,
        });
      active.complete = complete;
      timer.current = setInterval(() => {
        const elapsed = (Date.now() - active.started) / 1000;
        if (elapsed >= duration) {
          complete(false);
          return;
        }
        const t = 38 + Math.min(32, elapsed * 0.4) + Math.sin(elapsed) * 1.2;
        setSamples((prev) => [
          ...prev.slice(-119),
          {
            gpu_temp: t,
            progress: (elapsed / duration) * 100,
            power_draw: 45 + intensity * 1.6,
            clock_mhz: 2100 + Math.sin(elapsed) * 30,
            fan_percent: 35 + (elapsed % 20),
            cpu_ops: Math.round(elapsed * intensity * 320),
          },
        ]);
      }, settings.sampleMs);
    } else {
      try {
        if (!listenersReady.current)
          throw new Error("Event connection is not ready. Please retry.");
        await invoke(
          target === "gpu" ? "start_certification" : "start_cpu_test",
          {
            durationSecs: duration,
            workload,
            intensity,
            temperatureLimit: settings.temperatureLimit,
            threads: settings.threads,
            sampleMs: settings.sampleMs,
          },
        );
      } catch (e) {
        runRef.current = null;
        setRun(null);
        notify(`Could not start test: ${e}`);
      }
    }
  }
  async function stopTest() {
    if (runRef.current?.demo) {
      runRef.current.complete(true);
      return;
    }
    try {
      await invoke("stop_certification");
      setRun((prev) => (prev ? { ...prev, stopping: true } : null));
    } catch (e) {
      notify(`Could not stop test: ${e}`);
    }
  }
  function saveSettings() {
    const next = normalizeSettings(draft);
    try {
      localStorage.setItem("certigpu-settings", JSON.stringify(next));
      setSettings(next);
      if (!runRef.current) {
        setDuration(next.duration);
        setIntensity(next.intensity);
      }
      notify("Settings saved. Defaults apply to your next test.");
    } catch {
      notify("Could not save settings. Local storage is unavailable.");
    }
  }
  const recent = reports.slice(0, 3);
  const report = selectedReport;
  return (
    <div className="app">
      <aside className="sidebar">
        <a
          className="brand"
          aria-label="CertiGPU overview"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("dashboard");
          }}
        >
          <div className="brand-mark">
            <Icon name="chip" size={25} />
          </div>
          <span>
            Certi<span className="mint">GPU</span>
            <small>HARDWARE, VERIFIED.</small>
          </span>
        </a>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {[
            ["dashboard", "grid", "Overview"],
            ["stress", "activity", "Stress tests"],
            ["optimize", "bolt", "Optimization"],
            ["reports", "shield", "My reports"],
          ].map(([id, icon, label]) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "active" : ""}`}
              onClick={() => navigate(id)}
            >
              <Icon name={icon} />
              {label}
              {id === "stress" && run ? (
                <span className="live-dot" />
              ) : id === "reports" ? (
                <span className="count">{reports.length}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="nav-label second">PREFERENCES</div>
        <button
          aria-label="Settings"
          title="Settings"
          className={`nav-item ${page === "settings" ? "active" : ""}`}
          onClick={() => navigate("settings")}
        >
          <Icon name="settings" />
          Settings
        </button>
        <div className="sidebar-bottom">
          <div className="free-card">
            <div className="free-icon">
              <Icon name="heart" size={18} />
            </div>
            <strong>Powerful. Open. Free.</strong>
            <p>
              Every tool. Every test.
              <br />
              Always available to everyone.
            </p>
            <span>
              FREE FOREVER <Icon name="check" size={12} />
            </span>
          </div>
          <div className="version">
            <span className="live-dot" /> All systems ready <span>v0.2.0</span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            Workspace <Icon name="chevron" size={13} />{" "}
            <b>
              {
                {
                  dashboard: "Overview",
                  stress: "Stress tests",
                  optimize: "Optimization",
                  reports: "My reports",
                  settings: "Settings",
                }[page]
              }
            </b>
          </div>
          <div>
            <span className="free-pill">FREE EDITION</span>
            <span className="header-divider" />
            <span className="avatar" aria-label="Local workspace">
              <Icon name="chip" size={15} />
            </span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR HARDWARE. THE WHOLE PICTURE.</div>
              <h1>
                {
                  {
                    dashboard: "Hardware overview",
                    stress: "Push the limits. Find the baseline.",
                    optimize: "Make every cycle count.",
                    reports: "Your hardware, on record.",
                    settings: "Your workspace. Your rules.",
                  }[page]
                }
              </h1>
              <p>
                {
                  {
                    dashboard:
                      "Know your system. Test its limits. Unlock its potential.",
                    stress:
                      "Purpose-built workloads to put your hardware through its paces.",
                    optimize:
                      "Create, customize, and export configuration scripts for your system.",
                    reports:
                      "Review test results and export your reports. Completely free.",
                    settings:
                      "Customize your tests, monitoring, and app preferences.",
                  }[page]
                }
              </p>
            </div>
            {page === "dashboard" && (
              <button
                className="button primary"
                onClick={() => navigate("stress")}
              >
                <Icon name="play" size={15} /> New stress test
              </button>
            )}
          </div>
          {!native && (
            <div className="demo-notice">
              <span className="live-dot" />
              <b>Preview workspace</b>
              <span>
                You’re viewing sample hardware. Use the desktop app for real
                hardware testing.
              </span>
              <span className="demo-tag">DEMO MODE</span>
            </div>
          )}
          {page === "dashboard" && (
            <>
              <div className="section-heading">
                <h2>
                  System at a glance{" "}
                  <span className="label">
                    {native ? "LOCAL DEVICE" : "SAMPLE SYSTEM"}
                  </span>
                </h2>
                <span className="muted">
                  <span className="live-dot" />{" "}
                  {run ? "Test in progress" : "Ready to test"}
                </span>
              </div>
              <div className="hardware-grid">
                {[
                  [
                    "gpu",
                    "gpu",
                    "GRAPHICS PROCESSOR",
                    gpu?.name ||
                      (native ? "Detecting GPU…" : "NVIDIA GeForce RTX 4080"),
                    gpu
                      ? `${gpu.vram_gb} GB ${gpu.vram_type} · ${gpu.source}`
                      : "16 GB GDDR6X · Ada Lovelace",
                    "#49d6b0",
                  ],
                  [
                    "cpu",
                    "chip",
                    "CENTRAL PROCESSOR",
                    cpu?.name ||
                      (native ? "Detecting CPU…" : "AMD Ryzen 9 7950X"),
                    cpu
                      ? `${cpu.logical_threads} logical threads · ${cpu.arch}`
                      : "16 cores · 32 threads · Zen 4",
                    "#8fa5f5",
                  ],
                ].map(([id, icon, label, name, detail, color]) => (
                  <section className="hardware-card" key={id}>
                    <div className="hardware-top">
                      <div className={`device-icon ${id}`}>
                        <Icon name={icon} size={25} />
                      </div>
                      <span className="device-status">
                        {native
                          ? id === "gpu"
                            ? gpu?.source || "Connecting"
                            : "Native"
                          : "Sample device"}
                      </span>
                    </div>
                    <div className="eyebrow">{label}</div>
                    <h3>{name}</h3>
                    <p>{detail}</p>
                    <div className="device-stats">
                      <div>
                        <small>TEMPERATURE</small>
                        <strong>
                          {native
                            ? id === "gpu" && run?.target === "gpu"
                              ? temperature(latest?.gpu_temp)
                              : "—"
                            : id === "gpu"
                              ? temperature(42)
                              : temperature(38)}
                          <span className="sub-stat">
                            {!native ? "Sample" : "On test"}
                          </span>
                        </strong>
                      </div>
                      <div>
                        <small>
                          {id === "gpu" ? "POWER DRAW" : "LOGICAL THREADS"}
                        </small>
                        <strong>
                          {id === "gpu"
                            ? native
                              ? run?.target === "gpu" && latest
                                ? `${Math.round(latest.power_draw)} W`
                                : "—"
                              : "28 W"
                            : cpu?.logical_threads || (native ? "—" : "32")}
                          <span className="sub-stat">
                            {id === "gpu" ? "Idle" : "Available"}
                          </span>
                        </strong>
                      </div>
                    </div>
                    <Chart
                      color={color}
                      values={
                        run?.target === id
                          ? samples.map((s) => s.gpu_temp)
                          : null
                      }
                    />
                    <div className="hardware-footer">
                      <span>
                        <i style={{ background: color }} />{" "}
                        {run?.target === id
                          ? "Test running"
                          : "Ready for a workout"}
                      </span>
                      <button
                        onClick={() => {
                          chooseTarget(id);
                          navigate("stress");
                        }}
                      >
                        Test {id.toUpperCase()} <Icon name="arrow" size={15} />
                      </button>
                    </div>
                  </section>
                ))}
              </div>
              <div className="tools-grid">
                <section className="panel quick-tests">
                  <div className="panel-heading">
                    <h2>Put your hardware to the test</h2>
                    <span className="subtle-icon">
                      <Icon name="activity" />
                    </span>
                  </div>
                  <p>Find instability before it finds you.</p>
                  {[
                    [
                      "gpu",
                      "gpu",
                      "GPU stress test",
                      "Compute load, VRAM integrity & thermals",
                      "15 MIN",
                    ],
                    [
                      "cpu",
                      "chip",
                      "CPU stress test",
                      "Multi-thread compute & memory stability",
                      "15 MIN",
                    ],
                  ].map(([id, icon, title, subtitle, badge]) => (
                    <button
                      className="test-row"
                      key={id}
                      onClick={() => {
                        chooseTarget(id);
                        if (!runRef.current) setDuration(900);
                        navigate("stress");
                      }}
                    >
                      <span className={`row-icon ${id}`}>
                        <Icon name={icon} />
                      </span>
                      <span>
                        <strong>{title}</strong>
                        <small>{subtitle}</small>
                      </span>
                      <span className="duration-label">{badge}</span>
                      <Icon name="chevron" size={16} />
                    </button>
                  ))}
                  <div className="panel-note">
                    <Icon name="shield" size={14} /> Adjustable limits. Live
                    monitoring. Stop anytime.
                  </div>
                </section>
                <section className="panel optimize-card">
                  <div className="optimize-art">
                    <Icon name="bolt" size={32} />
                    <span className="orbit one" />
                    <span className="orbit two" />
                    <span className="art-dot" />
                  </div>
                  <span className="eyebrow mint">
                    LESS FRICTION. MORE PERFORMANCE.
                  </span>
                  <h2>
                    A little tuning.
                    <br />A lot more potential.
                  </h2>
                  <p>
                    Build custom configuration scripts
                    <br />
                    to get more from your hardware.
                  </p>
                  <button
                    className="button secondary"
                    onClick={() => navigate("optimize")}
                  >
                    Explore optimization <Icon name="arrow" size={16} />
                  </button>
                </section>
              </div>
              <section className="panel recent">
                <div className="panel-heading">
                  <h2>
                    Recent activity{" "}
                    <span className="label">{reports.length} REPORTS</span>
                  </h2>
                  <button
                    className="text-button"
                    onClick={() => navigate("reports")}
                  >
                    View all reports <Icon name="arrow" size={14} />
                  </button>
                </div>
                {recent.length ? (
                  recent.map((r) => (
                    <button
                      key={r.cert_id}
                      className="report-row"
                      onClick={() => {
                        setSelectedReport(r);
                        navigate("reports");
                      }}
                    >
                      <span className="row-icon">
                        <Icon name="shield" />
                      </span>
                      <span>
                        <strong>
                          {r.target?.toUpperCase()} · {r.workload}
                        </strong>
                        <small>{new Date(r.created_at).toLocaleString()}</small>
                      </span>
                      <span className="label">{r.verdict}</span>
                      <Icon name="chevron" size={16} />
                    </button>
                  ))
                ) : (
                  <div className="empty-inline">
                    <span className="empty-icon">
                      <Icon name="clock" size={22} />
                    </span>
                    <div>
                      <strong>A fresh start for your system.</strong>
                      <p>
                        Your completed tests and hardware reports will appear
                        here.
                      </p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => navigate("stress")}
                    >
                      Run your first test <Icon name="arrow" size={15} />
                    </button>
                  </div>
                )}
              </section>
              <div className="trust-strip">
                <span>
                  <Icon name="check" size={14} /> 100% free, no subscriptions
                </span>
                <span>
                  <Icon name="shield" size={14} /> Your hardware. Your data.
                </span>
                <span>
                  <Icon name="terminal" size={14} /> Built for enthusiasts
                </span>
              </div>
            </>
          )}
          {page === "stress" && (
            <div className="test-layout">
              <section className="panel test-config">
                <div className="panel-heading">
                  <h2>
                    {run ? "Session configuration" : "Configure a stress test"}
                  </h2>
                  <Icon name="settings" />
                </div>
                <div className="segmented">
                  {["gpu", "cpu"].map((t) => (
                    <button
                      key={t}
                      disabled={!!run}
                      className={target === t ? "selected" : ""}
                      onClick={() => chooseTarget(t)}
                    >
                      <Icon name={t === "gpu" ? "gpu" : "chip"} />{" "}
                      {t.toUpperCase()}
                    </button>
                  ))}
                </div>
                <label className="input-label">Workload</label>
                <div className="workloads">
                  {WORKLOADS[target].map((w) => (
                    <label
                      key={w.id}
                      className={`workload ${workload === w.id ? "chosen" : ""}`}
                    >
                      <input
                        type="radio"
                        name="workload"
                        value={w.id}
                        disabled={!!run}
                        checked={workload === w.id}
                        onChange={() => setWorkload(w.id)}
                      />
                      <span>
                        <strong>{w.name}</strong>
                        <small>{w.description}</small>
                      </span>
                    </label>
                  ))}
                </div>
                <Field label="Test duration">
                  <select
                    value={duration}
                    disabled={!!run}
                    onChange={(e) => setDuration(Number(e.target.value))}
                  >
                    {[60, 300, 900, 1800, 3600, duration]
                      .filter((v, i, a) => a.indexOf(v) === i)
                      .sort((a, b) => a - b)
                      .map((v) => (
                        <option key={v} value={v}>
                          {v / 60} minutes
                        </option>
                      ))}
                  </select>
                </Field>
                <Field
                  label={`Load intensity · ${intensity}%`}
                  hint="Controls the workload duty cycle"
                >
                  <input
                    aria-label="Load intensity"
                    type="range"
                    min="10"
                    max="100"
                    step="10"
                    value={intensity}
                    disabled={!!run}
                    onChange={(e) => setIntensity(Number(e.target.value))}
                  />
                </Field>
                <div className="config-note">
                  <Icon name="shield" size={18} />
                  <span>
                    {target === "gpu"
                      ? `GPU auto-stops at ${temperature(run?.temperatureLimit ?? settings.temperatureLimit)}. Keep vents clear.`
                      : `${run?.threads ?? settings.threads} worker threads. CPU temperature is unavailable; monitor it externally.`}{" "}
                    You can stop at any time.
                  </span>
                </div>
                {run ? (
                  <button
                    className="button danger full"
                    disabled={run.stopping}
                    onClick={stopTest}
                  >
                    <Icon name="x" size={16} />
                    {run.stopping ? "Stopping…" : "Stop test"}
                  </button>
                ) : (
                  <button
                    className="button primary full"
                    disabled={!ready || (native && (!gpu || !cpu))}
                    onClick={startTest}
                  >
                    <Icon name="play" size={16} />
                    {demo ? "Start demo test" : "Start stress test"}
                  </button>
                )}
              </section>
              <div className="test-monitor">
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Live monitoring</h2>
                    <span className="label">
                      {run ? (run.demo ? "SIMULATED" : "RUNNING") : "STANDBY"}
                    </span>
                  </div>
                  <div className="monitor-stats">
                    <div>
                      <small>
                        {target === "gpu"
                          ? "GPU TEMPERATURE"
                          : "CPU TEMPERATURE"}
                      </small>
                      <strong>
                        {target === "cpu" && !run?.demo
                          ? "Unavailable"
                          : temperature(latest?.gpu_temp)}
                      </strong>
                    </div>
                    <div>
                      <small>
                        {target === "gpu" ? "POWER DRAW" : "VERIFIED BATCHES"}
                      </small>
                      <strong>
                        {target === "gpu"
                          ? latest
                            ? `${Math.round(latest.power_draw)} W`
                            : "—"
                          : latest?.cpu_ops?.toLocaleString() || "—"}
                      </strong>
                    </div>
                    <div>
                      <small>PROGRESS</small>
                      <strong>
                        {(latest?.progress || 0).toFixed(1)}
                        <em>%</em>
                      </strong>
                    </div>
                  </div>
                  <Chart
                    large
                    values={samples.map((s) =>
                      target === "gpu" || run?.demo ? s.gpu_temp : s.progress,
                    )}
                  />
                  <div className="chart-caption">
                    <span>
                      {run
                        ? "Session timeline"
                        : "Sample trend · awaiting test"}
                    </span>
                    <span>
                      {run
                        ? `${Math.floor((Date.now() - run.started) / 1000)}s elapsed`
                        : "No active session"}
                    </span>
                  </div>
                  <div className="progress-track">
                    <div style={{ width: `${latest?.progress || 0}%` }} />
                  </div>
                </section>
                <section className="panel console">
                  <div className="panel-heading">
                    <h2>
                      <Icon name="terminal" size={16} /> Session log
                    </h2>
                    <span className="muted">LOCAL SESSION</span>
                  </div>
                  <div className="console-lines" role="log" aria-live="polite">
                    {logs.length ? (
                      logs.map((l, i) => (
                        <div key={i}>
                          <span>{String(i + 1).padStart(2, "0")}</span>
                          {l}
                        </div>
                      ))
                    ) : (
                      <div>
                        <span>01</span>Ready when you are. Configure your test
                        to begin.
                      </div>
                    )}
                  </div>
                </section>
              </div>
            </div>
          )}
          {page === "optimize" && (
            <div className="optimization-layout">
              <section className="panel">
                <h2>Configuration builder</h2>
                <p className="panel-description">
                  Choose a power profile, then review your script before
                  exporting.
                </p>
                <Field label="Operating system">
                  <select
                    value={platform}
                    onChange={(e) => {
                      setPlatform(e.target.value);
                      setScript(optimizationScript(e.target.value, profile));
                    }}
                  >
                    <option value="windows">Windows · PowerShell</option>
                    <option value="linux">Linux · Bash</option>
                  </select>
                </Field>
                <label className="input-label">Power profile</label>
                {[
                  [
                    "performance",
                    "bolt",
                    "Performance",
                    "Prioritize performance. Uses more power and may increase heat.",
                  ],
                  [
                    "balanced",
                    "sun",
                    "Power saving / balanced",
                    "Windows Balanced plan or Linux powersave governor.",
                  ],
                ].map(([id, icon, title, description]) => (
                  <button
                    key={id}
                    className={`profile-option ${profile === id ? "chosen" : ""}`}
                    onClick={() => {
                      setProfile(id);
                      setScript(optimizationScript(platform, id));
                    }}
                  >
                    <Icon name={icon} />
                    <span>
                      <strong>{title}</strong>
                      <small>{description}</small>
                    </span>
                    {profile === id && <Icon name="check" size={16} />}
                  </button>
                ))}
                <div className="config-note">
                  <Icon name="info" />
                  <span>
                    Scripts change OS power policy. No voltage or clock offsets.
                    Rollback commands are included. Custom edits are your
                    responsibility.
                  </span>
                </div>
                <button
                  className="button primary full"
                  onClick={() => {
                    download(
                      `certigpu-${profile}.${platform === "windows" ? "ps1" : "sh"}`,
                      script,
                      "text/plain",
                    );
                    notify(
                      "Script exported. Review it and run it locally when ready.",
                    );
                  }}
                >
                  <Icon name="down" size={16} /> Export script
                </button>
              </section>
              <section className="panel script-panel">
                <div className="panel-heading">
                  <h2>
                    <Icon name="terminal" size={17} /> Custom configuration
                    script
                  </h2>
                  <button
                    className="text-button"
                    onClick={() => {
                      setScript(optimizationScript(platform, profile));
                      notify("Script reset to the selected template.");
                    }}
                  >
                    <Icon name="refresh" size={14} /> Reset
                  </button>
                </div>
                <textarea
                  aria-label="Custom configuration script"
                  spellCheck="false"
                  value={script}
                  onChange={(e) => setScript(e.target.value)}
                />
                <div className="panel-note">
                  Editable script · Export and run locally · Includes restore
                  instructions
                </div>
              </section>
            </div>
          )}
          {page === "settings" && (
            <div className="settings-layout">
              <section className="panel">
                <div className="panel-heading">
                  <h2>
                    <Icon name="activity" /> Test defaults
                  </h2>
                </div>
                <Field
                  label="Default duration"
                  hint="Length of a new stress test"
                >
                  <select
                    value={draft.duration}
                    onChange={(e) =>
                      setDraft({ ...draft, duration: +e.target.value })
                    }
                  >
                    {[60, 300, 900, 1800, 3600, draft.duration]
                      .filter((v, i, a) => a.indexOf(v) === i)
                      .map((v) => (
                        <option key={v} value={v}>
                          {v / 60} minutes
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label={`Default intensity · ${draft.intensity}%`}>
                  <input
                    type="range"
                    min="10"
                    max="100"
                    step="10"
                    value={draft.intensity}
                    onChange={(e) =>
                      setDraft({ ...draft, intensity: +e.target.value })
                    }
                  />
                </Field>
                <Field
                  label="GPU temperature limit"
                  hint="Automatically stop GPU workloads (60–92°C)"
                >
                  <input
                    aria-label="GPU temperature limit"
                    type="number"
                    min="60"
                    max="92"
                    value={draft.temperatureLimit}
                    onChange={(e) =>
                      setDraft({ ...draft, temperatureLimit: e.target.value })
                    }
                  />
                </Field>
                <Field
                  label="CPU worker threads"
                  hint="Clamped to available native threads"
                >
                  <input
                    aria-label="CPU worker threads"
                    type="number"
                    min="1"
                    max="32"
                    value={draft.threads}
                    onChange={(e) =>
                      setDraft({ ...draft, threads: e.target.value })
                    }
                  />
                </Field>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <h2>
                    <Icon name="settings" /> App preferences
                  </h2>
                </div>
                <Field label="Telemetry refresh">
                  <select
                    value={draft.sampleMs}
                    onChange={(e) =>
                      setDraft({ ...draft, sampleMs: +e.target.value })
                    }
                  >
                    <option value="500">0.5 seconds</option>
                    <option value="1000">1 second</option>
                    <option value="2000">2 seconds</option>
                  </select>
                </Field>
                <Field label="Temperature units">
                  <select
                    value={draft.units}
                    onChange={(e) =>
                      setDraft({ ...draft, units: e.target.value })
                    }
                  >
                    <option value="celsius">Celsius (°C)</option>
                    <option value="fahrenheit">Fahrenheit (°F)</option>
                  </select>
                </Field>
                <Field label="Appearance">
                  <select
                    value={draft.theme}
                    onChange={(e) =>
                      setDraft({ ...draft, theme: e.target.value })
                    }
                  >
                    <option value="dark">Midnight</option>
                    <option value="light">Daylight</option>
                  </select>
                </Field>
                <Field
                  label="Save reports locally"
                  hint="Keep up to 50 reports on this device"
                >
                  <Switch
                    label="Save reports locally"
                    value={draft.saveReports}
                    onChange={(value) =>
                      setDraft({ ...draft, saveReports: value })
                    }
                  />
                </Field>
                <p className="panel-description">
                  Turning saving off keeps existing reports. Export a report to
                  save a separate copy.
                </p>
              </section>
              <div className="settings-actions">
                <button
                  className="button secondary"
                  onClick={() => {
                    setDraft(DEFAULT_SETTINGS);
                    notify("Defaults loaded. Save to apply.");
                  }}
                >
                  Restore defaults
                </button>
                <button className="button primary" onClick={saveSettings}>
                  <Icon name="check" size={16} /> Save changes
                </button>
              </div>
            </div>
          )}
          {page === "reports" && (
            <>
              {report ? (
                <section className="panel report-detail">
                  <div className="panel-heading">
                    <h2>{report.target?.toUpperCase()} test report</h2>
                    <button
                      className="text-button"
                      onClick={() => setSelectedReport(null)}
                    >
                      All reports <Icon name="arrow" size={15} />
                    </button>
                  </div>
                  <div className="report-summary">
                    <div className="report-seal">
                      <Icon name="shield" size={40} />
                    </div>
                    <div>
                      <span className="eyebrow">
                        {report.source} ·{" "}
                        {new Date(report.created_at).toLocaleString()}
                      </span>
                      <h2>{report.verdict}</h2>
                      <p>{report.summary}</p>
                    </div>
                  </div>
                  <div className="report-metrics">
                    {[
                      ["WORKLOAD", report.workload],
                      [
                        "DURATION",
                        `${Math.round(report.elapsed_secs ?? report.duration)}s elapsed`,
                      ],
                      ["AVG TEMPERATURE", temperature(report.avg_temp)],
                      [
                        "INTEGRITY ERRORS",
                        report.cpu_errors ??
                          report.vram_errors ??
                          "Not measured",
                      ],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <small>{k}</small>
                        <strong>{v}</strong>
                      </div>
                    ))}
                  </div>
                  {report.cert_id && (
                    <div className="qr-block">
                      <QRCodeSVG
                        value={JSON.stringify({
                          id: report.cert_id,
                          verdict: report.verdict,
                        })}
                        size={76}
                      />
                      <span>
                        Local report QR · {report.cert_id}
                        <small>
                          Contains report ID and verdict. No online verification
                          service is configured.
                        </small>
                      </span>
                    </div>
                  )}
                  <button
                    className="button primary"
                    onClick={() =>
                      download(
                        `${report.cert_id}.json`,
                        JSON.stringify(report, null, 2),
                      )
                    }
                  >
                    <Icon name="down" size={16} /> Export free report
                  </button>
                </section>
              ) : (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Test history</h2>
                    <span className="label">{reports.length} REPORTS</span>
                  </div>
                  {reports.length ? (
                    reports.map((r) => (
                      <button
                        key={r.cert_id}
                        className="report-row"
                        onClick={() => setSelectedReport(r)}
                      >
                        <span className="row-icon">
                          <Icon name="shield" />
                        </span>
                        <span>
                          <strong>
                            {r.target?.toUpperCase()} · {r.workload}
                          </strong>
                          <small>
                            {new Date(r.created_at).toLocaleString()}
                          </small>
                        </span>
                        <span className="label">{r.verdict}</span>
                        <Icon name="chevron" size={16} />
                      </button>
                    ))
                  ) : (
                    <div className="empty-state">
                      <Icon name="shield" size={42} />
                      <h2>Your first report starts with a test.</h2>
                      <p>
                        Run a GPU or CPU stress test to build your hardware
                        history.
                      </p>
                      <button
                        className="button primary"
                        onClick={() => navigate("stress")}
                      >
                        Create a stress test <Icon name="arrow" size={16} />
                      </button>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
          <footer>
            <span>
              CertiGPU <span className="footer-dot">/</span> Built to know your
              hardware better.
            </span>
            <span>
              All tools included. Zero paywalls. <Icon name="check" size={10} />
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Icon name="info" size={18} />
          {toast}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <Icon name="x" size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
export default App;
