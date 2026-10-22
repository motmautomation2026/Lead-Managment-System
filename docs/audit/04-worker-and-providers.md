# 04 — Worker and providers

Files: `Backend/src/worker.ts`, `services/automation.service.ts`, `services/proposalSending.service.ts`, `services/meetingScheduledNotification.service.ts`, `services/whatsapp-inbound.service.ts`, `services/meeting-calendar-sync.service.ts`, `services/connections.service.ts`, `providers/*`, `security/encryption.ts`.

---

## 1. Worker process (`worker.ts`)

### Startup (lines 185-196)
1. Logs the poll interval, batch size and dry-run flag.
2. `baileysRegistry.ensureManagersForAllActiveWorkspaces()`: starts one `BaileysManager` per active workspace (§3). A failure for one workspace is logged and skipped. A failure of the whole scan (for example the DB query) stops all managers, ends the pool and exits with `process.exit(1)`.
3. Calls `loop()`.

### Loop (174-183)
```
while (!stopped):
  await tick()            // errors logged: "[worker] Poll tick failed"
  if (tickCount++ % 6 === 0) await ensureManagersForAllActiveWorkspaces()   // on ticks 0, 6, 12, … (≈ every 60 s at the default 10 s interval)
  sleep(WORKER_POLL_INTERVAL_MS)   // default 10 000 ms, minimum 1 000
```
Shutdown on SIGTERM or SIGINT: sets `stopped`, `stopAll()` managers, `pool.end()`, `exit(0)`. It does **not** wait for an in-flight tick.

### `tick()` (122-163), step by step
1. **Claim due workflow actions.** `withTransaction(claimDueActions(client, WORKER_BATCH_SIZE))`:
   ```sql
   update scheduled_actions set status='executing', last_attempt_at=now()
   where id in (select id from scheduled_actions
                where (status in ('pending','due') and scheduled_for <= now())
                   or (status='executing' and last_attempt_at < now() - interval '15 minutes')
                order by scheduled_for asc limit $1
                for update skip locked)
   returning *
   ```
   For each claimed row, still inside the claim transaction, `buildContext` loads the run, lead, step, template and attachments, the channel contactability and the latest meeting, then computes **eligibility** (03-B §3.5). The claim commits before any sending happens.
2. Process every claimed action **concurrently** (`Promise.allSettled`). `processAction(ctx)`:
   - **Not eligible**: tx `skipAction(reason)`. The action becomes skipped or paused and the run advances.
   - **Internal action**: tx `executeInternalAction`. It re-checks the lifecycle and run status *inside* this tx, then executes and advances.
   - **Message action**: `dispatchMessage(ctx)` runs **outside any tx**, then tx `recordActionResult(success)`. On error:
     - `ProviderDeferredError` → tx `recordActionResult(deferred, retryAt = now + err.retryAfterMs)`.
     - `PermanentProviderError` → `failure`, not retryable.
     - any other error → `failure`, retryable.
   - Exceptions that escape `processAction` (for example a DB error inside `executeInternalAction`) are only logged. The action stays `executing` until the 15-minute reclaim, then it is re-run (see 07: possible infinite retry).
3. **Claim queued proposal WhatsApp sends**: tx `claimQueuedProposalWhatsappSends(batch)` sets `whatsapp_send_status='sending'` where status is `queued` and `whatsapp_next_attempt_at` is null or past, ordered by `created_at`, with SKIP LOCKED. Each is processed concurrently by `processQueuedProposalWhatsappSend`.
4. **Claim queued meeting WhatsApp notifications**: the same pattern on `meetings.notify_whatsapp_status`, processed by `processQueuedMeetingWhatsappSend`.

There is no reclaim for proposals or meetings stuck in `sending`.

