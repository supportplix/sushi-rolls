# SUSHI ROLLS — ZKTeco LX15 Attendance Integration Design

Date: 2026-11-24  
Status: Approved for implementation  
Scope: One ZKTeco LX15 USB attendance terminal, Windows x64 SUSHI ROLLS desktop app, existing Supabase backend.

## 1. Goal

Employees are created in SUSHI ROLLS. The system creates the matching user on the LX15, asks the employee to scan a fingerprint on the device, confirms enrollment, and then records real-time check-in/check-out events against that employee. Attendance continues to be collected while SUSHI ROLLS is closed and is synchronized when connectivity returns.

The system must not store fingerprint images or templates in Supabase. Biometric templates remain only on the LX15.

## 2. Non-goals for v1

- Multiple branches or multiple LX15 devices.
- Face, card, or palm enrollment.
- Replacing Supabase authentication with fingerprint login.
- Automatic payroll calculation.
- Silent driver replacement or silent elevation.
- Editing firmware or reverse-engineering the ZKTeco wire protocol.

## 3. Verified current state and constraints

- SUSHI ROLLS is Electron 32.3.3 x64, React 18, TypeScript, Vite, and Supabase.
- The renderer is sandboxed with `contextIsolation` and no Node integration.
- Existing `employees`, `attendance`, `profiles`, and `user_permissions` tables are present.
- Existing attendance RPCs use `auth.uid()` and server time; they do not accept a device or employee ID.
- The LX15 is connected by USB and DC. Windows reports `USB\\VID_1B55&PID_0A01` as `Attendance Device`, status `OK`.
- The installed signed ZKTeco driver is version `1.2.6.0`, INF `oem34.inf`, service `libusb0`.
- `oem34.inf` is a libusb-win32 driver. It does not expose a virtual COM port.
- The ZKTeco Standalone SDK USB-client workflow can use `Connect_Com` with a virtual COM port, but the same official `zkemsdk.dll` also exports `Z_Connect_USB_STD`, which loads `usbstd.dll` and uses the installed libusb-win32 transport directly. The direct USB STD path must be proven first; driver replacement is only a fallback.
- The official ZKTime 3.0 package contains a signed ZKTeco driver installer and USB-client components, but exact LX15/PID `0A01` virtual-COM compatibility must be proven before UI work.
- The official Standalone SDK DLLs are 32-bit. Electron x64 cannot load them directly.
- A C# x86 bridge is feasible because the Windows .NET Framework C# compiler is available and .NET Framework 4.x is present on supported Windows systems.

## 4. Architecture

### 4.1 ZkTecoBridge

A small C# executable compiled for x86 using the official ZKTeco 32-bit SDK.

Responsibilities:

- Acquire a named mutex so only one process accesses the LX15.
- Discover the ZKTeco USB device and connect with `Z_Connect_USB_STD` through the official libusb transport. Use `Connect_Com` only if a verified ZKTeco virtual COM port is present.
- Read device identity, capacity, clock, and health.
- Execute queued employee commands: create, update, start enrollment, disable, delete.
- Start enrollment and poll for template completion; poll new attendance records every two seconds. COM event sinks are optional only after the polling path is proven.
- Poll new attendance records as a fallback and catch-up mechanism.
- Persist raw attendance events and pending commands in a durable local outbox.
- Send events and command results to the narrow Supabase Edge Function.
- Poll pending device commands from Supabase.
- Expose health and logs to the Electron app through a local named pipe.
- Run in console mode, logon-agent mode, or Windows Service mode.

The bridge never accepts arbitrary commands from the renderer. It only accepts authenticated, idempotent commands previously stored in Supabase by an authorized admin.

### 4.2 Runtime modes

`attendance_devices.background_mode` is admin-configurable:

- `app_only`: Electron starts and stops the bridge with the app.
- `logon_agent`: a per-user startup entry starts the bridge after Windows login and keeps it running when SUSHI ROLLS is closed.
- `windows_service`: the bridge is installed as a Windows service and starts before user login. Installation, start, stop, and removal require explicit admin action and UAC where necessary.

