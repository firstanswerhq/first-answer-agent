# First Answer Agent

**An AI front desk for any small business: answers web inquiries, checks a demo calendar, books appointments and hands tricky cases to a person. Runs on Vultr.**

Built for **Vultr Agent Rush (lablab.ai), Challenge 2: Powering the Future of Work** (sales operations and customer support). Everything specific to one kind of business lives in one **business profile** file. Three example businesses ship (a dental office, a hair salon and a tax and bookkeeping office), and you add your own with one file. A dental office is the default demo, and a **Switch business** control in the dashboard header shows the other two in one click.

**Live demo (real Vultr VM and real Vultr Serverless Inference):**

* App: <https://155-138-206-164.sslip.io>
* Health check (shows `mode`, `model` and `modelVerified`): <https://155-138-206-164.sslip.io/api/health>
* Customer contact form: <https://155-138-206-164.sslip.io/lead>, for the other example businesses <https://155-138-206-164.sslip.io/lead?profile=salon> and <https://155-138-206-164.sslip.io/lead?profile=accounting>

Demo data is fictional and no text or email is ever sent. Please use made-up details in the form.

> Disclosure: this repository was built during Vultr Agent Rush (Nov 3-8, 2026). It is new, original work started for this event. The initial layers were committed together; later changes are individual commits.

## Real vs simulated

| Part | Status |
| --- | --- |
| Vultr Cloud Compute VM (`vc2-1c-2gb`, Atlanta, Ubuntu 24.04) running the app | **Real.** Live at <https://155-138-206-164.sslip.io> (HTTPS through Caddy and Let's Encrypt). |
| Vultr Serverless Inference model calls with tool calling (model `glm-5.3-flash`) | **Real.** The live app's `/api/health` shows `modelVerified: true`, which is set only after a real test call to the model succeeds. The test suite itself uses mocked and local OpenAI-compatible servers. |
| Safety checks in code (input validation, approved prices, business hours, double booking, handoff rules, instruction-in-message screening) | **Real**, run on every message |
| Booking rules (business hours, 2 hours notice, no double booking) | **Real rules** on the app's demo calendar |
| Saved state (inquiries, bookings, follow-up timers, one JSON file with safe writes) | **Real** |
| Follow-up timers | **Real** timers (shortened for the demo: 30 minutes becomes 30 seconds) |
| Texts and emails to customers | **Simulated.** Nothing is texted or emailed to a customer; replies appear on the web page only. |
| Handoff to a person | **Real phone alert plus dashboard status.** When an inquiry is handed to a person, the app sends a push notification to the owner's phone through [ntfy](https://ntfy.sh) (only if `NTFY_TOPIC` is set; see the environment table) and marks the inquiry "Needs a Human" in the dashboard. The alert carries the business name, the customer's first name and a fixed category such as "Angry customer" built in code, never a phone number or any message text. |
| Intake channels | The **website form is the only real intake channel.** Inquiries shown as "Text message" or "Phone call" are simulated examples and carry a "simulated source" tag in the dashboard. |
| Customers and sample inquiries | **Simulated** (fictional names, 555 numbers) |
| The calendar | **Demo calendar by default.** Unless you connect one (see the section below on connecting one), it is the app's own calendar. An optional **read-only** Google Calendar feed can make one business's real busy times block slots; the app never writes to it. The Calendar page, the agent's timeline and `/api/health` always say which calendar was used. Customers can download a calendar file or open a Google Calendar link for a booked demo appointment; that is a sample event in their own calendar, not a booking in any system. |

If the AI model is not connected, cannot be reached or has reached its hourly limit, the app switches to **backup mode**: built-in rules that follow the same steps and use the same safety checks. The header badge and `/api/health` say which mode is active. The badge shows a model name only while the AI model is really answering, and `/api/health` reports `modelVerified: true` only after a real test call to the model succeeded.

## Why it matters

For a small business, the first one to answer usually gets the booking. Owners and front-desk staff are with a customer, on the phone or closed for the night. First Answer Agent gives every new inquiry a useful, honest first reply, asks the one question it needs, offers open times from the demo calendar, and sends anything risky straight to a person. The dashboard shows how long each reply actually took and whether the AI model or the built-in rules wrote it.

## What you can see in the app

New inquiries (leads) come in from the contact form, a text or a call; the dashboard calls them inquiries.

| Screen | What it shows |
| --- | --- |
| **Switch business** (header) | Reloads the whole app as the dental office, the hair salon or the tax office: name, colors, services, hours, example inquiries and sample data all change. |
| **Live Inbox** | Every inquiry with service, source, reply time and status (New, Replied, Booked, Needs a person). "Simulate a new inquiry" runs one of the business's fictional scenarios from start to finish; "Reset demo" reloads the sample data. |
| **Inquiry detail** | The conversation, a box to type as the customer, and **"What the assistant did"**: a step-by-step list of every action with its details and timing. |
| **Calendar** | A week view of bookings and open appointment times from the app's own calendar, or, when a Google Calendar is connected (read-only), with its busy blocks shown as "Busy (Google Calendar)" without titles. |
| **Results** | Typical reply time (median) of live replies, how many came from the AI model and how many from built-in rules, inquiries answered, appointments booked, and inquiries that need a person. The fictional sample day is excluded by default and labeled when shown. |
| **Guardrails** | The rules the software enforces for the active business: hours, approved prices, topics that always go to a person, urgent handling. |
| **Contact form** (`/lead`) | A public customer form. The customer watches the assistant reply on the page. `/lead?profile=salon` opens it for another example business. |

