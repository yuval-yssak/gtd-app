# GTD × Claude Demo Video — Full Plan

Prepared 2026-07-19. Source material: your last 100 Claude sessions in `~/winn-ai` (Jul 12–19) and your live GTD inventory (staging account).

---

## Part 1 — What your sessions actually show (the story you're telling)

Your last 100 sessions span **just 7 days — ~14 sessions/day**, and they exhibit exactly the behaviors you want to demonstrate:

### 1. GTD items are self-contained work orders
Roughly a third of sessions open with `See gtd <id>` / `Execute gtd <id>` / `perform gtd item`. The GTD item is the context capsule; the Claude session is a stateless worker. Best example: your gcal-sync-jam inbox item is a complete diagnostic handover — timeline, root cause, fix direction, verification steps — written so *any* future session (even under a different account) can resume with zero context loss. That is the "placeholder" superpower in its purest form.

### 2. Capture-and-clarify is a one-liner
Repeatedly: *"See <slack link>. Create a GTD task, clarify it, fill in all the fields."* Five of these were fired within the same few minutes on Jul 15 (17:11–17:29) — a clarify burst. You also dictate full metadata inline: *"clarify to next action, computer, 15 minutes, low energy, expected by Tuesday, focus, ignore until Tuesday."*

### 3. True parallelism
Sessions started the same minute on different topics: 19:35–19:36 Jul 19 (webhook-alert investigation + 8-PR merge train + suggestion writing), 22:49 Jul 16 (×3: prod-issue triage, Jira review planning, Slack investigation), 14:15 Jul 14 (×3). Topics in flight simultaneously: prod investigations, stats gathering, ticket creation, code review, merge trains, deploys, Slack drafting, research.

### 4. Delegation with a safety net
*"Schedule a DM for Haim tomorrow 8:30 → flip the item to waitingFor, expected by Tuesday, person: Yosef."* The waiting-for list + scheduled Slack messages = delegation that can't fall through the cracks.

### 5. The tickler absorbs the future
*"Haim returns Sept 3 → ignore until Sept 28, expected by Oct 8."* Items like "remove the feature flag in a few weeks (ignoreBefore Jul 30)" and "pen test 2027" park cleanly and resurface on their own.

### 6. Everything is a bucket, including meta-work
Quota-burn postmortems, agenda items batched per person (`agenda gilad` ×10+), item merging/dedup, "interview me" kickoffs, routines generating recurring next actions (backlog scan, PR scan, quarterly secret renewal).

**Inventory scale (the credibility number):** 26 inbox, 200+ next actions, ~9 active waiting-fors, dozens of tickled items, 57 routines, 24 people, 9 contexts — and it's all *moving*, not rotting: items reference sessions, sessions reference items.

---

## Part 2 — Video 1: the 3–5 minute intro

**Working title:** *"How I run 15 parallel workstreams without dropping one"*
**Audience:** RND teammates who currently run 1–2 threads and feel maxed out.
**Format:** talking head (webcam bubble) over slides/screen, tight cuts.

| Time | Beat | On screen |
|---|---|---|
| 0:00–0:30 | **Hook.** "Last week I ran 100 AI work sessions in 7 days — investigations, code reviews, deploys, tickets — in parallel, without losing a single thread. The bottleneck was never the AI. It's what happens in *your head* between the threads." | Fast montage: terminal tabs, GTD lists scrolling, tickets closing |
| 0:30–1:15 | **The problem.** Interruptions kill you twice: once when they arrive, once when you try to resume. Most people cap their parallelism at whatever fits in working memory (~3 things). | Simple diagram: brain with 3 slots, overflowing |
| 1:15–2:30 | **The system.** GTD in 30 seconds: capture everything → clarify into buckets (next actions / calendar / waiting-for / tickler / someday). Then the twist: **each item is written as a self-contained work order that an AI agent can execute.** The trusted system isn't just for *you* to resume — it's for your agents to start. | The 5-bucket diagram, then an arrow: GTD item → Claude session |
| 2:30–3:30 | **The multiplier.** Show (sped up): three sessions launched from three GTD ids in one minute. Interruption arrives → 20-second placeholder capture → back to work. Delegation → waiting-for + scheduled follow-up message. | Real screen recording, 2–4× speed |
| 3:30–4:15 | **The payoff.** "Every open loop lives in the system, so my head is free to think about only the thing in front of me. That's why more threads doesn't mean more stress — it means more throughput." One metric slide (e.g. tickets/PRs closed in 2 months). | Metric slide |
| 4:15–4:45 | **CTA.** "The full 40-minute demo shows a real morning, end to end — link below. Steal the system." | End card |