All modes share the same bridge executable, outbox, device mutex, and command protocol.

### 4.3 Electron integration

- `src/main` owns bridge lifecycle and validates all IPC senders.
- `src/preload` exposes a narrow allowlisted API.
- `src/shared/ipc.ts` contains Zod contracts for device status, enrollment status, attendance summaries, and admin actions.
- The renderer never receives a device token, service-role key, driver path, or raw SDK handle.
- The app can display bridge health while the bridge runs independently.

### 4.4 Supabase integration

A single Edge Function, `device-sync`, is the only server endpoint used by the bridge. It supports:

- `heartbeat`
- `push_events`
- `pull_commands`
- `complete_command`
- `fail_command`

The function verifies a rotatable per-device bearer token, hashes it for comparison, applies rate limits, validates payloads, and performs only device-related operations. The service-role key remains inside Supabase and is never shipped to the desktop app.

Admin UI operations use normal Supabase RPCs with RLS and the existing permission system.

## 5. Employee enrollment flow

1. An admin creates or edits an employee in SUSHI ROLLS.
2. A database transaction reserves a stable `device_user_id` for the employee and creates an idempotent `create_user` or `update_user` command.
3. The bridge pulls the command and creates or updates the LX15 user with `SSR_SetUserInfo` or the firmware-appropriate equivalent.
4. The bridge starts enrollment with `StartEnrollEx` and registers `OnEnrollFingerEx`.
5. The LX15 prompts the employee to scan. The bridge polls for a completed template and the UI shows `pending`, `awaiting_scan`, `scanning`, `enrolled`, or `failed`. A COM enrollment event may be used later only if the polling path is stable.
6. On a nonzero template length, the bridge marks enrollment complete and confirms the user exists on the device. `OnEnrollFingerEx` is an optional optimization, not a v1 dependency.
7. On timeout or failure, the command remains retryable and the admin can retry without creating a duplicate device user.
8. Disabling an employee disables or deletes the device user according to the admin-selected policy. Attendance history is retained.

No fingerprint template is read into SUSHI ROLLS or uploaded to Supabase.

## 6. Attendance flow

1. The bridge polls `ReadNewGLogData` every two seconds for near-real-time attendance and uses the same path for catch-up. COM realtime event sinks are optional after the polling path is proven.
2. Each raw event contains device ID, device user ID, device timestamp, verify mode, raw state, work code, and a deterministic payload hash.
3. The event is appended to the local durable outbox before any network acknowledgement.
4. The bridge sends batches to `device-sync`.
5. Supabase inserts the raw event idempotently using `unique(device_id, payload_hash)`.
6. The server resolves `device_user_id` to `employee_id` and applies the admin-selected attendance policy.
7. The existing daily `attendance` row is created or updated transactionally.
8. The UI receives realtime updates where available and falls back to polling.

### 6.1 Attendance policies

- `alternating`: the first valid event after a closed or missing session becomes check-in; the next valid event for the same workday becomes check-out.
- `device_state`: use the LX15 state selected by the employee, mapped to check-in/check-out/break/OT states.
- `raw_only`: store raw events without automatically changing the daily attendance row; an admin resolves them.

Policy changes affect future events only. Already-resolved attendance is not silently rewritten.

### 6.2 Time and identity

- Device timestamps are stored as provided, together with the configured device timezone.
- Clock drift is measured and displayed. Changing the device clock requires an explicit admin command.
- Unknown device users are stored as unresolved raw events and surfaced in the UI; they are never guessed.
- Duplicate events are safely ignored. Identical legitimate punches in the same second are treated as duplicates in v1.

## 7. Data model

### 7.1 `attendance_devices`

- `id uuid primary key`
- `name text not null`
- `serial_number text unique`
- `usb_vid text not null`
- `usb_pid text not null`
- `status text not null`
- `background_mode text not null`
- `attendance_mode text not null`
- `timezone text not null`
- `device_token_hash text`
- `last_seen_at timestamptz`
- `last_sync_at timestamptz`
- `clock_drift_seconds integer`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