### `dispatchMessage` (30-83)
1. `renderTemplate(template, lead, meeting?)`. It throws if `{{meeting.*}}` is used and the lead has no non-cancelled meeting. Unknown tokens produce a warning and are sent literally.
2. **Dry run** (`WORKER_DRY_RUN=true`): `console.log` of the action type, lead id, subject and body. It returns `{providerMessageId: "DRY_RUN"}`, so the run advances as if the send succeeded. This **only** applies to workflow scheduled actions. Queued proposal and meeting WhatsApp sends in steps 3–4 still call the real `sendWhatsApp`, and the API's inline emails are not affected by this flag at all.
3. **send_email**:
   - Subject = rendered subject, else the template name.
   - Every template attachment is downloaded from `template-attachments` and base64-encoded.
   - Calls `sendEmail(workspaceId, {to: lead.email, subject, html: body, attachments})`.
4. **send_whatsapp**:
   - Requires `phone_e164` (else `PermanentProviderError`).
   - Body = `htmlToWhatsAppText(rendered.body)`.
   - Only the first template attachment is used.
   - Calls `sendWhatsApp(workspaceId, {source: {type:"scheduled_action", id}, to, body, attachment})`.

### Retry, backoff and deferral values

| Situation | Behaviour |
|---|---|
| Workflow action failure, retryable | `attempt_count+1`. If below `max_attempts` (default 3): `scheduled_for = now + min(15·2^(attempt-1), 240) min`. With 3 attempts the waits are **15 min, then 30 min, then fail**. |
| Workflow action failure, final or permanent | action `failed`, run `failed` (`last_error`) |
| Workflow action deferred | back to `pending` at `now + retryAfterMs`; **does not consume an attempt**, so it can defer indefinitely |
| Stuck `executing` | reclaimed after 15 min (`last_attempt_at`) |
| Proposal and meeting WhatsApp deferred | attempt+1. At 5 attempts (`MAX_WHATSAPP_ATTEMPTS`) the status becomes failed ("Gave up after N attempts"). Otherwise back to `queued` with `next_attempt_at = now + retryAfterMs`. |
| Proposal and meeting WhatsApp: any other error | `failed` immediately |
| `ProviderDeferredError` default `retryAfterMs` | 60 000. WhatsApp restriction and daily-cap deferrals use 300 000. |

---

## 2. Email (`providers/email.provider.ts`, `services/connections.service.ts`)

`sendEmail(workspaceId, {to, subject, html, attachments?}, {allowDisabled?})` (50-100):
1. `loadEmailConnection(ws)`: the row `integration_connections(ws,'email')` and its decrypted secrets.
2. If `row.provider` is set and `!row.enabled` (and `allowDisabled` is false): `ProviderDeferredError("Email sending is disabled for this workspace.")`.
3. **No provider saved** (`row.provider` null), the legacy fallback: it needs `process.env.RESEND_API_KEY` **and** `SMTP_FROM_ADDRESS` (name from `SMTP_FROM_NAME`, default "MOTM Technologies"). Without them: `ProviderDeferredError("Email connection is not configured.")`. Otherwise it sends via Resend. The `enabled` flag is ignored on this path.
4. **Resend** (`sendViaResend`): `POST https://api.resend.com/emails` with `from: "Name <addr>"`, `to`, `subject`, `html`, `attachments: [{filename, content(base64)}]`.
   - Non-OK or missing `id`: a 4xx other than 429 is a `PermanentProviderError`; anything else is an `Error` (retryable).
   - There is no fetch timeout.
   - A missing key in the database gives `ProviderDeferredError("Resend is not fully configured.")`.
5. **SMTP** (nodemailer):
   - Requires host, port, username and password (else deferred).
   - `secure = (smtpSecurity === "tls")`, `requireTLS = !secure` (STARTTLS), `tls.minVersion TLSv1.2`.
   - A new transporter is created for every send (no pooling, default timeouts).
   - SMTP response code ≥ 500 is a `PermanentProviderError`; other errors are retryable.

Who sends email:

| Sender | Process | Notes |
|---|---|---|
| Workflow send_email steps | worker | through the retry machinery |
| Proposal email | **API, inline in `POST /proposals`** | failure is marked `email_send_status='failed'` (deferred also counts as failed) |
| Meeting-scheduled email | **API, inline in `POST /meetings`** | failure is marked `notify_email_status='failed'` |
| Connection test | API, `POST /connections/email/test` | `allowDisabled: true` |