Script tip: write the narration first (~600 words for 4 min), record audio, then capture screens to match. Much faster than narrating live.

### Video 1 — full narration script (read this word for word)

~620 words ≈ 4:15 at a natural pace. Read it aloud twice before recording; change any phrase that doesn't sound like you. `[VISUAL: …]` lines are not read — they tell you what to capture later for that part of the audio.

---

**[HOOK — 0:00]**
*[VISUAL: fast montage — terminal tabs opening, GTD lists scrolling, a Jira ticket moving to Done]*

Last week, I ran about a hundred AI work sessions. In seven days. Investigations, code reviews, deployments, tickets, Slack follow-ups — many of them running at the same time, in parallel. And I didn't drop a single one.

Not because I have a great memory. I don't. Because the hard part of working in parallel was never the AI. It's what happens in your head *between* the threads.

**[THE PROBLEM — 0:30]**
*[VISUAL: simple slide — a head with three slots, a fourth item bouncing off]*

Think about what an interruption actually costs you. Someone pings you with something urgent. You stop, you handle it. And then you come back to your own work and spend twenty minutes reconstructing: where was I? What did I already check? What was I about to do next?

An interruption charges you twice — once when it arrives, and once when you try to resume. So most of us cap ourselves at two, maybe three things at once, because that's what fits in a human head. Everything beyond that either falls on the floor — or turns into background stress.

