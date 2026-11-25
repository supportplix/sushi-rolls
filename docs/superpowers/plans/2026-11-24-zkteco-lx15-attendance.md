# ZKTeco LX15 Attendance Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin create an employee in SUSHI ROLLS, enroll that employee's fingerprint on a ZKTeco LX15 from the app, and receive durable real-time attendance while the app is open or closed.

**Architecture:** A C# x86 bridge uses the official 32-bit ZKTeco SDK behind a polling-first device adapter. It stores events in a durable local outbox and syncs through a narrow Supabase Edge Function. Electron exposes admin-only enrollment, attendance, and device settings; the same bridge can run as an app process, logon agent, or Windows service.

**Tech Stack:** C#/.NET Framework 4.x x86, ZKTeco Standalone SDK 6.2.4.11, Electron 32/React 18/TypeScript, Supabase Postgres/Edge Functions, Vitest, NSIS.

**Spec:** `docs/superpowers/specs/2026-11-24-zkteco-lx15-attendance-design.md`

## Global Constraints

- Windows x64 host; bridge must be compiled `x86` because the official ZKTeco SDK is 32-bit.
- Do not load ZKTeco DLLs into Electron x64.
- Do not store fingerprint images or templates in Supabase, logs, or outbox files.
- Do not use or ship a Supabase service-role key in the desktop app.
- Do not patch, re-sign, or silently replace a ZKTeco driver.
- Driver/service installation requires explicit elevated action; normal app installation must remain non-elevated.
- One LX15 in v1.
- Preserve existing uncommitted SUSHI ROLLS work; do not reset or clean the repository.
- Do not create a git commit unless the user explicitly asks.
- All user-visible copy remains Arabic and follows existing SUSHI ROLLS UI patterns.
- Every task must end with a verification command and concrete expected output.

---

### Task 0: Prove the LX15 USB transport path

**Files:**
- Create: `vendor/zkteco/README.txt`
- Create: `vendor/zkteco/driver-setup-5.0.0.12.exe`
- Modify: none

**Interfaces:**
- Consumes: signed official ZKTeco driver installer extracted from the official ZKTime 3.0 package.
- Produces: a verified `Z_Connect_USB_STD` connection through the installed libusb driver, or a verified ZKTeco `COMx` fallback, or a documented hard stop.

- [ ] **Step 1: Record the current device and driver**

Run:

```powershell
Get-PnpDevice -PresentOnly | Where-Object InstanceId -match 'VID_1B55&PID_0A01' | Select-Object Status,Class,FriendlyName,InstanceId
Get-CimInstance Win32_PnPSignedDriver | Where-Object DeviceID -match 'VID_1B55&PID_0A01' | Select-Object DeviceName,DriverVersion,InfName,IsSigned
Get-PnpDevice -PresentOnly -Class Ports | Select-Object Status,FriendlyName,InstanceId
```

Expected: `Attendance Device`, driver `1.2.6.0`, service `libusb0`, and no new ZKTeco COM port.

- [ ] **Step 2: Stage the official 32-bit SDK**

Copy the official `zkemsdk.dll`, `commpro.dll`, `usbstd.dll`, `usbcomm.dll`, and supporting DLLs from the ZKTeco Standalone SDK package to `vendor/zkteco/sdk/`. Record SHA-256 hashes and source URLs in `vendor/zkteco/README.txt`.

- [ ] **Step 3: Build a minimal x86 USB-STD probe**

Create a temporary x86 C# probe that P/Invokes:

```csharp
[DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall)]
private static extern IntPtr Z_Connect_USB_STD(ushort vid, int reserved, int pid, int machineNumber);
```

Call `Z_Connect_USB_STD(0x1B55, 0, 0x0A01, 1)`. A non-null return is the direct libusb connection handle. Close it with `Z_Close(handle)` when finished.

- [ ] **Step 4: Verify direct USB or fall back to COM**

Run the probe with the LX15 connected. Expected: non-null handle and successful `Z_GetDeviceStatus`/`Z_GetSerialNumber`.

If direct USB STD fails, only then run the staged signed official driver installer with elevation and verify a ZKTeco-owned `COMx`. Do not edit `oem34.inf`, do not bind `usbser.sys` manually, and do not continue without a proven transport.