Under `compose.yaml` the `backend` service is not given `RESEND_API_KEY` / `SMTP_FROM_*`, so the API-side sends cannot use the env fallback (01 §3).

---

## 3. WhatsApp (Baileys)

### 3.1 Registry (`providers/baileys-registry.ts`)
- `managers: Map<workspaceId, BaileysManager>` and `starting: Map<workspaceId, Promise>`.
- `getOrCreateManager(ws)`: returns an existing manager, or the in-flight start promise, or creates `new BaileysManager(ws)` and awaits `start()`, then stores it. If `start()` rejects, the rejected promise **stays in `starting`**. Both `ensureManagers…` and later `getOrCreateManager` calls then skip or reuse the failure, so that workspace never recovers until the worker restarts (see 07).
- `ensureManagersForAllActiveWorkspaces()`: `select id from workspaces where is_active`. Starts a manager for each workspace that has neither a running nor a starting entry. Managers for deactivated workspaces are never stopped.
- `stopAll()`.
- `sendWhatsApp(ws, input)` (`whatsapp.provider.ts`) = `(await getOrCreateManager(ws)).sendAction(...)`.

### 3.2 `BaileysManager` (`providers/baileys.manager.ts`)

**Session lock.** `start()` (106-127):
- Checks out a **dedicated pool client** and runs `pg_try_advisory_lock(hashtextextended(workspaceId, 1))` (salt 1).
- If the lock is not acquired, the client is released and start throws "Another automation worker already owns this workspace's WhatsApp session".
- The client is held for the life of the manager. Pool max is 10, so each active workspace permanently consumes one pool connection.
- Then runs `syncControl()` once and every **10 s**.

**Control plane: `syncControl()` (144-161)**
1. Reads `whatsapp_connection` for the workspace (assumes the row exists) and writes `worker_heartbeat_at = now()`.
2. A new command is detected when `command_version` differs from the last seen value; the initial value is "-1".
3. `desired_state = 'disconnected'`: if a socket exists or a new command arrived, it calls `logout()`. That logs out the socket, **clears the auth state**, and sets status disconnected, clearing the JID, phone, name, locks and QR.
4. `desired_state = 'restart'` with a new command: sets the DB to `desired_state='connected', status='connecting'`, closes the socket, then opens a new one.
5. Otherwise, if there is no socket and no reconnect pending: `openSocket()`.

**Socket (`openSocketUnguarded`, 173-223)**
- Sets status `connecting`.
- Loads the encrypted auth state.
- `makeWASocket` options: `browser ["Northbeam CRM","Chrome","1.0.0"]`, no history sync, `markOnlineOnConnect: false`. It ignores groups, broadcast, status and newsletter JIDs.
- `getMessage` retry handler: decrypts the stored outbound payload for that `message_id` and JID.
- Event handlers:
  - `creds.update` → persist creds, serialised through a promise chain.
  - `connection.update` → `handleConnectionUpdate`.
  - `messages.upsert` → `processInboundUpsert(ws, event)`.

**`handleConnectionUpdate` (225-269)**
- `qr`: encrypted (AAD `"whatsapp:pairing-qr"`) and stored with `qr_expires_at = now + 90 s`, status `qr_ready`. A timer at 91 s clears an expired QR and returns the status to `connecting`.
- `reachoutTimeLock`: stored as JSON.
- `open`: status connected, `connected_jid`, `connected_phone`, `display_name`, `last_connected_at`, QR cleared. Then `fetchNewChatMessageCap()` and the result is stored.
- `close`:
  - If the close was intentional, nothing happens.
  - On a **terminal** code (loggedOut, connectionReplaced, badSession, forbidden, multideviceMismatch): clear the auth state; status `reauth_required`, `desired_state disconnected`.
  - Otherwise: status `reconnecting` and `scheduleReconnect` (immediate for `restartRequired`; otherwise backoff `min(1000·2^attempt, 300 000) ms × (0.75–1.25 jitter)`).

