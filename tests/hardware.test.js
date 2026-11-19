import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  normalizeSettings,
  DEFAULT_SETTINGS,
  optimizationScript,
  readSaved,
} from "../src/hardware.js";

test("settings bound unsafe input and normalize persisted types", () => {
  assert.equal(normalizeSettings({ threads: 0 }).threads, 1);
  assert.deepEqual(
    normalizeSettings({
      duration: -50,
      threads: 9999,
      intensity: 1000,
      temperatureLimit: 100,
      sampleMs: 1,
      units: "kelvin",
      theme: "unknown",
    }),
    {
      ...DEFAULT_SETTINGS,
      duration: 60,
      threads: 32,
      intensity: 100,
      temperatureLimit: 92,
    },
  );
  assert.equal(
    normalizeSettings({ duration: "300", saveReports: false }).duration,
    300,
  );
  assert.equal(normalizeSettings({ saveReports: false }).saveReports, false);
  assert.equal(
    normalizeSettings({ temperatureLimit: "invalid" }).temperatureLimit,
    85,
  );
});
test("unavailable or corrupt storage falls back without breaking startup", () => {
  globalThis.localStorage = { getItem: () => "{invalid json" };
  assert.deepEqual(readSaved("settings", DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  globalThis.localStorage = {
    getItem: () => {
      throw new Error("disabled");
    },
  };
  assert.deepEqual(readSaved("settings", DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  delete globalThis.localStorage;
});
test("generated Linux scripts parse for both profiles and preserve rollback before writes", () => {
  for (const profile of ["performance", "balanced"]) {
    const script = optimizationScript("linux", profile);
    const result = spawnSync("bash", ["-n"], {
      input: script,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      script.indexOf('cat "$policy/scaling_governor" >') <
        script.indexOf("printf"),
    );
    assert.ok(script.includes("${policy##*/}"));
    assert.ok(script.includes("scaling_available_governors"));
  }
});
test("Windows scripts stop on missing plans and include rollback for both profiles", () => {
  for (const profile of ["performance", "balanced"]) {
    const script = optimizationScript("windows", profile);
    assert.ok(
      script.indexOf("Set-Content -Path $state") <
        script.indexOf("powercfg /setactive"),
    );
    assert.ok(script.includes("if ($LASTEXITCODE -ne 0)"));
    assert.ok(script.includes("powercfg /setactive (Get-Content $state)"));
  }
});