- [ ] **Step 5: Record the gate result**

Create `vendor/zkteco/README.txt` with SDK hashes, driver hash/signer if used, transport type, device identity, and date. Verification is a successful device identity read through `Z_Connect_USB_STD` or `Connect_Com`.

---

### Task 1: Scaffold the x86 bridge and fake-device self-tests

**Files:**
- Create: `zkteco-bridge/Program.cs`
- Create: `zkteco-bridge/Contracts.cs`
- Create: `zkteco-bridge/IZkTecoDevice.cs`
- Create: `zkteco-bridge/FakeDevice.cs`
- Create: `zkteco-bridge/build-bridge.ps1`

**Interfaces:**
- Consumes: nothing.
- Produces: `ZkTecoBridge.exe`, `--self-test`, `DeviceInfo`, `EnrollmentResult`, `AttendanceEvent`, and `IZkTecoDevice`.

- [ ] **Step 1: Define contracts**

Create `Contracts.cs`:

```csharp
namespace SushiRolls.ZkTeco;

public sealed record DeviceInfo(string Serial, string Firmware, string Algorithm, int Users, int Fingerprints, int Records);
public sealed record EnrollmentResult(string DeviceUserId, string Status, int TemplateLength, string? Error);
public sealed record AttendanceEvent(string DeviceUserId, int VerifyMode, int RawState, int Year, int Month, int Day, int Hour, int Minute, int Second, int WorkCode);
```

Create `IZkTecoDevice.cs`:

```csharp
namespace SushiRolls.ZkTeco;

public interface IZkTecoDevice : IDisposable
{
    bool Connect(int comPort, int machineNumber = 1, int baudRate = 115200);
    DeviceInfo? ReadInfo();
    bool EnsureUser(string deviceUserId, string name, int privilege = 0);
    bool StartEnrollment(string deviceUserId, int fingerIndex = 0);
    EnrollmentResult PollEnrollment(string deviceUserId);
    IReadOnlyList<AttendanceEvent> ReadNewAttendance();
    void Disconnect();
}
```

- [ ] **Step 2: Implement the fake and self-test entry point**

`FakeDevice.cs` must return deterministic `DeviceInfo`, switch to `enrolled` after two `PollEnrollment` calls, and return one attendance event from `ReadNewAttendance`.

`Program.cs` must support:

```text
ZkTecoBridge.exe --self-test
ZkTecoBridge.exe --probe --com 7
```

`--self-test` exits nonzero if the fake contract fails.

- [ ] **Step 3: Add the x86 build script**

Create `build-bridge.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot '*.cs'
$out = Join-Path $PSScriptRoot 'bin\ZkTecoBridge.exe'
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
& "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe" /nologo /target:exe /platform:x86 /optimize+ /out:$out $src
if ($LASTEXITCODE -ne 0) { throw 'bridge build failed' }
```

- [ ] **Step 4: Build and run the self-test**

```powershell
.\zkteco-bridge\build-bridge.ps1
.\zkteco-bridge\bin\ZkTecoBridge.exe --self-test
```

Expected: build succeeds and self-test prints `SELF-TEST PASS`.

---

### Task 2: Implement direct USB-STD connection and device probe

**Files:**
- Create: `zkteco-bridge/ZkTecoUsbDevice.cs`
- Modify: `zkteco-bridge/Program.cs`
- Modify: `zkteco-bridge/build-bridge.ps1`

**Interfaces:**
- Consumes: `IZkTecoDevice`, official SDK DLLs staged in Task 0, LX15 VID `0x1B55` and PID `0x0A01`.
- Produces: `ZkTecoUsbDevice` and JSON probe output.

- [ ] **Step 1: Add direct SDK P/Invoke declarations**

```csharp
[DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall)]
private static extern IntPtr Z_Connect_USB_STD(ushort vid, int reserved, int pid, int machineNumber);

[DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall)]
private static extern void Z_Close(IntPtr handle);

[DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall)]
private static extern int Z_GetSerialNumber(IntPtr handle, StringBuilder buffer, int capacity);

[DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall)]
private static extern int Z_GetDeviceStatus(IntPtr handle, ref int users, ref int fingerprints, ref int records);
```