## Screenshots

Taken on the live deployment (<https://155-138-206-164.sslip.io>) with the real AI model answering. All customers are fictional; messages are simulated. Files are in [`docs/screenshots/`](docs/screenshots/).

**1. Live Inbox (dental office).** Inquiries from different sources with the reply time of each, status, and an "AI model · glm-5.3-flash" badge. The top rows are live test inquiries (one is a prompt-injection attempt that was handed to a person); rows marked "(simulated)" are the fictional sample day.

![Live Inbox for the dental office](docs/screenshots/01-dental-inbox.jpg)

**2. Inquiry detail with "What the assistant did".** A price question answered by the AI model: the reply quotes the approved $110-$190 range and offers open times from the calendar, and the right-hand panel lists each step (model chosen, `qualify_lead`, `check_calendar`) with timing.

![Inquiry detail with the step list](docs/screenshots/02-dental-inquiry-detail.jpg)

**3. Calendar.** One week of booked and open appointment times from the app's own calendar, including "too soon", closed and not-bookable slots.

![Calendar for the dental office](docs/screenshots/03-dental-calendar.jpg)

**4. Results.** Median reply time of live replies with the AI model and built-in rules shown separately, plus a reply time bar per inquiry. Numbers are from a frozen snapshot, discussed under "Measured on the live deployment".

![Results screen](docs/screenshots/04-dental-results.jpg)

**5. Guardrails.** The rules enforced in code for this business: what the assistant is blocked from doing, what always goes to a person, and the approved price ranges.

![Guardrails screen](docs/screenshots/05-dental-guardrails.jpg)

**6. Customer contact form (`/lead`).** The public form a customer fills in; it says up front that the assistant is an AI and that this is a demo.

![Customer contact form](docs/screenshots/06-dental-contact-form.jpg)

**7. Switch business: hair salon inbox.** The same app after switching to Willow & Oak Hair Studio: new name, accent color, services and sample inquiries.

![Live Inbox for the hair salon](docs/screenshots/07-salon-inbox.jpg)

**8. Salon calendar.** The salon's own hours and 2-hour appointments.

![Calendar for the hair salon](docs/screenshots/08-salon-calendar.jpg)

**9. Switch business: tax and bookkeeping inbox.** Cedar Ridge Tax & Bookkeeping, a third business from one profile file.

![Live Inbox for the tax office](docs/screenshots/09-accounting-inbox.jpg)

**10. Phone layout: inbox.** The dashboard on a phone, with bottom navigation.

![Inbox on a phone](docs/screenshots/10-mobile-inbox.jpg)

**11. Phone layout: contact form for the salon (`/lead?profile=salon`).**

![Salon contact form on a phone](docs/screenshots/11-mobile-contact-form-salon.jpg)

## Measured on the live deployment

Frozen snapshot from the Results screen of the live app: **Nov 4, 2026, about 10:25 AM Central**, dental office, live replies only, sample data excluded (screenshot 4).

* **Typical reply time (median): 7.0 s over 9 live replies.**
* AI model: 6.5 s (7 replies). Built-in rules: 7.9 s (2 replies); these include the time spent asking the model first, so backup mode is not instant.
* 9 of 9 inquiries answered; 2 booked (22%); 3 needed a person (33%).
* This is a small sample. The live dashboard keeps changing as visitors try it, so the numbers you see there will differ. Reply time is measured from the inquiry arriving to the first reply.

What the agent did on the live model for a price question (screenshot 2): the customer asked how much a cleaning and checkup costs for an adult who pays out of pocket. The AI model called `qualify_lead`, then `check_calendar` (4 open windows found), and wrote a reply that quoted the approved range ($110-$190 for a cleaning and checkup) and offered open times from the demo calendar (Wed Nov 4 at 2:00 PM, Thu Nov 5 at 9:00, 10:00 or 11:00 AM). The reply was a simulated send.

## Make it yours

Everything that depends on the kind of business is in `config/profiles/<name>.json`: business name, the assistant's signature name, phone, time zone, accent color, hours and appointment length, an optional service area, the list of services with price ranges (or "quote required"), urgent-situation phrases, topics that always go to a person, out-of-scope services, form wording, an optional street `address` (used as the location in the customer's calendar file), and the example scenarios and sample inquiries.

1. Copy a profile: `cp config/profiles/dental.json config/profiles/myshop.json`
2. Edit it (the file is checked at startup, and a mistake gets a clear error message).
3. Run with `BUSINESS_PROFILE=myshop npm start` (or set `BUSINESS_PROFILE=myshop` in the env file on the VM; `deploy/cloud-init.sh` has a variable for it).