### 7.2 `employee_devices`

- `id uuid primary key`
- `employee_id uuid not null references employees(id)`
- `device_id uuid not null references attendance_devices(id)`
- `device_user_id text not null`
- `enrollment_status text not null`
- `enrolled_at timestamptz`
- `last_synced_at timestamptz`
- `disabled_at timestamptz`
- `unique(device_id, device_user_id)`
- `unique(device_id, employee_id)`

### 7.3 `attendance_events`

- `id uuid primary key`
- `device_id uuid not null references attendance_devices(id)`
- `employee_id uuid references employees(id)`
- `device_user_id text not null`
- `occurred_at timestamptz not null`
- `device_timestamp text not null`
- `timezone text not null`
- `verify_mode integer not null`
- `raw_state integer not null`
- `resolved_kind text`
- `work_code integer`
- `payload_hash text not null`
- `resolution_status text not null`
- `created_at timestamptz not null default now()`
- `unique(device_id, payload_hash)`

### 7.4 `device_commands`

- `id uuid primary key`
- `device_id uuid not null references attendance_devices(id)`
- `employee_id uuid references employees(id)`
- `type text not null`
- `payload jsonb not null`
- `idempotency_key text not null`
- `status text not null`
- `attempts integer not null default 0`
- `last_error text`
- `created_by uuid not null references auth.users(id)`
- `created_at timestamptz not null default now()`
- `processed_at timestamptz`
- `unique(device_id, idempotency_key)`

### 7.5 `attendance` additions

- `source text not null default 'manual'`
- `device_id uuid references attendance_devices(id)`
- `check_in_event_id uuid references attendance_events(id)`
- `check_out_event_id uuid references attendance_events(id)`
- `updated_at timestamptz not null default now()`

A partial unique index prevents more than one open attendance row per employee and workday. Check-out updates are restricted to the intended workday and are audited.

## 8. Security

- Per-device token is generated randomly, shown once, stored hashed in Supabase, encrypted locally with DPAPI, and rotatable/revocable by a super admin.
- The Edge Function uses a narrow allowlist of operations and validates every payload with schema validation.
- RLS denies direct client writes to device command and raw event tables.
- IPC channels are allowlisted and validate sender identity and admin permission.
- Fingerprint templates never leave the LX15.
- Local logs exclude tokens and biometric data.
- Admin actions are written to an audit table with actor, action, target, timestamp, and result.
- Driver and service installation are explicit admin actions. No silent elevation or driver replacement is allowed.

## 9. User interface

### 9.1 EmployeesPage

- Show enrollment status per employee.
- Actions: create on device, start enrollment, retry enrollment, re-enroll, disable on device.
- Show device user ID and last successful sync.
- Block duplicate enrollment commands while one is pending.

### 9.2 Attendance tab

- Realtime attendance list with date and employee filters.
- Show check-in, check-out, duration, source, and sync status.
- Show unresolved device users and failed events.
- Manual corrections require `attendance.manage` and are audited.

### 9.3 Settings → ZKTeco

Super-admin-only device card:

- Device identity and connection status.
- Driver state and virtual COM port.
- Last seen, last sync, clock drift, and pending outbox count.
- Attendance policy and background mode.
- Token rotation and revocation.
- Install/start/stop/remove Windows Service with explicit confirmation.
- Driver installation status and signed installer provenance.

## 10. Permissions

- `employees.manage`: create, update, enroll, re-enroll, and disable device users.
- `attendance.view`: view attendance reports and device events.
- `attendance.manage`: correct attendance and resolve raw events.
- `device.manage`: super-admin-only device settings, token, driver, and service controls.

Existing deny overrides remain authoritative.

## 11. Reliability and error handling

- Local outbox uses atomic replace plus flush before acknowledging an event.
- Retries use exponential backoff with jitter.
- The bridge reconnects automatically after USB removal, device reboot, network loss, or token expiry.
- A single named mutex prevents app-mode and service-mode from accessing the device simultaneously.
- Every command has a timeout and bounded retry count.
- UI states distinguish: driver missing, VCP missing, device disconnected, token invalid, enrollment pending/failed, sync delayed, and service unavailable.
- No event is deleted from the outbox until Supabase confirms durable storage.
- Reopening SUSHI ROLLS triggers an immediate pull/push sync.