Copy the SDK DLLs next to the bridge executable before loading. Do not register COM for this path.

- [ ] **Step 2: Implement `ZkTecoUsbDevice.Connect`**

Call `Z_Connect_USB_STD(0x1B55, 0, 0x0A01, 1)`. Throw a descriptive exception if the returned handle is zero. Store the handle and close it in `Disconnect`.

- [ ] **Step 3: Implement `--probe` JSON output**

`--probe --usb` connects, reads serial and status, disconnects, and prints:

```json
{"serial":"...","firmware":"...","algorithm":"...","users":0,"fingerprints":0,"records":0}
```

Firmware and algorithm may be read through additional `Z_Get*` exports after the connection is proven.

- [ ] **Step 4: Run the real probe**

```powershell
.\zkteco-bridge\bin\ZkTecoBridge.exe --probe --usb
```

Expected: valid JSON with the real LX15 serial and zero or current counts. If connection fails, capture the SDK last error and stop; do not continue to enrollment.

---

### Task 3: Implement durable local outbox and deterministic event hashes

**Files:**
- Create: `zkteco-bridge/Outbox.cs`
- Create: `zkteco-bridge/EventHash.cs`
- Modify: `zkteco-bridge/FakeDevice.cs`
- Modify: `zkteco-bridge/Program.cs`

**Interfaces:**
- Consumes: `AttendanceEvent`.
- Produces: `Outbox.Append`, `Outbox.ReadPending`, `Outbox.MarkSynced`, and `EventHash.For`.

- [ ] **Step 1: Write the failing self-test assertions**

Add self-test checks:

```csharp
var hash1 = EventHash.For(firstEvent);
var hash2 = EventHash.For(firstEvent);
if (hash1 != hash2 || hash1.Length != 64) throw new Exception("event hash is not stable");
```

- [ ] **Step 2: Implement SHA-256 event hashing**

Hash an unambiguous canonical string containing device serial, user ID, timestamp to the second, verify mode, raw state, and work code. Use SHA-256 and lowercase hex.

- [ ] **Step 3: Implement atomic JSON outbox**

`Outbox` stores a JSON array under `%ProgramData%\SUSHI ROLLS\zkteco\outbox.json`. Each append:

1. Reads the current array.
2. Writes a temp file in the same directory.
3. Flushes the file stream.
4. Atomically replaces the target file.
5. Removes stale temp files on startup.

Entries contain `event_id`, `payload_hash`, `payload`, `created_at`, and `synced`.

- [ ] **Step 4: Test crash-safe dedupe**

Self-test appends the same event twice and verifies only one entry exists. It then marks the entry synced and verifies a new process can read an empty pending set.

- [ ] **Step 5: Run self-test**

```powershell
.\zkteco-bridge\bin\ZkTecoBridge.exe --self-test
```

Expected: `SELF-TEST PASS`.

---

### Task 4: Implement employee creation and enrollment polling

**Files:**
- Create: `zkteco-bridge/EnrollmentWorker.cs`
- Create: `zkteco-bridge/DeviceCommand.cs`
- Modify: `zkteco-bridge/ZkTecoComDevice.cs`
- Modify: `zkteco-bridge/Program.cs`

**Interfaces:**
- Consumes: `IZkTecoDevice`, `DeviceCommand`.
- Produces: `EnrollmentWorker.ExecuteAsync` and command result JSON.

- [ ] **Step 1: Define command contract**

```csharp
public sealed record DeviceCommand(string Id, string Type, string DeviceUserId, string Name, int Privilege, string IdempotencyKey);
```

Allowed types: `create_user`, `update_user`, `start_enrollment`, `disable_user`, `delete_user`.

- [ ] **Step 2: Implement create/update**

Call `SSR_SetUserInfo` through late-bound COM with machine number `1`, user ID, privilege, name, empty password, empty card number, and `Enabled = true`.

- [ ] **Step 3: Implement enrollment**

Call `StartEnrollEx(deviceUserId, 0, 1)`, then poll `SSR_GetUserTmpStr` every 750 ms for up to 60 seconds. Success requires template length greater than zero. Call `CancelOperation` after success, timeout, or failure.