The assistant's instructions, the built-in rules, the qualifying step, the safety checks, the calendar, the screen wording and the demo data all read from the profile. It is built to be configurable; a service-area option exists but none of the shipped profiles uses it. Shipped profiles:

| Profile | Business | Appointment | Urgent handling example |
| --- | --- | --- | --- |
| `dental` (default) | Brightwater Family Dental | 1 hour | knocked-out tooth, severe pain, facial swelling |
| `salon` | Willow & Oak Hair Studio | 2 hours | burning scalp or swelling after a color service |
| `accounting` | Cedar Ridge Tax & Bookkeeping | 1 hour | IRS levy or audit notice, deadline due now |

**`facts` (optional).** A small block with `parking`, `walkIns` and `duration` (how long a standard visit takes). The assistant answers a question about one of those only from this text, and answers hours and open or closed days from `hours`. Anything else a customer asks about the business (address, holiday hours, payment methods, a specific insurance plan) is never guessed: the reply says a teammate will confirm, and the lead gets a low-priority "teammate to confirm" note (no phone alert). The facts text shipped in the three example profiles is **sample content** for fictional businesses (for example, the parking and visit-length lines); replace it with your real details, and remove a key to make the assistant say a teammate will confirm instead. An `alwaysHuman` topic can also carry a `reply`, the sentence sent to the customer when that topic hands off (it should say why).

All business names, people and phone numbers are fictional. The three businesses have different urgent situations, different topics that always go to a person, and different out-of-scope services; that difference is the point of the profile.

