// ============================================================
// Watson Remote IT Operator — TEST-ONLY sentinel command specs
// ------------------------------------------------------------
// Fixed, pre-reviewed PowerShell for a benign, disposable
// "sentinel" process used ONLY to prove the real repair→verify
// loop on a non-production Windows test VM. These are NOT generic
// process control: they only ever target a process launched with
// the constant WATSON_SENTINEL_MARKER token. The catalog action is
// testOnly and refused unless WATSON_ALLOW_TESTONLY=true.
// ============================================================
import type { LocalCommandSpec } from './local-windows';

// Read-only: report the sentinel process state.
export const SENTINEL_HEALTH: LocalCommandSpec = {
  id: 'sentinel_health',
  writesDevice: false,
  description: 'Test sentinel process state (read-only).',
  script: `$p = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*WATSON_SENTINEL_MARKER*' } | Select-Object -First 1; if ($p) { $st = (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue).StartTime; [pscustomobject]@{ present = $true; procId = $p.ProcessId; startTime = if ($st) { $st.ToString('o') } else { $null } } | ConvertTo-Json -Compress } else { '{"present":false,"procId":null,"startTime":null}' }`
};

// Low-risk test-only WRITE: stop and relaunch the sentinel. Only ever
// targets processes carrying the constant WATSON_SENTINEL_MARKER token.
export const RESTART_SENTINEL: LocalCommandSpec = {
  id: 'restart_sentinel_process',
  writesDevice: true,
  description: 'Stop and relaunch the disposable test sentinel process.',
  script: `$old = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*WATSON_SENTINEL_MARKER*' } | ForEach-Object { $_.ProcessId }); foreach ($id in $old) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 700; Start-Process -FilePath powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','$sentinel = "WATSON_SENTINEL_MARKER"; while ($true) { Start-Sleep -Seconds 5 }'; Start-Sleep -Milliseconds 1000; $new = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*WATSON_SENTINEL_MARKER*' } | Select-Object -First 1; [pscustomobject]@{ restarted = $true; oldPids = $old; newPid = $new.ProcessId } | ConvertTo-Json -Compress`
};

// Helper (fixed): launch a sentinel if none exists (used to establish a baseline).
export const START_SENTINEL: LocalCommandSpec = {
  id: 'start_sentinel_process',
  writesDevice: true,
  description: 'Launch the disposable test sentinel process if not already running.',
  script: `$p = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*WATSON_SENTINEL_MARKER*' } | Select-Object -First 1; if (-not $p) { Start-Process -FilePath powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','$sentinel = "WATSON_SENTINEL_MARKER"; while ($true) { Start-Sleep -Seconds 5 }'; Start-Sleep -Milliseconds 1000 }; $now = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*WATSON_SENTINEL_MARKER*' } | Select-Object -First 1; [pscustomobject]@{ running = $true; procId = $now.ProcessId } | ConvertTo-Json -Compress`
};