- [ ] **Step 4: Add fake enrollment test**

The fake must expose `awaiting_scan`, then `enrolled` after two polls. Self-test verifies timeout and success paths.

- [ ] **Step 5: Add a local command file for the hardware spike**

Support:

```text
ZkTecoBridge.exe --enroll-test --com <n> --user-id 1001 --name "Test Employee"
```

This creates the user, starts enrollment, waits for a real scan, prints the result, and does not delete the test user automatically.

- [ ] **Step 6: Run the hardware enrollment spike**

Expected: device enters enrollment mode, a real fingerprint scan completes, and the bridge prints `enrolled` with nonzero template length. Stop if this fails.

---

### Task 5: Implement near-real-time attendance polling and raw event output

**Files:**
- Create: `zkteco-bridge/AttendancePoller.cs`
- Modify: `zkteco-bridge/ZkTecoComDevice.cs`
- Modify: `zkteco-bridge/Program.cs`

**Interfaces:**
- Consumes: `IZkTecoDevice`, `Outbox`, `EventHash`.
- Produces: `AttendancePoller.RunAsync` and one JSON line per new raw event.

- [ ] **Step 1: Implement `ReadNewGLogData` polling**

Every two seconds call `ReadNewGLogData(1)`, then repeatedly call `SSR_GetGeneralLogData` until it returns false. Convert the returned fields into `AttendanceEvent`.

- [ ] **Step 2: Add `--attendance-test` mode**

The bridge connects, polls for 120 seconds, appends events to the outbox, and prints each new event as JSON. It must disconnect cleanly on Ctrl+C.

- [ ] **Step 3: Test with real punches**

Create two real punches for the test user. Expected: two distinct events with correct user ID, timestamp, verify mode, raw state, and stable hashes.

- [ ] **Step 4: Test replay dedupe**

Run the poller again without new punches. Expected: no duplicate outbox entries and no duplicate JSON lines.

---

### Task 6: Add Supabase schema, RLS, and attendance transaction RPC

**Files:**
- Create: `supabase/migrations/20261124090000_zkteco_attendance.sql`
- Create: `supabase/tests/zkteco_attendance.sql`

**Interfaces:**
- Consumes: existing `employees`, `attendance`, `profiles`, and permission helpers.
- Produces: tables and RPCs defined in the spec.

- [ ] **Step 1: Create tables and constraints**

Implement `attendance_devices`, `employee_devices`, `attendance_events`, `device_commands`, and `attendance` additions exactly as specified. Include:

```sql
create unique index if not exists attendance_one_open_per_employee_day
on attendance(employee_id, work_date)
where check_out is null;
```

- [ ] **Step 2: Add RLS policies**

- Super admin with `device.manage`: full device settings and token metadata.
- `employees.manage`: read/write employee device mappings and enrollment commands.
- `attendance.view`: read attendance and resolved events.
- `attendance.manage`: correct attendance and resolve raw events.
- Anonymous and ordinary employees: no direct device-table writes.

- [ ] **Step 3: Add transactional attendance RPC**

Create `apply_attendance_event(p_event_id uuid)` as `security definer`. It must:

1. Lock the raw event row.
2. Resolve the employee mapping.
3. Apply the configured attendance policy.
4. Insert or update the daily attendance row.
5. Link event IDs.
6. Mark the raw event resolved.
7. Commit once; replay returns the existing result.

- [ ] **Step 4: Add SQL tests**

`supabase/tests/zkteco_attendance.sql` must assert:

- duplicate `payload_hash` is rejected.
- alternating mode creates one open row then closes it.
- second replay does not create a second row.
- unknown user remains unresolved.
- ordinary employee cannot insert commands.
- manager with deny override cannot manage devices.

- [ ] **Step 5: Run local database verification**

```bash
supabase db reset
supabase test db
```

Expected: migration applies and all SQL assertions pass.

---

### Task 7: Implement the `device-sync` Edge Function

**Files:**
- Create: `supabase/functions/device-sync/index.ts`
- Create: `supabase/functions/device-sync/device-sync.test.ts`

**Interfaces:**
- Consumes: device bearer token, tables from Task 6.
- Produces: `heartbeat`, `push_events`, `pull_commands`, `complete_command`, `fail_command`.

