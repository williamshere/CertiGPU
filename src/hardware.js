export const DEFAULT_SETTINGS = {
  duration: 900,
  temperatureLimit: 85,
  intensity: 80,
  threads: 4,
  sampleMs: 1000,
  saveReports: true,
  units: "celsius",
  theme: "dark",
};
export function normalizeSettings(input = {}) {
  const bounded = (key, min, max) => {
    const parsed = Number(input[key]);
    const value =
      input[key] == null || !Number.isFinite(parsed)
        ? DEFAULT_SETTINGS[key]
        : parsed;
    return Math.round(Math.min(max, Math.max(min, value)));
  };
  return {
    duration: bounded("duration", 60, 3600),
    temperatureLimit: bounded("temperatureLimit", 60, 92),
    intensity: bounded("intensity", 10, 100),
    threads: bounded("threads", 1, 32),
    sampleMs: [500, 1000, 2000].includes(Number(input.sampleMs))
      ? Number(input.sampleMs)
      : 1000,
    saveReports: input.saveReports !== false,
    units: input.units === "fahrenheit" ? "fahrenheit" : "celsius",
    theme: input.theme === "light" ? "light" : "dark",
  };
}
export function readSaved(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
export function download(name, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function optimizationScript(platform, profile) {
  if (platform === "windows")
    return `# CertiGPU · ${profile === "performance" ? "Performance" : "Balanced"} power profile\r\n# Run in PowerShell. No voltage or clock changes.\r\n# Save the previous plan for rollback before changing anything.\r\n$ErrorActionPreference = 'Stop'\r\n$state = Join-Path $env:LOCALAPPDATA 'CertiGPU-power-plan.txt'\r\nif (Test-Path $state) { throw 'A saved plan already exists. Restore it before applying again.' }\r\n$current = powercfg /getactivescheme\r\nif ($LASTEXITCODE -ne 0) { throw 'Cannot read active power plan' }\r\n$plan = [regex]::Match(($current -join ' '), '[a-fA-F0-9]{8}-([a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}').Value\r\nif (-not $plan) { throw 'Cannot parse active power plan' }\r\nSet-Content -Path $state -Value $plan\r\npowercfg /setactive ${profile === "performance" ? "SCHEME_MIN" : "SCHEME_BALANCED"}\r\nif ($LASTEXITCODE -ne 0) { throw 'Power plan unavailable; previous plan is saved for recovery' }\r\nWrite-Host 'Profile applied. Higher performance may increase power use and heat.'\r\n# Restore with:\r\n# powercfg /setactive (Get-Content $state)\r\n# if ($LASTEXITCODE -eq 0) { Remove-Item $state }\r\n`;
  return `#!/usr/bin/env bash\n# CertiGPU · ${profile === "performance" ? "Performance" : "Balanced"} CPU governor\n# Run with sudo. No voltage or clock changes.\nset -euo pipefail\nstate=/var/lib/certigpu-governors\nif (( EUID != 0 )); then echo 'Run this script with sudo.' >&2; exit 1; fi\nif [[ -e "$state" ]]; then echo 'Restore the saved governors before applying again.' >&2; exit 1; fi\nshopt -s nullglob\npolicies=(/sys/devices/system/cpu/cpufreq/policy*)\n(( \${#policies[@]} )) || { echo 'CPU frequency control is unavailable.' >&2; exit 1; }\ngovernor=${profile === "performance" ? "performance" : "powersave"}\nfor policy in "\${policies[@]}"; do\n  available=$(cat "$policy/scaling_available_governors")\n  [[ " $available " == *" $governor "* ]] || { echo "Unsupported governor: $policy" >&2; exit 1; }\ndone\n(umask 077; mkdir "$state")\nfor policy in "\${policies[@]}"; do\n  cat "$policy/scaling_governor" > "$state/\${policy##*/}"\ndone\nfor policy in "\${policies[@]}"; do\n  printf '%s' "$governor" > "$policy/scaling_governor"\ndone\necho 'Profile applied. Settings may reset after reboot.'\n# Restore with sudo bash:\n# for saved in /var/lib/certigpu-governors/policy*; do\n#   cat "$saved" > "/sys/devices/system/cpu/cpufreq/\${saved##*/}/scaling_governor" || exit 1\n# done\n# rm -r /var/lib/certigpu-governors\n`;
}
export const WORKLOADS = {
  gpu: [
    {
      id: "full",
      name: "Full GPU test",
      description: "Compute, VRAM integrity & thermal stability",
    },
    {
      id: "compute",
      name: "Compute stress",
      description: "Sustained shader workload & clock stability",
    },
    {
      id: "vram",
      name: "VRAM integrity",
      description: "Multiple write, read & verification patterns",
    },
  ],
  cpu: [
    {
      id: "mixed",
      name: "Full CPU test",
      description: "Integer, floating point & memory workloads",
    },
    {
      id: "integer",
      name: "Integer compute",
      description: "Hash calculations across selected threads",
    },
    {
      id: "float",
      name: "Floating point",
      description: "Continuous arithmetic & result verification",
    },
    {
      id: "memory",
      name: "Memory integrity",
      description: "Per-thread pattern writes & readback",
    },
  ],
};