## 12. Testing

### 12.1 Unit tests

- Attendance policy state machine.
- Duplicate event handling and payload hash stability.
- Timezone and workday boundaries.
- Outbox retry, compaction, and crash recovery.
- Command idempotency and timeout behavior.
- Permission checks and IPC validation.

### 12.2 Integration tests

- Fake ZKTeco SDK adapter for enrollment and attendance.
- Edge Function token verification, rate limiting, and payload validation.
- RLS policies for admin, manager, employee, and anonymous access.
- Electron main/preload IPC contract tests.

### 12.3 Hardware acceptance tests

1. The installed official SDK connects to LX15 through `Z_Connect_USB_STD` and reads device identity, or a verified official ZKTeco virtual COM port is present and `Connect_Com` succeeds.
2. Bridge connects with `Connect_Com` and reads LX15 identity.
3. Create a test employee from SUSHI ROLLS and enroll a real fingerprint.
4. Enrollment success appears in the UI without storing a template in Supabase.
5. Real check-in and check-out produce exactly one daily attendance row.
6. Duplicate replay produces no duplicate event or attendance row.
7. USB disconnect and reconnect preserve data and recover automatically.
8. Internet outage queues events locally and syncs on recovery.
9. App closed/logon-agent mode continues collecting events.
10. Windows Service mode starts before login and collects events.
11. Unknown device user is surfaced without corrupting attendance.
12. Driver/service removal returns the machine to a clean state.

### 12.4 Build verification

- `npm run typecheck`
- `npm test`
- `npm run build`
- x86 bridge compilation with `csc`
- Authenticode verification of the bundled signed driver installer
- NSIS package inspection for bridge, SDK DLLs, driver installer, and `asarUnpack`
- Packaged app smoke test with real LX15

## 13. Packaging

- Compile `ZkTecoBridge.exe` as x86.
- Bundle official ZKTeco SDK DLLs with documented provenance.
- Bundle the signed official driver installer; do not bundle a modified INF.
- Add bridge and SDK files to electron-builder `files` and `asarUnpack`.
- Provide an optional service-install action requiring UAC.
- Preserve the existing x64 NSIS application and publisher settings.
- Do not install or replace drivers automatically during normal app installation.

## 14. Milestones and gates

1. **USB transport gate**: prove PID `0A01` connects through `Z_Connect_USB_STD` with the installed libusb driver, or through a verified official ZKTeco virtual COM driver.
2. **SDK connection gate**: prove `Connect_Com`, device identity, create user, enrollment event, and attendance event.
3. **Local-first gate**: prove durable outbox, dedupe, reconnect, and catch-up.
4. **Supabase gate**: prove token auth, RLS, raw events, command queue, and attendance transaction.
5. **UI gate**: prove employee enrollment, attendance view, settings, and permissions in the packaged app.
6. **Background gate**: prove logon-agent and Windows Service modes with the app closed.
7. **Release gate**: all automated checks and hardware acceptance tests pass.

If the VCP driver gate fails, implementation stops at that gate. The team must obtain a documented ZKTeco driver for PID `0A01` or a documented x64 SDK path; it must not guess, patch a signed driver, or silently bind an incompatible driver.

## 15. Acceptance criteria

- An admin can create an employee in SUSHI ROLLS and complete fingerprint enrollment on LX15 without using another attendance application.
- The employee can check in and out with a fingerprint and the admin can see accurate times and duration.
- Events are not lost during app closure, USB disconnect, Windows restart, or internet outage.
- Replays do not duplicate attendance.
- Fingerprint templates are not present in Supabase or application logs.
- All device settings and service controls are restricted to authorized admins.
- The packaged Windows installer preserves existing SUSHI ROLLS functionality and includes verified ZKTeco binaries.