- [ ] **Step 1: Implement token verification**

Hash the bearer token with SHA-256, compare to `attendance_devices.device_token_hash` using constant-time comparison, and reject missing/revoked tokens with `401`.

- [ ] **Step 2: Implement payload schemas and rate limits**

Use Zod schemas for each action. Limit `push_events` to 500 events per request and commands to 50 per request. Return `429` when limits are exceeded.

- [ ] **Step 3: Implement idempotent actions**

- `push_events`: insert raw events with `on conflict (device_id, payload_hash) do nothing`, then call `apply_attendance_event` for inserted rows.
- `pull_commands`: return oldest pending commands for the authenticated device.
- `complete_command` / `fail_command`: update only commands belonging to that device and include the idempotency key.
- `heartbeat`: update last seen, clock drift, and optional bridge version.

- [ ] **Step 4: Write function tests**

Tests must cover valid token, invalid token, duplicate events, unknown user, command ownership, oversized batch, and revoked token.

- [ ] **Step 5: Run function tests and local serve**

```bash
supabase functions serve device-sync
supabase functions test device-sync
```

Expected: all tests pass and local HTTP smoke requests return the documented status codes.

---

### Task 8: Add Electron lifecycle and secure IPC

**Files:**
- Create: `src/main/zkteco.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/shared/ipc.ts`
- Create: `tests/zkteco-ipc.test.ts`

**Interfaces:**
- Consumes: bridge named-pipe protocol and Edge Function-backed renderer APIs.
- Produces: `window.sushiRolls.zkteco` with `getStatus`, `startEnrollment`, `retryEnrollment`, `disableEmployee`, `setPolicy`, `setBackgroundMode`, `rotateToken`.

- [ ] **Step 1: Add named-pipe hosting to the bridge**

The bridge hosts `\\.\pipe\SushiRolls.ZkTeco`. Supported messages:

```json
{"id":"uuid","type":"get_status"}
{"id":"uuid","type":"get_health"}
```

Responses use the same `id` and a Zod-compatible JSON payload.

- [ ] **Step 2: Implement Electron bridge manager**

`src/main/zkteco.ts` must:

- Start the bridge in app-only mode.
- Connect to an existing logon-agent/service pipe when configured.
- Enforce a single bridge owner with the named mutex.
- Reconnect with exponential backoff.
- Validate `event.senderFrame` and admin permission for every IPC call.
- Never expose the device token or raw COM handle to the renderer.

- [ ] **Step 3: Extend shared IPC and preload**

Add Zod request/response schemas in `src/shared/ipc.ts` and explicit method signatures in `src/preload/index.d.ts`.

- [ ] **Step 4: Write IPC tests**

Mock `electron.ipcMain` and assert:

- unknown channels are rejected.
- non-admin senders cannot change policy or background mode.
- malformed payloads are rejected.
- renderer receives only status DTOs, never token or driver internals.

- [ ] **Step 5: Run checks**

```bash
npm run typecheck
npm test -- --run tests/zkteco-ipc.test.ts
```

Expected: typecheck clean and IPC tests pass.

---

### Task 9: Build employee enrollment and attendance UI

**Files:**
- Create: `src/renderer/src/lib/zkteco.ts`
- Modify: `src/renderer/src/pages/EmployeesPage.tsx`
- Modify: `src/renderer/src/pages/SettingsPage.tsx`
- Modify: `src/renderer/src/i18n/ar.ts`

**Interfaces:**
- Consumes: `window.sushiRolls.zkteco`, Supabase attendance/device tables.
- Produces: enrollment status UI, attendance live view, and admin device settings.

- [ ] **Step 1: Add typed renderer client**

`zkteco.ts` wraps IPC and Supabase reads. It must expose loading, error, and retry states without throwing raw backend messages to the UI.

- [ ] **Step 2: Add employee enrollment controls**

In `EmployeesPage`, show a status badge and actions:

- `تسجيل البصمة`
- `إعادة التسجيل`
- `تعطيل على الجهاز`

Disable duplicate actions while a command is pending. Poll command status every two seconds and update the badge on completion.

- [ ] **Step 3: Upgrade attendance tab**