**Outbound: `sendAction` → `performSend` (333-516)**

Sends are serialised per workspace through a promise chain (`sendTail`). `performSend` runs these steps:
1. If not connected: `ProviderDeferredError("WhatsApp is disconnected or awaiting QR pairing.")`.
2. **Prepare (tx)**:
   - `insert whatsapp_outbound_messages(workspace_id, <source column>, message_id = generateMessageIDV2(), remote_jid) on conflict (<source column>) do nothing`, so each source has exactly one row (idempotency key).
   - Stores an encrypted text-only retry payload (AAD `whatsapp:outbound:<message_id>`).
   - If the stored `remote_jid` differs from the current one: `PermanentProviderError` ("lead phone changed").
3. **Claim (tx)**, after `pg_advisory_xact_lock(hashtextextended(phoneE164, 0))` (salt 0, per phone):
   - Locks `whatsapp_connection … for update`.
   - `!enabled` → deferred ("emergency switch").
   - Status not connected → deferred.
   - Fetches live `fetchAccountReachoutTimelock()` and `fetchNewChatMessageCap()` (falling back to the stored values) and stores them. If `isOutboundRestricted` (reachout `isActive`, cap `CAPPED`, or OTE `EXHAUSTED`): deferred **5 min**.
   - **Eligibility recheck:**
     - `scheduled_action` source: the action is still `executing`, the lead is `active`, automation is not manual/paused/stopped, and the run is running/waiting (`FOR UPDATE of a,l,r`).
     - any other source: queries **`public.proposals`** with `whatsapp_send_status='sending'` and lead lifecycle ≠ DNC. This branch is also used for `meeting` sources, so meeting notifications never match (see 07).
     - In all cases the returned `phone_e164` must equal the target, else `PermanentProviderError("no longer eligible")`.
   - **Daily cap**: count of `sent` outbound rows in the workspace since IST midnight ≥ `daily_cap` → deferred **5 min**.
   - If this source's row is already `sent`, return `alreadySent` (idempotent).
   - `socket.onWhatsApp(number)`: if the number is not registered, the outbound row becomes `failed`, the lead's WhatsApp contactability is upserted to `invalid` ("Number is not registered on WhatsApp"; uses `scheduled_actions` or `proposals` to find the lead), and the send throws `PermanentProviderError`.
   - **Spacing**: wait = random(`min_delay_seconds`, `max_delay_seconds`) minus time since the workspace's last `sent` message (defaults 5–15 s). The row lock is released before sleeping.
4. Sleep for the spacing wait, then **re-check** `enabled` and the connection status (either one failing → deferred).
5. Attachment: download from its bucket. `image/*` is sent as `{image, caption}`; anything else as `{document, fileName, mimetype, caption}`.
6. **Send (tx)**: `socket.sendMessage(jid, content, {messageId})`. Then UPDATE the outbound row to `sent` with the encrypted real payload and `sent_at`, and return `{providerMessageId: messageId}`. Note the DB transaction stays open across the network send.

**Caps and settings**
- `daily_cap` default 200 (editable 1–10 000 through the API).
- Spacing 5–15 s (DB defaults; **no API exists to change them**).
- The IST day boundary is used for the cap.
- The emergency switch is `whatsapp_connection.enabled` (default false).

### 3.3 Inbound (`services/whatsapp-inbound.service.ts`)