**[THE SYSTEM — 1:15]**
*[VISUAL: the five-bucket diagram, buckets lighting up one by one as they're named]*

My way out is a thirty-year-old idea called Getting Things Done — plus one new twist.

The core idea: your head is for *having* ideas, not for *holding* them. Having ideas is what makes you special. Holding them is what makes you tired. So everything — every request, every bug, every "I should look into that," any thought that pops into your head that you want something done about — gets captured into one system, immediately, in seconds. Then each item is clarified into exactly one bucket. Either it's a next action — something concrete I'll do as soon as I can get to it. Or it belongs to a specific time — a meeting, a demo, a flight — so it goes on the calendar. Or I'm waiting for someone else. Or it's parked in the tickler, to reappear by itself on a future date. Or it's a someday-maybe. Five buckets. Nothing lives in my head.

*[VISUAL: a real GTD item with rich notes, then an arrow: item → Claude session]*

Now, my twist. I write every item as a self-contained work order: what's the goal, what's known so far, what's the next step. I used to do that so that future-me could resume it after a week. But here's the thing — if an item is written well enough for future-me to pick it up cold… it's written well enough for an AI agent to pick it up cold.

**[THE MULTIPLIER — 2:30]**
*[VISUAL: real footage at 2–4× speed — three terminal tabs, each prompt is one line: "See gtd <id>"]*

So my mornings look like this. I scan the system, pick three or four items that fit my time and energy, and launch a Claude session for each one. The entire prompt is one line: "See GTD item so-and-so." The item carries all the context. The agents work — I do the five-minute human things in between.

*[VISUAL: Slack ping arrives; 20-second capture; a one-line placeholder note lands on the open item]*

When an interruption lands — and one lands every day — I spend twenty seconds capturing it. If I have to switch, I leave a one-sentence placeholder on the thing I was doing: "reviewed up to file three, concern about the retry logic, next step is the tests." Coming back later costs me seconds, not twenty minutes.

And when I hand something to a teammate, it goes on my waiting-for list with a date — and the follow-up message is already scheduled. Delegation, without the anxiety.

**[THE PAYOFF — 3:30]**
*[VISUAL: metric slide — fill in the real number: tickets/PRs closed in the last 2 months]*

Here's what this buys you. Every open loop lives in the system, so my head is completely free for the one thing in front of me. That's why more threads doesn't mean more stress. It means more throughput. In the last two months, that looked like: **[insert your number — e.g. "N tickets shipped, M PRs merged"]**.

**[CALL TO ACTION — 4:15]**
*[VISUAL: end card — link to the full demo, one line: "Start with capture."]*

If this sounds like a system that takes discipline — it takes far less than the reconstruction you're already doing today. I recorded a full morning, end to end, about forty minutes: capturing, fanning out, getting interrupted, recovering, delegating. The link is below.

Watch it. Then steal the system. Start with capture — everything else follows.

---

**Recording notes for this script:**
- One `[insert your number]` blank in the Payoff section — fill it before recording, don't improvise it live.
- If a sentence trips you twice while reading aloud, rewrite it in your own words — the script serves you, not the reverse.
- Pause a full second at each section break; it gives you clean cut points in Descript.

---

## Part 3 — Video 2: the 30–60 minute demo ("a morning in the life")

**Format:** one continuous scripted "morning", played straight — real app, real terminal, contrived data (Part 4). Chaptered so people can jump. Target ~40 min recorded, trimmed from ~60.

### Chapter map

**Ch 1 — The morning scan (5 min)**
Open the GTD app. Walk the daily scan: calendar for today, tickler items that surfaced this morning (show one that was invisible yesterday), urgent/expectedBy flags, then filter next actions by energy + time + context ("I have 90 minutes and high energy before standup — give me focus items"). Pick 3–4 items to run *in parallel*.
*Teaching point: you choose work by context/energy/time, not by whatever screams loudest.*

**Ch 2 — Fan-out (8 min)**
Open 3–4 terminal tabs. In each, launch a Claude session anchored to a GTD id:
- Tab 1: `See gtd <id>` → investigate the duplicate-webhook bug (deep dive).
- Tab 2: `Execute gtd <id>` → gather usage stats for the legacy dashboard.
- Tab 3: `See gtd <id>` → draft the Jira ticket for the mobile crash, fill all fields.
- Tab 4: PR #142 review.
Emphasize: each prompt is one line, because *the item carries the context*. While agents run, you do the 5-minute human-only items (an agenda item, a quick Slack reply).
*Teaching point: the unit of delegation is a well-clarified GTD item.*

**Ch 3 — The interruption (6 min)** ← the emotional core
Mid-review, an urgent Slack arrives (blank-screen SSO bug, 3 customers). On camera:
1. 20 seconds: capture it to inbox with the Slack link.
2. Decide it IS the new priority → before switching, write a **placeholder** on the PR-review item: "Reviewed through file 3/7; concern about retry backoff in worker.ts:88; next: check test coverage." One sentence to Claude does it.
3. Switch. Launch a session on the new bug.
Later in the chapter, return via the placeholder and resume in seconds.
*Teaching point: interruptions cost 20 seconds of capture, not 20 minutes of reconstruction.*

**Ch 4 — Harvest & write-back (8 min)**
The fan-out sessions finish. For each, close the loop differently (this variety is the lesson):
- Investigation → root cause found → item becomes a **new next action** ("implement fix") + notes updated with full findings (show the handover-note style).
- Stats → done, results pasted into the item, **mark done**.
- Ticket creation → done, but spawns a **waiting-for** (QA to confirm repro).
- PR review → changes requested → **waiting-for Omer**, expectedBy Tuesday, + Claude schedules the follow-up DM.
*Teaching point: a session never just "ends" — its outcome lands in a bucket.*

**Ch 5 — Delegation & waiting-for (5 min)**
Walk the waiting-for list. Show one item whose expectedBy passed → follow up (scheduled Slack message for 8:30 tomorrow). Flip an item to waiting-for with person + date in one Claude sentence.
*Teaching point: "waiting" is a managed state, not a hope.*

**Ch 6 — Breaking down big things (5 min)**
Take one fat inbox item ("rate-limiting epic") and split it live: 3 next actions with contexts/estimates + 1 tickler follow-up + 1 agenda item for the manager. Show the "interview me" pattern: ask Claude to interview you to clarify an ambiguous item.
*Teaching point: responsibility over a topic = owning its decomposition, not doing it all today.*

**Ch 7 — Tickler & routines (4 min)**
Show `ignoreBefore` mechanics: an item parked to next month, invisible everywhere. Show routines generating recurring next actions (weekly PR scan, quarterly key renewal) that arrive pre-tickled to their due date.
*Teaching point: the system remembers the future so you don't.*

**Ch 8 — Close: the trust loop (4 min)**
Recap the morning's ledger: N items captured, M clarified, K done, J delegated, all loops accounted for. One honest sentence about the weekly review being what keeps the system trustworthy. Final metric + "start with capture; everything else follows."

### Production notes
- **Use a dedicated demo account** — your real inventory contains internal ticket numbers, org IDs, prod incident details, and people's names. Create a fresh user on staging, add a `GTD_API_TOKEN_DEMO` account to the MCP, and seed the Part-4 inventory (I can generate the `gtd_batch` seeding script on request).
- Pre-stage the Slack "interruption" with a scheduled message to yourself so it lands on cue.
- tmux or iTerm tabs named per topic (`webhooks`, `stats`, `ticket`, `pr-142`) so viewers can track the parallelism visually.
- Record at 2× the pace you think you need, then cut. Add chapter markers.

---

## Part 4 — Contrived demo inventory (feels real, safe to show)

Fictional setting: you're a team lead on a B2B SaaS ("Acme CRM Sync"), tickets are `ACME-xxxx`. Simpler than your real data but the same shapes.

**People:** Dana (your manager) · Omer (backend dev) · Maya (QA lead) · Tom (DevOps) · Noa (product)
**Contexts:** computer · agenda · read · write · think · anywhere

### Inbox (some pre-seeded, some arriving on camera)
1. Slack from Maya: "Login page sometimes blank after SSO redirect — 3 customers reported" *(the scripted interruption)*
2. "Prepare talking points for Thursday's architecture review"
3. "Nightly data-export job ran twice yesterday — why?"
4. "Idea: auto-generate release notes from merged PRs"
5. "Rate-limiting epic — we keep getting burst-429s from the CRM vendor" *(the item you decompose in Ch 6)*

### Next actions (pre-seeded)
| Title | Context | Energy | Time | Flags |
|---|---|---|---|---|
| Investigate duplicate webhook deliveries in billing service (notes: prior findings, log queries) | computer | high | 45m | focus |
| Review PR #142 — retry logic for export worker | computer | high | 30m | focus |
| Gather stats: customers still on legacy dashboard | computer | low | 15m | — |
| Create ticket: mobile app crash on notification tap (notes: stack trace, repro) | computer | low | 10m | — |
| Draft Q3 on-call schedule proposal | write | medium | 20m | — |
| Dana: headcount ask + feature-flag cleanup policy | agenda | low | 5m | — |
| Read new observability vendor docs | read | low | 30m | — |
| Update incident runbook from last week's outage | write | medium | 15m | expectedBy: this Fri |

### Waiting for
- **Omer** — rate-limiter config fix · expectedBy Tuesday
- **Vendor support** — answer on webhook retry semantics · expectedBy Friday
- **Maya** — regression results for release 2.14 · expectedBy tomorrow *(overdue during demo → triggers Ch 5 follow-up)*

### Tickler (ignoreBefore)
- Remove new-search feature flag · ignore until Aug 10, expectedBy Aug 15
- Follow up on data-retention decision · ignore until Aug 1
- Prepare vendor-renewal notes · ignore until Sep 1
- **One item that surfaces the morning of the demo** (e.g. "Rotate API signing key — due this week") so Ch 1 shows the tickler working live

### Calendar
- Daily standup 09:45 · Architecture review Thu 14:00 · 1:1 Dana Wed 15:00

### Routines
- Weekly: "Scan PRs waiting on my review" (Mon) · Quarterly: "Rotate API signing keys" · Daily standup event

---

## Part 5 — Platforms & tooling

### Recording + editing (recommended stack)
| Tool | Role | Why |
|---|---|---|
| **Screen Studio** (macOS, ~$89 one-time) | Record both videos | Auto-zoom on clicks, smooth cursor, webcam bubble, beautiful output with zero editing skill. Ideal for the intro's polish. |
| **Descript** (free tier / ~$12+mo) | Edit the long demo | Edit video by editing the transcript — delete filler words and dead air in text. Turns a 60-min raw take into 40 min fast. Studio Sound cleans audio. |
| **OBS Studio** (free) | Alternative recorder | Multi-scene (terminal scene / app scene / face cam), if you want scene switching live instead of in the edit. |
| **Loom** (free/paid) | Lightweight alternative for the demo | If this stays internal: instant share link, chapters, viewer analytics, comments. Lowest friction — record and it's already hosted. |

### Supporting
- **Keynote or Canva** — the intro's few slides (5-bucket diagram, metric slide).
- **Excalidraw** — the hand-drawn-feel system diagram (fits the "personal system" vibe).
- **CleanShot X** — short teaser GIFs for the Slack announcement post.

### Two sane combos
1. **Polish:** Screen Studio (capture both) → Descript (cut the demo) → host on Drive/Slack. Intro looks professional, demo is tight.
2. **Speed:** Loom for everything, chapters instead of edits. Ship this week.

Given the audience (internal RND, goal = inspire adoption), combo 1 for the intro + combo 1-or-2 for the demo. The intro is your rewatchable asset; the demo can be rawer — authenticity actually helps there.

---

## Suggested next steps
1. Create the demo user on staging + `GTD_API_TOKEN_DEMO` → I can seed the entire Part-4 inventory via `gtd_batch` in one go.
2. I can draft the full narration script for Video 1 (~600 words) and a beat-by-beat shot list for Video 2.
3. Schedule the Slack "interruption" message before recording.