**Switch business and public deploys.** The switcher offers only the shipped profiles (plus the deployment's own profile). Each business has its own state file, inquiries, bookings, follow-up timers, sample day and reset, so one visitor's actions in one business never show in another. The profile is chosen from a fixed list: no file name or path ever comes from a request. The AI model budget is shared across businesses, so switching cannot multiply it. Set `PROFILE_SWITCHER=0` to turn the control off.

## Architecture

In plain terms: a message comes in, the assistant decides what to do, and software checks every action before it happens.

```mermaid
flowchart LR
  C[Customer or website form] -->|POST /api/leads| API
  subgraph VM["Vultr Cloud Compute VM (Ubuntu 24.04): the control layer"]
    P[(Business profile JSON)] --> A
    API[Express API and dashboard] --> Q[Per-inquiry run queue]
    Q --> A[Assistant loop]
    A --> G[Checks in code: validation, approved prices, hours, safety]
    G --> F[6 actions]
    F --> S[(State: inquiries, bookings, follow-ups, JSON file with safe writes)]
    T[Follow-up timer, 1 s tick] --> S
    T --> A
    API --> D[Dashboard: Inbox, Detail, Calendar, Results]
  end
  A <-->|OpenAI-compatible tool calls| V[Vultr Serverless Inference]
  A -. no key, hourly limit reached or call fails .-> R[Built-in rules, same actions and checks]
  GH[GitHub repo] -->|systemd timer: git pull every 2 min, optional| VM
```

### Vultr services used

* **Vultr Cloud Compute VM** (`vc2-1c-2gb`, Atlanta, Ubuntu 24.04) is the control layer. It runs the Express API, the dashboard, the calendar and booking store, the follow-up timers, the safety checks and the assistant loop. It is set up by one startup script ([`deploy/cloud-init.sh`](deploy/cloud-init.sh)).
* **Vultr Serverless Inference** (OpenAI-compatible, `https://api.vultrinference.com/v1`) is the assistant's reasoning engine. The app sends chat requests with action definitions and runs the actions the model returns. Default model: `glm-5.3-flash` (change it with `VULTR_INFERENCE_MODEL`).

Serverless Inference is optional for this challenge, but it is the primary path. The VM works on its own: with no AI key the same app runs in backup mode.

## The assistant: how it executes real tasks

Every inquiry is handled by a tool-calling loop. The model never touches saved data directly; it can only call six functions, and every call is validated and checked in code.

| Function | What it really does |
| --- | --- |
| `qualify_lead` | Records which of the business's services the customer wants, how urgent it is (and where, if the business has a service area). **Code** decides service-area status and returns the only price range the assistant may quote, taken from the profile. |
| `check_calendar` | Returns open appointment times from the calendar (business hours only, 2 hours notice, no taken times). |
| `book_appointment` | Writes a booking. Refuses double booking (a synchronous check and write), times outside business hours or in the past, out-of-scope or out-of-area requests, and inquiries already flagged for a person. |
| `send_reply` | Writes the outgoing message into the conversation. **Simulated send**: no text or email is sent to the customer; the reply shows on the web page. Passes the outgoing-message check first. |
| `schedule_followup` | A real timer in the app. If the customer has not replied when it is due, the follow-up is posted; if they replied, booked or were handed to a person, it is cancelled. |
| `escalate_to_human` | Flags the inquiry as needing a person with a reason and priority, cancels timers, and sends the owner a phone alert (one per inquiry, at most 3 an hour per visitor and 20 an hour in total, counted per process; never for demo-scenario buttons; only when `NTFY_TOPIC` is set). The timeline records "Alert sent to the owner's phone" only when the alert really went out. |

Fast path: an angry customer, an urgent non-medical situation (for example a knocked-out tooth or a burst pipe, as the profile defines it) or a message that tries to give the assistant instructions never waits for the AI model. Code sends a safe holding reply at once, hands the inquiry to a person and sends the phone alert; the timeline says "Checked in code, handed to a person". Possible medical emergencies keep their fixed 911 (or 988) reply, also sent by code. Normal inquiries use the model.

Cost: each inquiry typically uses about 12,000 to 15,000 input tokens, because the system prompt and the action definitions are sent again on every model call (several calls per inquiry). That is a small fraction of a dollar at list prices (see the deck's assumptions).

Reliability and cost control: runs for the same inquiry never overlap, a cap on concurrent runs, a step cap per inquiry (default 8), a per-call timeout (default 20 s), one retry with backoff on 429 and 5xx, an hourly cap on AI model runs plus a per-visitor hourly cap (reserved when a run starts), and strict argument validation (types, allowed values, lengths, unknown keys dropped, control characters stripped). If the model answers in plain text or makes no actions, the built-in rules finish the inquiry through the same checked functions instead of escalating a normal request. At start-up the app makes one tiny test call to the model (no customer data, `PROBE_MODEL=0` turns it off) so `/api/health` can say honestly whether the model works.

### Backup mode

If `VULTR_INFERENCE_KEY` is not set, the hourly or per-visitor limit is reached, or a model call fails, built-in rules follow the **same steps** and call the **same checked functions**. The run is labeled "Backup mode: built-in rules" in the step list, the header badge and `/api/health`. Reply time is measured from the inquiry arriving to the first reply, so every reply includes any time spent asking the AI model first. A reply written by the built-in rules after a model attempt is therefore not instant; the dashboard shows the real time for each reply.

### Model limits, fallbacks and checks

* **Token budget.** Each model call asks for `max_tokens` 2000 (`MODEL_MAX_TOKENS`). Models that think before answering can use a small budget up on thinking and return nothing. If a call ends with `finish_reason: length` and no answer, the app retries once with up to 2.5 times the budget, capped at `MODEL_MAX_TOKENS_CAP` (default 4000, so with the defaults the retry asks for 4000) and asks for 2-4 short sentences. The first request also asks the server to skip long thinking (`chat_template_kwargs: {enable_thinking: false}` and `reasoning_effort: low`). If the server answers 400 or 422 and names one of those fields, that field is dropped for the rest of the process. Set `MODEL_THINKING_OFF=0` to never send them.
* **tool_choice fallback.** The one forced retry asks for `send_reply` with an object `tool_choice`. If a 400 or 422 error mentions `tool_choice` or tools, the app falls back to `"required"`, then to `"auto"`, and remembers it. Any other 400 does not change the request.
* **Total deadline and worst-case wait.** One inquiry may wait on the model for at most `MODEL_DEADLINE_MS` (default 18000 ms) in total, counted from the first model call. Each upstream call times out after the smaller of the time left and 12 seconds, and at most 6 upstream calls (retries included) are made per inquiry. Once the deadline passes, no further call or retry is made and the built-in rules answer at once (`model_timeout`). So the worst case for the customer is the 18 s deadline (plus at most one in-flight call finishing inside it) and then an immediate rules reply.
* **Fallback diagnostics.** Every reply records who wrote it (`by`: model, rules or safety) and, when the rules wrote it after a model attempt, a short `fallbackReason` made only of rule ids and error classes, never message text: `text_rejected:<rule>`, `tool_rejected:<rule>`, `empty_end` (`:length`, `:reasoning_only`, `:too_short`), `loop_limit`, `model_timeout`, `model_error:http_<status>` / `network` / `internal`, `safety_path`, `quota`, `offline`. Replies the rules write on purpose with no model attempt (`availability_lookup`, `offer_pick`, `other_time`) are not fallbacks: `/api/health` counts them separately as `ruleHandled`. The lead detail shows it as the "Answered by" line (for example "Answered by the built-in rules: model reply was rejected: promise to look something up") and `/api/health` counts the reasons over the last hour, once per reply.
* **Reply checks for model text.** Replies from the AI model pass these checks in code before the customer sees them. A rejected reply gets one nudge, then the built-in rules answer with real times (a wording problem never becomes a "a teammate will follow up" note). `dangling`: the reply only promises to look something up. `no_times`: a scheduling request answered with only a question, or a reply after `check_calendar` that has none of the open times and does not say the requested time is taken. `bad_time`: the reply offers a clock time that is not an open slot; the dashboard says "offered a time that is not open". The time check reads the reply clause by clause and resolves weekdays, dates (including `11/5`, day-first dates, "the 5th", "next Friday", "Thursday the 12th"), AM/PM, bare `10:00`, "nine thirty", noon/midday and lists such as "10, 11 or 12". Clauses that say a time is taken, closed or not an option, hours statements, deadlines ("reply by 5 PM"), arrival and finish times ("arrive at 9:45") and durations are not treated as offers. This is a best-effort safety net, not a proof: wording it cannot read (for example a bare "Monday 12", or a time only implied by context) can pass. After a booking exists, new offers are still checked; confirming the booked time is fine. Booking claims ("you're booked", "I've reserved that time for you") are rejected unless a booking was made (a conditional offer such as "just confirm and I'll lock it in" passes), hand-off claims run `escalate_to_human` so the sentence is true, and change claims ("I moved your appointment") are always rejected because only a teammate can change a booking.
* **Offered-slot semantics.** `lead.offeredSlots` is the list of times the customer was shown in the latest reply (for a model reply, the checked times parsed from the delivered text; for a rules reply, the listed slots), not the whole calendar result. Software books a time only when the WHOLE customer message is a pick: a bare yes/ok/sure/that works/book it (when exactly one time was shown), or a number, ordinal, "earliest", "the one at 2" or a time that matches a shown option, with no negation, question, extra clause or other person ("yes but my son also needs one", "not that one", "the one at 2 doesn't work", "yes and how much" all go to the AI model instead). A bare yes with several shown times gets a numbered question over only those. A bare day ("Thursday?") never books: it lists that day's open times. A request for a different time ("can you do 2 pm instead") is never booked silently: if it is open the reply says so and asks "Want me to book it?"; with offers on several days it asks which day. Every booking is confirmed in a message; when the visit type was filled in by default the confirmation names it and says a teammate will adjust it.
* **Plain availability requests are answered without a model call.** A short message (100 characters or fewer) made up ONLY of availability words (days, dates, "tomorrow", "next week", "ASAP", "soonest", times of day, windows such as "after 3", "before 10", "between 2 and 4", "mornings", "after lunch", "anything", "open", "available", "do you have", "can I come", please/thanks) and the names of the business's own services is answered by the built-in rules from the calendar. Any other word (a symptom, a person, a document, a price or insurance question, "Saturday or Sunday", "before my flight") sends the message to the AI model. Windows list only slots inside the window, or say nothing is open there and offer the nearest others. The lead detail shows "Answered by: Built-in rules (availability lookup)", "(the customer chose among times already offered)" or "(the customer asked about a different time)". These deliberate rule answers are counted in `/api/health` under `ruleHandled`, not under `fallbackReasons`.
* **Hand-off claims.** If the model's reply says a person has the case ("I've flagged your request for a teammate", "I've passed this to our team", "I've notified a manager", or "a teammate will review/follow up" in a reply that is not about picking a time), the software runs `escalate_to_human` through the normal path so the sentence is true. Sentences about confirming a visit, reminders or forwarding details to the calendar do not count.
* **Billing fast path.** Dispute wording ("charged twice", "charged double", "charged again", "overcharged", "unauthorized charge", "dispute the charge", "chargeback", "want my money back", "refund me", "demand a refund") is handled in code: the customer gets a fixed apology and a person is brought in, with no model call. A plain refund question ("Do you offer refunds?", "refund policy") is a normal person-needed hand-off without the apology. Tax-refund talk ("how long until my refund", "bigger refund", "refund on my tax return") is never treated as a complaint.
* **Off-topic.** Clearly unrelated messages (recipes, sports scores, jokes, homework, cover letters, "recommend a good ... near me" for places unrelated to the business) get the polite "outside what I can help with" reply and a small "Outside scope" badge in the inbox list and the lead detail. A message that uses a word from the business's own world (its services and topics plus a short list of common words such as teeth, hair, tax, kids, fluoride or office) is not flagged; the list is not exhaustive, and a sport word alone does not count as off-topic (only scores, schedules, betting and the like do). When only the AI model asked for a person on an unrelated request, nobody is paged: the polite decline stands and the lead gets the badge. The flag by itself never creates an owner phone alert, and it never suppresses one that a safety, urgent, billing or topic rule asked for.
* **Scheduling requests.** The prompt tells the model to call `check_calendar` first and give 2-3 open times (nearest first) for any booking-like request, to say a requested time is taken when it is, and to ask at most one short question after the times. For ASAP or pain it also adds the 911/ER line and the business phone. A model reply to such a request that contains no time and only a question is not final: one nudge to check the calendar, then the built-in rules answer with real times. Clarifying questions on non-scheduling messages are not affected.
* **Emergency note guarantee.** For an urgent or emergency message, the customer always receives the profile's safety note (with 911 where the profile has it) and the business phone, whoever wrote the reply. If the model's reply already has both, nothing is added; if it has one, only the missing piece is added; if it has neither (or asks a booking question), the fixed urgent text replaces it. The medical and self-harm path is always a fixed code reply.


### Guardrails (checked in code, not only in the prompt)

These checks run in software on every message and every outgoing reply. What each one blocks:

* **Business hours:** no booking outside the profile's hours. Times come only from the business's calendar. A day or date the customer asks for is never swapped for a different one: the assistant offers the nearest times from that day or says what is open.
* **Approved prices:** any dollar amount in a reply must fall inside the range set for the service. Otherwise the message is blocked, and the assistant must quote the range, say the cost is confirmed in person, or hand off. Amounts are also caught when written as USD, euro, number words ("fifty bucks", "one-fifty"). Discounts, refunds, guarantees, warranties, free offers ("for free", "free consultation", "complimentary", "no cost"; "free parking" as a fact is fine), links, bare web addresses and written-out emails or phone numbers are blocked in outgoing messages, including in messages the software writes itself. The model's wording is also checked before it is sent: it may not say an appointment is booked, confirmed or reserved unless one really exists, and once one exists it may not say it was changed, cancelled, added or moved to a different day or time; it may not echo instruction overrides, tool names or JSON, markup or reasoning text. Text is normalized first (invisible characters, full-width letters and look-alike letters are folded). A rejected message is retried once, then the built-in rules answer. This is a set of pattern checks, not a guarantee against every possible wording.
* **Always handed to a person:** urgent situations defined by the profile (marked urgent, with a safety note), complaints and angry customers, topics the profile lists (for example insurance and billing at the dental office, tax or legal advice at the tax office), schedule changes, requests for a person, out-of-scope services (the customer is told, not silently parked), out-of-area requests, and unclear requests after two questions.
* **Possible medical emergencies, in any business:** wording such as chest pain, trouble breathing, an overdose or thoughts of self-harm gets a fixed message telling the customer to call 911 (or 988), plus an urgent alert to a person. The AI model is not involved in that reply.
* **Tricks:** customer text is always treated as data, never as instructions. If a message (or the name field) tells the assistant to ignore its rules (a "prompt injection"), it is flagged and handed to a person. The screening folds look-alike and zero-width characters and spaced-out letters before matching. It is keyword-based and conservative, so it can hand off an ordinary message that sounds like an instruction. The booking, price and handoff checks run in code after the model, so a model that is talked into a bad action is still stopped there. Customer names are echoed in replies only when they are plain names. See `test/safety.test.js`, `test/review3-behavior.test.js`, `test/profiles.test.js`, `test/agent-offline.test.js` and `test/model-loop.test.js`.
* **Public endpoints:** body size limit (8 KB), field limits, per-minute and per-hour per-IP rate limits, strict CSP headers, all customer text HTML-escaped on screen. Inquiry lists and details mask phone numbers; writing to an inquiry (customer replies, thread messages) needs that inquiry's secret token. Demo bookings made by visitors are limited (3 per visitor, 24 in total) and released after 30 minutes with a note in the conversation, and when a booking cannot be made because of those limits the customer is told and a person is brought in instead of repeating the same offer. Sample inquiries follow the same limits. `POST /api/demo/reset` reloads only the fictional sample day (visitors' own conversations are never touched; it is rate limited and never touches the model budget), and the sample day also reloads itself every 6 hours so its times stay relative to now.

## Run it locally

Requires Node 22. No build step.

```bash
npm install
npm start            # http://localhost:3000, default business, backup mode, sample day pre-loaded
BUSINESS_PROFILE=salon npm start
```

To use Vultr Serverless Inference:

```bash
export VULTR_INFERENCE_KEY=...            # never commit this
export VULTR_INFERENCE_MODEL=glm-5.3-flash   # optional, this is the default
npm start
```

Useful environment variables are listed in [`.env.example`](.env.example). `npm run seed` resets the data file and reloads the sample day. Follow-up delays run on a demo clock (`FOLLOWUP_SPEEDUP`, default 60, so 30 minutes fires in 30 seconds); set it to `1` for real time. Set `TRUST_PROXY=1` only when the app sits behind one reverse proxy (Caddy, nginx); it is off by default so rate limits key on the real socket address.

The owner phone alert uses two more:

| Variable | Meaning |
| --- | --- |
| `NTFY_TOPIC` | ntfy topic that receives the owner alert. Pick a long random name and subscribe to it in the ntfy phone app. Unset means no alerts. Never shown by the app or `/api/health`. |
| `DASHBOARD_URL` | Optional, https only. Link added to the alert so the owner can open the dashboard. |
| `CALENDAR_ICAL_URL` | Optional. The **secret** "Secret address in iCal format" of a Google Calendar (`https://calendar.google.com/calendar/ical/.../basic.ics`). Unset means the demo calendar. Only https on exactly `calendar.google.com` is accepted (checked at startup, the app refuses to start otherwise). Never shown by the app, `/api/*` or logs. |
| `CALENDAR_PROFILE` | Which business profile uses that calendar (default `dental`). Other profiles keep their demo calendars. |

`/api/health` shows `notify: { configured, alertsLastHour }` without the topic. Alerts are off in tests and when `FORCE_OFFLINE=1`.

Public intake: open `/lead`, or `POST /api/leads` with JSON `{ "name", "phone", "message", "source" }`.

## Connect a Google Calendar (read-only)

Optional and **read-only**: the app reads a Google Calendar to learn when you are busy, and never writes to it.

1. In Google Calendar, open the calendar's **Settings and sharing** and copy **Secret address in iCal format**. Anyone with this address can read the calendar, so treat it like a password and never commit it.
2. Set `CALENDAR_ICAL_URL` to that address (on the VM, in the variables at the top of `deploy/cloud-init.sh` or in `/etc/first-answer-agent.env`) and, if it is not the dental office, set `CALENDAR_PROFILE`.
3. Restart. `/api/health` shows `calendar: { connected, lastOk, lastError, eventsLoaded }` and the Calendar page shows a "Connected: Google Calendar (read-only)" badge.

How it behaves:

* The feed is fetched at most once a minute (5 second timeout, 2 MB limit, redirects only within `calendar.google.com`). Events become busy blocks: UTC, time zone, floating and all-day times, durations, and repeats (`DAILY`, `WEEKLY`, `MONTHLY` by day of month or by weekday such as `1TH` or `-1FR`, and `YEARLY`, with `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`, `BYMONTHDAY`, `BYMONTH` and `EXDATE`; changed single occurrences are honored). Series that started years ago are handled directly, and parsing is bounded so a feed can never hold the server up: at most 2,000 relevant events, 5,000 expanded busy blocks inside the window, 1,000 `EXDATE`s per event (over that, the event's exclusions are ignored, which blocks more time, never less, and is counted in `warnings`), 100,000 characters per line and about a quarter second of processing. A calendar that goes over the event, block or time caps counts as unreadable (error `too_complex`) and the app uses the demo calendar. This suits a small business calendar; a calendar with hundreds of daily repeating events will hit it. Cancelled and "free" (transparent) events are not busy. Windows-style zone names such as "Eastern Standard Time" and `US/Eastern` are mapped to the right zone; a zone name the app does not know blocks both possible readings of the time and is counted (`warnings` in `/api/health`).
* Busy times are read for 14 days back to 120 days ahead. Dates beyond that are **not checked**: the Calendar page labels them "Calendar not checked", and the assistant neither offers nor books them.
* Busy blocks apply to **one profile only**; the other example businesses keep their demo calendars. Booked demo appointments still block slots as before.
* Event titles are private: they are never stored, returned by the API or shown. The Calendar page shows only "Busy (Google Calendar)". On the narrow (phone) layout the agenda also lists busy blocks that do not line up with an appointment slot; a past hour that is busy shows the busy card instead of "Past".
* Repeat rules the app still cannot read (hourly, `BYSETPOS`, and similar) block only their first occurrence. They are counted as `unsupportedRules` in `/api/health` and the Calendar page says "Some repeating events in the connected calendar are not supported and may not block time."
* **A short outage does not drop your busy times.** If a refresh fails, the last good read keeps being used for up to 15 minutes and is marked stale: `/api/health` shows `connected: true, stale: true` with the error code, the badge says "last updated N min ago", and the agent's step reads "Connected Google Calendar (read-only, last updated N min ago)". After 15 minutes of failures the app **falls back to the demo calendar** and says so: a notice on the Calendar page, `connected: false` and a short `lastError` code (`timeout`, `network`, `http_error`, `bad_redirect`, `too_large`, `parse_error`, `too_complex`), and "Demo calendar" in the step. It never claims a connection, or fresh data, it does not have. Right after a cold start the first `/api/health` can say `configured: true, connected: false` with no error yet, because the first read runs in the background.
* After a booking, the customer page offers **Add to my calendar** (`GET /api/public/leads/:id/appointment.ics?token=...`, a one-event file that needs the per-conversation token and a real booking) and a Google Calendar link. The event says "Demo booking" and contains no customer details.
* **Rotate the address if it might have leaked.** The secret address is stored in the VM's env file (root only) and, if you pass it through the Vultr startup script, in the instance's user-data. If user-data, the provider console or a backup is ever exposed, open Google Calendar > Settings and sharing > "Secret address in iCal format" and choose **Reset**, then set the new address.

## Deploy on Vultr

1. Create a Startup Script from [`deploy/cloud-init.sh`](deploy/cloud-init.sh) (Products > Startup Scripts). Set `VULTR_INFERENCE_KEY` (and optionally `NTFY_TOPIC`, `DASHBOARD_URL`, `CALENDAR_ICAL_URL`, `CALENDAR_PROFILE`, `BUSINESS_PROFILE`, `REPO_URL`, `VULTR_INFERENCE_MODEL`, `AUTO_UPDATE`, `REPO_PIN`) at the top of the script. Secrets are written to `/etc/first-answer-agent.env` (root-only, mode 600) at install time and are never in the repo.
2. Deploy a Cloud Compute VM, Ubuntu 24.04, with that startup script.
3. The script installs Node 22, clones the repo as the app user, creates a `systemd` service on **port 80**, opens only ports 22 (rate limited) and 80 in `ufw`, and installs a `systemd` timer that runs `git pull` and restarts the service **every 2 minutes**; a failed install or health check rolls back and shows up in `journalctl -u first-answer-agent-update`. To redeploy, push to the repo.
4. The script ends by waiting for the app and, if a key was given, checking that the model really answers (it prints `MODEL VERIFIED` or a warning with the last error). Check `http://<vm-ip>/api/health` for `mode`, `modelVerified`, `lastError`, the hourly model limit, version and uptime.

**Freeze the demo while people are using it.** A late push to the repo would otherwise restart the app and reload data in the middle of a demo. Pick one:

* Before deploying, set `AUTO_UPDATE=0` in the startup script (the update timer is installed but left off), or set `REPO_PIN=<tag or commit>` to install and stay on one release.
* On a running VM, stop the timer: `sudo systemctl disable --now first-answer-agent-update.timer` (turn it back on with `enable --now`).
* Or pin without stopping the timer: `echo <tag or commit> | sudo tee /etc/first-answer-agent.pin`. The timer then stays on that release; delete the file to follow the branch again.

**SSH:** port 22 stays open for the VM's normal SSH access, with `ufw` rate limiting repeated connections. Key-only SSH is recommended: attach an SSH key when you create the VM and set `PasswordAuthentication no`.

### HTTPS (optional `DOMAIN`)

Browsers, webhooks and many hosted tools need an `https://` link. Set `DOMAIN` at the top of the startup script, for example `DOMAIN="155-138-206-164.sslip.io"`. Tip: [sslip.io](https://sslip.io) turns any IP into a real host name with no DNS setup (the VM's IP with dashes, then `.sslip.io`), and Let's Encrypt will issue a certificate for it.

With `DOMAIN` set, the script also:

* installs Caddy from its official apt repo and writes a Caddyfile that serves `DOMAIN` with an automatic Let's Encrypt certificate and proxies to the app; plain `http://` redirects to `https://`, and responses get `X-Content-Type-Options` and `Referrer-Policy` headers (no HSTS);
* moves the app to `127.0.0.1:8080` so it is no longer reachable directly, and opens ports 80 (certificate challenge and redirect) and 443 in `ufw`; 22 stays rate limited;
* sets `TRUST_PROXY=1`. Behind Caddy every request arrives from 127.0.0.1, so without it the per-IP rate limits and the visitor key would treat all visitors as one. With exactly one trusted proxy in front, the app reads the real client address Caddy passes along;
* starts the app before Caddy (a systemd drop-in) and ends by checking `https://DOMAIN/api/health`, retrying for up to 5 minutes while the first certificate is issued. If it is still pending it says so and reports the local app health instead. The 2-minute updater restarts only `first-answer-agent.service`, never Caddy.

Leave `DOMAIN` empty and nothing changes: the app listens on port 80 over plain HTTP and Caddy is not installed. Caddy logs: `journalctl -u caddy`.

## Tests

```bash
npm test      # node --test: all tests pass at the time of writing
```

The same flows (price question and booking, urgent situation, angry customer, prompt injection, after-hours, vague message, always-human topics, medical emergencies, sample day, the assistant's instructions and action definitions) run against all three profiles, plus function validation, approved-price and outgoing-message checks, booking conflicts and demo limits, the safety screening, the built-in rules, follow-up timers, the tool-calling loop against mocked and real local OpenAI-compatible servers, API validation, rate limiting, demo protection, the business switcher and its isolation, wording checks, persistence, and the deploy and update scripts.

## Honest limitations

* **Messages to customers are simulated.** No text or email is sent to a customer, and there is no real phone number behind the form. The one real outside action is the owner phone alert (ntfy) when an inquiry is handed to a person. Demo data is fictional, and "Text message" and "Phone call" sources are simulated examples.
* **The calendar is a demo calendar unless you connect one.** The optional Google Calendar connection is read-only (the app never creates or changes events there) and covers one business profile. There is no Outlook support and no two-way sync.
* **Sign-in:** the demo dashboard is open (phone numbers are masked, writes need a per-inquiry token). A real deployment needs sign-in and separate accounts per business.
* Storage is a single JSON file per business, which is fine for a demo and one VM, not for scale.
* The screening for instructions hidden in messages is deliberately conservative: it may hand off an ordinary message that sounds like an instruction. That is the safe direction.
* Prices, hours and wording are example configuration in the profiles. The assistant gives no medical, legal or tax advice and says costs are confirmed in person.

## Real next steps

* GoHighLevel integration: create contacts and opportunities, send real texts through its conversations API, sync appointments.
* Twilio or carrier SMS for true two-way texting, with consent and quiet hours.
* Google Calendar and Outlook two-way sync, with staff and travel-time rules.
* A profile editor screen; separate accounts and sign-in per business.
* Missed-call text-back, intake photos and documents, review requests after the visit.

## License

MIT. See [`LICENSE`](LICENSE).