`processInboundUpsert(ws, event)`. It runs only for `type === "notify"` with no `requestId`. For each message, it skips anything without an id, without a direct `@s.whatsapp.net` JID (`remoteJid` or `remoteJidAlt`), sent by us (`fromMe`), or with no content. For the rest, in one tx:
1. `pg_advisory_xact_lock(hashtextextended(phone, 0))`.
2. Insert `whatsapp_inbound_events(ws, message_id, sender_jid, sender_phone_e164, message_type = getContentType(), received_at, disposition 'unmatched') on conflict (message_id) do nothing`. A duplicate is skipped.
3. Match leads: `phone_e164 = phone and workspace_id = ws and lifecycle_state = 'active' and merged_into_lead_id is null for update`.
4. Disposition: 0 matches → unmatched; 1 → matched; more → ambiguous. `match_count` is updated.
5. **For each matched lead (reply stops automation):**
   - Lead `response_state='responded'`, `automation_mode='manual'`, `last_activity_at`.
   - All running/waiting/paused runs are cancelled (reason "Inbound WhatsApp reply").
   - Actions pending/due/paused/**executing** are cancelled.
   - WhatsApp contactability is upserted to `reachable`.
   - TL "WhatsApp reply received - automation stopped" (SYSTEM; metadata `{messageId, messageType, duplicatePhoneMatch}`).
   - A notification to the lead owner, if there is one.
6. If there were several matches: `admin_audit_events('system@whatsapp.local', 'whatsapp.inbound_ambiguous', 'phone', phone, …)`.

**No message body is stored**; only the type and metadata. Unmatched and ambiguous events appear in Settings → WhatsApp (last 20). There is no inbound **email** handling at all.

---

## 4. Google Calendar

### 4.1 OAuth flow
1. The UI calls `POST /connections/google-calendar/oauth/start` (salesperson, workspace).
   - `oauthConfig` = the workspace's own client (`client_id` + decrypted secret + `redirect_uri`) if all three are saved, else the platform env client. Neither gives 400.
   - `state = randomBytes(24).hex`, stored on the workspace's row with a 10-minute expiry and `updated_by` = actor.
   - Returns `{url}`, generated with `access_type=offline`, `prompt=consent`, scopes `calendar.events` + `userinfo.email`. The browser navigates there (`window.location.href`).
2. Google redirects to `GET /api/v1/connections/google-calendar/oauth/callback?code&state` (unauthenticated).
   - A missing code or state, or an `error` parameter, redirects to `${corsOrigins[0]}/admin?calendar=error&message=…`.
   - Otherwise `completeGoogleCalendarOAuth`:
     - Finds the workspace whose `pending_oauth_state = state` (state is unique per row and not bound to the browser).
     - Checks expiry. Exchanges the code with `getToken`.
     - Requires a `refresh_token` and a granted `calendar.events` scope (else a `CalendarSyncError` with a user-facing message).
     - Looks up the email through userinfo (non-fatal).
     - Stores the encrypted refresh token, sets status connected and enabled, clears the state, and writes audit `connection.google_calendar.connected` attributed to `updated_by`.
     - On failure: status `error`, `last_error`, state cleared, audit `connect_failed`.
   - Redirects to `/admin?calendar=connected` or `…error&message=…`.
3. The frontend AuthGate sees a salesperson on `/admin?calendar=…` and does `window.location.replace('/settings' + search)`. The Settings Google panel reads the query, shows a toast, and strips it (`workspace-settings-page.tsx:531-543`).

### 4.2 Event sync (`services/meeting-calendar-sync.service.ts`), all best-effort and called after the meeting transaction commits

| Function | When | Behaviour |
|---|---|---|
| `syncMeetingCreated(id)` | `POST /meetings` | If the connection is not `connected` or there is no token or config: `calendar_sync_status='not_applicable'`. Otherwise `events.insert` on `connected_calendar_id` (default `primary`) with `sendUpdates:"all"`, `conferenceDataVersion:1`, a `hangoutsMeet` create request (Meet link), start/end = meeting time + duration with timeZone `Asia/Kolkata`, attendees = lead email (if any) + participants, description "Meeting with <company> via Northbeam CRM." Stores `calendar_event_id`, `meet_link` (`hangoutLink`) and status `synced`. On error: `failed` + message, and if `invalid_grant`, `markGoogleCalendarReauthRequired`. |
| `syncMeetingRescheduled(id)` | PATCH with `at`, `title` or `durationMin` (and status not cancelled) | Only if an event exists and the connection is connected: `events.patch` (summary, start, end; `sendUpdates:"all"`). 404/410 is ignored. Success → `synced`; error → `failed` (+ reauth flag). Participants are not updated. |
| `syncMeetingCancelled(id)` | PATCH with `status: cancelled` | `events.delete` (`sendUpdates:"all"`). 404/410 is ignored. An error only sets `calendar_sync_error`. |

Calendar is never synced for no_show, failed or completed, and never for meetings created while disconnected.

### 4.3 Meeting-scheduled notifications (`services/meetingScheduledNotification.service.ts`)
- `notifyMeetingScheduled(id)` is called by the route after calendar sync.
  - Email: if the lead has an email, `sendMeetingEmailNow` runs **inline**. The template is `getDefaultTemplate("email")` = **any** template in the database with `is_default_meeting_scheduled_email = true and is_active` (**not filtered by workspace**). No template → `skipped` with a message. It renders with the meeting (link = Meet link, else URL) and calls `sendEmail`. Success → `sent`; any error → `failed`.
  - WhatsApp: `notify_whatsapp_status` = `queued` if the lead has `phone_e164`, else `skipped`.
  - Statements outside the inner try can throw, which turns `POST /meetings` into a 500 after the meeting is saved.
- Worker `processQueuedMeetingWhatsappSend`:
  - DNC or no phone → failed.
  - No default WhatsApp template (same unscoped lookup) → failed.
  - Render, convert with `htmlToWhatsAppText`, then `sendWhatsApp(source {type:"meeting"})`. Because of the eligibility query bug in §3.2, this always ends in `PermanentProviderError` → `failed`.

### 4.4 Proposal WhatsApp (`processQueuedProposalWhatsappSend`)
- DNC or no phone → failed.
- Re-reads the WhatsApp template (same ws, channel, active).
- Renders with no meeting and converts.
- `sendWhatsApp(source {type:"proposal"}, attachment = proposal document from `proposal-documents`)`.
- Success → `sent`, then `tryAdvanceToSent` (proposal `sent` → stage `proposal_decision_pending`, follow-up task, autoEnroll `proposal_pending`).
- Deferred → requeue (max 5 attempts). Other errors → failed.

---

## 5. Encryption (`security/encryption.ts`)

- Algorithm: **AES-256-GCM**, a random 12-byte IV per encryption, a 16-byte auth tag, and **AAD** bound to a purpose string.
- Key: `Buffer.from(INTEGRATION_ENCRYPTION_KEY, "base64")`, validated as 32 bytes at startup. `KEY_VERSION = 1` is constant; decrypting any other version throws. There is no rotation tooling.
- Storage: the ciphertext, iv and tag are stored as separate `bytea` columns, plus a `key_version` int.

What is encrypted, and with which AAD:

| Data | Table/columns | AAD |
|---|---|---|
| Email secrets JSON `{resendApiKey, smtpUsername, smtpPassword}` | `integration_connections.secret_*` | `"integration:email"` |
| Google OAuth client secret | `google_calendar_connection.client_secret_*` | `"integration:google_calendar:client_secret"` |
| Google refresh token | `google_calendar_connection.refresh_token_*` | `"integration:google_calendar:refresh_token"` |
| WhatsApp pairing QR | `whatsapp_connection.qr_*` | `"whatsapp:pairing-qr"` |
| Baileys creds JSON (BufferJSON) | `whatsapp_auth_credentials` | `"whatsapp:auth:creds"` |
| Baileys Signal keys | `whatsapp_auth_keys` | `"whatsapp:auth:key:<type>:<id>"` |
| Outbound WhatsApp message payload (for retry receipts) | `whatsapp_outbound_messages.payload_*` | `"whatsapp:outbound:<message_id>"` |

- The AAD strings are deliberately **not** workspace-namespaced, to stay compatible with pre-workspace rows (comments at `baileys-auth.store.ts:39-47`, `connections.service.ts:48-52`). Isolation therefore relies only on the SQL `where workspace_id` filters. A ciphertext copied into another workspace's row would still decrypt.
- Not encrypted: SMTP host, port, sender, Google `client_id`, `redirect_uri`, connected email, and the JID and phone.
