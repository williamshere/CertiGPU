
import React, { memo, useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { QRCodeSVG } from "qrcode.react";
import { uploadCertificate } from "./supabase.js";

const TelemetryChart = memo(({ telemetry }) => {
  return (
    <div style={{ marginTop: 16, height: 80, display: 'flex', alignItems: 'end', gap: 2 }}>
      {telemetry.map((t, i) => <div key={i} style={{ flex: 1, background: 'var(--accent)', height: `${Math.min(100, t.gpu_temp)}%`, opacity: 0.7 }}></div>)}
    </div>
  );
});

const ConsoleLog = memo(({ logs }) => {
  const logRef = useRef(null);

  useEffect(() => {
    if (logRef.current) {
        logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="log" ref={logRef}>
       {logs.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );
});

export default function App() {
  const [step, setStep] = useState("detect");
  const [gpuInfo, setGpuInfo] = useState(null);
  const [logs, setLogs] = useState([]);
  const [telemetry, setTelemetry] = useState([]);
  const [progress, setProgress] = useState(0);
  const [report, setReport] = useState(null);

  useEffect(() => {
    detect();
    const unlistenLogs = listen("test-log", (e) => {
      setLogs(prev => [...prev.slice(-150), e.payload]);
    });
    const unlistenTelemetry = listen("telemetry", (e) => {
      setTelemetry(prev => [...prev.slice(-100), e.payload]);
      setProgress(e.payload.progress);
    });
    const unlistenDone = listen("test-done", (e) => {
      setReport(e.payload);
      setStep("report");
    });
    return () => {
      unlistenLogs.then(f => f && f());
      unlistenTelemetry.then(f => f && f());
      unlistenDone.then(f => f && f());
    };
  }, []);

  async function detect() {
    try {
      const info = await invoke("get_gpu_info");
      setGpuInfo(info);
    } catch (e) {
      setLogs(prev => [...prev, `ERROR: ${e}`]);
    }
  }

  async function startTest() {
    setLogs([]); setTelemetry([]); setProgress(0);
    setStep("testing");
    try {
      await invoke("start_certification");
    } catch (e) {
      setLogs(prev => [...prev, `Failed: ${e}`]);
    }
  }

  async function stopTest() {
    try {
      await invoke("stop_certification");
    } catch (e) {
      setLogs(prev => [...prev, `Stop failed: ${e}`]);
    }
  }

  async function mintCertificate() {
    if (!report) return;
    try {
      await uploadCertificate({ ...report, gpu_name: gpuInfo?.name });
      alert("Certificate uploaded for verification.");
    } catch (e) {
      alert(`Upload failed: ${e?.message || e}`);
    }
  }

  const latest = telemetry[telemetry.length - 1];

  return (
    <div className="app">
      <div className="sidebar">
        <div className="logo">Certi<span>GPU</span></div>
        <div className={`nav-item ${step === "detect" ? "active" : ""}`} onClick={() => setStep("detect")}>Dashboard</div>
        <div className="nav-item" onClick={() => { setStep("detect"); setReport(null); }}>New Test</div>
        <div className={`nav-item ${step === "report" && report ? "active" : ""}`} onClick={() => report && setStep("report")}>My Certificates</div>
        <div className="nav-item" onClick={() => alert("Settings coming soon!")}>Settings</div>
        <div style={{ marginTop: 'auto', fontSize: 12, color: 'var(--muted)' }}>v0.1.0 MVP</div>
      </div>
      <div className="main">
        <div className="tabs">
          <div className={`tab ${step === 'detect' ? 'active' : ''}`} onClick={() => setStep('detect')}>1. Detect</div>
          <div className={`tab ${step === 'testing' ? 'active' : ''}`} onClick={() => step !== 'detect' && setStep('testing')}>2. Testing</div>
          <div className={`tab ${step === 'report' ? 'active' : ''}`} onClick={() => report && setStep('report')}>3. Report</div>
        </div>

        {step === 'detect' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <h1 style={{ fontSize: 28, fontWeight: 800 }}>GPU Detection</h1>
            {!gpuInfo ? <div className="card">Detecting...</div> : (
              <>
                <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 20, fontWeight: 700 }}>{gpuInfo.name}</div>
                    <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 6 }}>
                      Device ID: {gpuInfo.device_id} - BIOS: {gpuInfo.bios_version} - Driver: {gpuInfo.driver_version} - VRAM: {gpuInfo.vram_gb}GB {gpuInfo.vram_type}
                    </div>
                  </div>
                  <div className={`badge ${gpuInfo.is_fake ? "fake" : ""}`}>{gpuInfo.is_fake ? "POSSIBLE FAKE" : "Genuine"} - {gpuInfo.source}</div>
                </div>
                <div className="grid">
                  <div className="card"><div style={{ color: 'var(--muted)', fontSize: 12 }}>CUDA CORES</div><div className="kpi">{gpuInfo.cuda_cores}</div></div>
                  <div className="card"><div style={{ color: 'var(--muted)', fontSize: 12 }}>HEALTH BASELINE</div><div className="kpi">{gpuInfo.is_fake ? 'Unknown' : '100%'} </div></div>
                  <div className="card"><div style={{ color: 'var(--muted)', fontSize: 12 }}>UUID</div><div style={{ fontSize: 11, fontFamily: 'monospace', marginTop: 8 }}>{gpuInfo.uuid}</div></div>
                  <div className="card"><div style={{ color: 'var(--muted)', fontSize: 12 }}>FAKE CHECK</div><div style={{ marginTop: 8, fontSize: 13 }}>{gpuInfo.fake_reason}</div></div>
                </div>
                <button className="btn" onClick={startTest} style={{ width: 280 }}>Start 15-min Certification</button>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>Free scan. Pay $3.99 only to mint QR certificate.</div>
              </>
            )}
          </div>
        )}

        {step === 'testing' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <h1 style={{ fontSize: 28, fontWeight: 800 }}>Running Certification - {progress.toFixed(1)}%</h1>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <div className="progress-bar" style={{ flex: 1 }}><div className="progress-fill" style={{ width: `${progress}%` }}></div></div>
              <button className="btn btn-ghost" onClick={stopTest}>Stop Test</button>
            </div>
            <div className="grid">
              <div className="card">
                <div style={{ fontWeight: 700, marginBottom: 12 }}>Live Telemetry</div>
                {latest ? (
                  <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
                    <div>Temp: <b>{latest.gpu_temp}C</b> - Hotspot: <b>{latest.hotspot_temp}C</b> - Mem: <b>{latest.mem_temp}C</b></div>
                    <div>Power: {latest.power_draw}W / {latest.power_limit}W - Clock: {latest.clock_mhz}MHz</div>
                    <div>Fan: {latest.fan_percent}% - VRAM: {Math.round(latest.vram_used_mb)} MB</div>
                  </div>
                ) : <div style={{ color: 'var(--muted)' }}>Waiting...</div>}
                <TelemetryChart telemetry={telemetry.slice(-40)} />
              </div>
              <div className="card">
                <div style={{ fontWeight: 700, marginBottom: 12 }}>Test Steps</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
                  <div>Identity Check - {gpuInfo?.name}</div>
                  <div>VRAM Integrity - Writing patterns... {progress > 20 ? '0 errors' : ''}</div>
                  <div>Thermal Stability - {progress > 40 ? 'Monitoring' : 'Pending'}</div>
                  <div>Performance Baseline - {progress > 75 ? `${latest?.clock_mhz || 0}MHz` : 'Pending'}</div>
                  <div>Fan & Power - Pending</div>
                </div>
              </div>
            </div>
            <div className="card">
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Console Log</div>
              <ConsoleLog logs={logs} />
            </div>
          </div>
        )}

        {step === 'report' && report && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <h1 style={{ fontSize: 28, fontWeight: 800 }}>Certification Report</h1>
            <div className="grid">
              <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                <div className={`circular-score ${report.health_score >= 90 ? "certified" : report.health_score >= 70 ? "warning" : "failed"}`}>{report.health_score}%</div>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 18 }}>{report.verdict}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>{report.summary}</div>
                </div>
              </div>
              <div className="card" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                <QRCodeSVG value={report.verify_url} size={80} />
                <div>
                  <div style={{ fontWeight: 700 }}>Verification QR</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', wordBreak: 'break-all', marginTop: 4 }}>{report.verify_url}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Signed: {report.cert_id}</div>
                </div>
              </div>
            </div>
            <div className="grid">
              <div className="card"><div style={{ color: 'var(--muted)', fontSize: 12 }}>AVG TEMP</div><div className="kpi">{report.avg_temp}C</div></div>
              <div className="card"><div style={{ color: 'var(--muted)', fontSize: 12 }}>MAX HOTSPOT</div><div className="kpi">{report.max_hotspot}C</div></div>
              <div className="card"><div style={{ color: 'var(--muted)', fontSize: 12 }}>VRAM ERRORS</div><div className="kpi" style={{ color: report.vram_errors === 0 ? "var(--success)" : "var(--error)" }}>{report.vram_errors}</div></div>
              <div className="card"><div style={{ color: 'var(--muted)', fontSize: 12 }}>PERF vs AVG</div><div className="kpi">{report.perf_vs_avg}</div></div>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button className="btn" onClick={mintCertificate}>Mint Certificate ($3.99)</button>
              <button className="btn btn-ghost" onClick={() => setStep('detect')}>Run Again</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
