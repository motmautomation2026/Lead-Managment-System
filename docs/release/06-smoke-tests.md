# 06 — Smoke tests (15 minutes, production, right after step 9)

Do them in this order, in a normal browser window. Each line has a ✅ check. **Any ✗ → stop and pull the kill switch
(07) if anything was sent, otherwise write down what failed and stop before step 10.**

| # | Do | ✅ OK when |
|---|---|---|
| 1 | Log in as an **admin**. | Home loads, "My day" shows numbers, no red error banner. |
| 2 | Log in as a **salesperson** in another browser (private window). | Home loads; Settings shows only the rep sections. |
| 3 | Admin: open **Settings → All workspaces** (super-admin) or **Settings → Team**. | Each user is in the right workspace with the right role (migration 055 copied today's access). |
| 4 | Open an **existing** contact. | The page opens; the right rail **Automation** card says "Off — contact from before go-live" (Automation section). |
| 5 | On that old contact: **Log call → Not connected → No answer**. | The call shows in Activity. **No** "Call attempt 2" task and **no** "We tried calling" WhatsApp (old lead). |
| 6 | Create a task on that old contact by hand, due in 2 minutes. | The task shows. Within ~3 minutes the rep gets the "Due now" bell (a rep's own tasks still remind on old leads). |
| 7 | **Home**. | The new task appears; nothing else new for old contacts. |
| 8 | **Settings → WhatsApp**: each number connected. | Status *Connected*, **one** worker shown, safety numbers as before (spacing 45–120 s, daily cap, new chats 20/day, window Mon–Sat 09:30–19:00). If a number asks for a new QR: stop (the encryption key or the worker is wrong; see 07). |
| 9 | **Settings → Email**: *Test SMTP login*, *Test IMAP login*, *Send test email to me*. | All three green; the test email arrives in your inbox. |
| 10 | Open `https://<api>/health/worker` in the browser. | `{"status":"ok","stale":[]}` (HTTP 200). |
| 11 | Create a **new** contact with your own phone + email (name it "Test – Govinda"). | Automation card: "On — new contact (since go-live …)"; a **First call** task + "New lead assigned" bell. |
| 12 | Pick one old contact you own: **Automation → switch on → confirm**. | Card says "On since <today> by <you>"; Activity shows "Automation switched on". Within 15 minutes, if it had no open task, exactly **one** "Decide the next step" task appears. No old reminders or escalations. |
| 13 | Switch it **off** again (or leave it on if it should be worked). | Card "Off since … by …"; its workflow runs (if any) show *Paused* under Automations → Runs. |
| 14 | Run the 05 **PART B** blocks again. | B2 is still all zeros. |
| 15 | AI test message (after step 13 of the runbook): on "Test – Govinda" with Live scope = test contacts. | One AI WhatsApp and one AI email arrive on your phone / inbox within the send window; they read right (no "!", ≤ 60 / 120 words, your name in the signature, "Reply STOP to opt out." on the first WhatsApp). |