Add date/employee filters, realtime subscription with polling fallback, duration calculation, source badge, unresolved events section, and audited manual correction dialog.

- [ ] **Step 4: Add Settings → ZKTeco card`

The card is visible only with `device.manage` and shows:

- connection/driver/COM status
- last seen/sync and clock drift
- attendance policy selector
- background mode selector
- token rotate/revoke
- service install/start/stop/remove
- outbox pending count

- [ ] **Step 5: Verify UI manually in the running app**

Start the dev app, open Employees and Settings, and verify Arabic labels, empty/loading/error states, admin gating, and no console errors. Test at 150% scaling.

Expected: enrollment and attendance controls are usable without exposing technical secrets.

---

### Task 10: Add logon-agent and Windows Service modes

**Files:**
- Create: `zkteco-bridge/ServiceRunner.cs`
- Create: `zkteco-bridge/install-service.ps1`
- Create: `zkteco-bridge/install-logon-agent.ps1`
- Modify: `zkteco-bridge/Program.cs`
- Modify: `electron-builder.yml`

**Interfaces:**
- Consumes: bridge executable and existing named mutex/pipe.
- Produces: `--service`, `--agent`, service scripts, and packaged resources.

- [ ] **Step 1: Implement service host**

`ServiceRunner.cs` uses `System.ServiceProcess.ServiceBase`. On start it runs the same worker as console mode; on stop it disconnects and flushes the outbox.

- [ ] **Step 2: Implement service install/remove scripts**

Scripts must use `sc.exe create/delete`, require elevation, and refuse to proceed if the named mutex is already owned by app mode. Service account is `LocalSystem`; device token is stored with machine-scope DPAPI.

- [ ] **Step 3: Implement logon-agent script**

Create a per-user Startup shortcut only after admin confirmation. It runs `ZkTecoBridge.exe --agent` hidden and does not require elevation.

- [ ] **Step 4: Update packaging**

Add bridge executable, SDK DLLs, and signed driver installer to electron-builder `extraResources`; add native binaries to `asarUnpack`. Do not run the driver installer during normal install.

- [ ] **Step 5: Verify modes**

- App-only: bridge starts with Electron and exits with it.
- Logon agent: bridge survives app close and starts after login.
- Service: bridge starts before login and survives logout.
- Only one mode can own the device; others report `busy` and retry later.

Expected: all three modes pass the ownership test.

---

### Task 11: End-to-end acceptance and release verification

**Files:**
- Create: `tests/e2e/zkteco-attendance.md`
- Modify: none

**Interfaces:**
- Consumes: all previous tasks and the real LX15.
- Produces: signed-off acceptance evidence and a packaged installer.

- [ ] **Step 1: Run automated verification**

```bash
npm run typecheck
npm test
npm run build
supabase db reset
supabase test db
supabase functions test device-sync
.\zkteco-bridge\build-bridge.ps1
.\zkteco-bridge\bin\ZkTecoBridge.exe --self-test
```

Expected: every command exits zero.

- [ ] **Step 2: Run hardware acceptance**

Execute and record all twelve hardware tests from the spec, including enrollment, check-in/out, duplicate replay, USB disconnect, internet outage, app closure, logon agent, service mode, and unknown user handling.

- [ ] **Step 3: Verify package contents**

Inspect the NSIS output and confirm:

- `ZkTecoBridge.exe` is x86.
- SDK DLLs are present and not loaded by Electron.
- Signed driver installer hash matches `vendor/zkteco/README.txt`.
- No token, service-role key, fingerprint template, or local outbox is packaged.
- Existing SUSHI ROLLS installer publisher and DPI settings are unchanged.

- [ ] **Step 4: Run packaged smoke test**

Install the built SUSHI ROLLS installer, open the app, connect to LX15, create one test employee, enroll, punch in/out, and verify attendance in the packaged app.

- [ ] **Step 5: Record final evidence**

Write exact commands, outputs, device status, COM port, test employee ID, attendance row IDs, and package SHA-256 in `tests/e2e/zkteco-attendance.md`. Do not include fingerprint data or device tokens.

Expected: all acceptance criteria in the spec pass; otherwise the release task remains incomplete.
