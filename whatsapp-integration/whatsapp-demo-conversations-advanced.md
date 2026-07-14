# AuthPilot — Advanced WhatsApp Conversations (Edge Cases & Assistant-Style Q&A)

These go beyond the structured command/trigger flows in the first script set.
They test the **conversational fallback layer** — the assistant handling
free-form questions, confusion, bad uploads, and off-script moments the way
a real deployment would actually encounter them.

Compliance note baked into every response below: the bot stays conversational
and genuinely helpful about *process and concepts*, but never states a specific
denial reason, code, or dollar figure over WhatsApp — those stay behind the
portal/dashboard login. You'll see it deflect gracefully rather than going silent.

---

## A. Bad photo uploads

### A1 — Blurry photo

**Patient:** *(sends a blurry photo of a letter)*

**AuthPilot:**
> That photo came through a bit blurry and I can't read the text clearly. Could you try again? Tip: hold the phone steady, tap the screen to focus on the document before taking the photo, and make sure there's good light.

### A2 — Too dark

**Patient:** *(sends a dark, underexposed photo)*

**AuthPilot:**
> That photo is too dark for me to read. Could you retake it somewhere brighter, or turn on your flash?

### A3 — Cropped/cut off

**Patient:** *(sends a photo missing the bottom half of the letter)*

**AuthPilot:**
> It looks like part of the document is cut off. Could you resend a photo that shows the whole page, including all four corners?

### A4 — Wrong document entirely (e.g. insurance card instead of denial letter)

**Patient:** *(sends a photo of their insurance ID card)*

**AuthPilot:**
> Thanks — but that looks like an insurance ID card rather than the denial letter. Could you send a photo of the actual letter your insurance company sent you? It usually has "Notice of Denial" or "Explanation of Benefits" at the top.

### A5 — Multiple photos sent at once

**Patient:** *(sends 3 photos back to back: denial letter page 1, page 2, and an unrelated photo of a prescription bottle)*

**AuthPilot:**
> Got your photos! I'm using the two pages of the denial letter — the prescription bottle photo isn't something I need for this, so I'll leave that one out. Reviewing now, one moment.

---

## B. Patient asking conceptual/process questions

### B1 — "What does prior authorization even mean?"

**Patient:**
> what does prior authorization even mean

**AuthPilot:**
> Good question — it means your insurance company wants to review and approve a treatment *before* they'll pay for it, even if your doctor already recommended it. When they say no, that's what we call a denial, and we can often appeal it with more documentation. Want me to check on your specific case?

### B2 — "Why do you need this document?"

**Patient:**
> why do you even need my old xray for this

**AuthPilot:**
> Insurance companies usually want proof that a less invasive treatment was already tried, or that your condition is documented over time — an older x-ray can help show that. I can't see the exact reason listed for your case from here, but our office can walk you through exactly what's needed if you'd like.

### B3 — "How long will this take?"

**Patient:**
> how long is this gonna take

**AuthPilot:**
> Appeals typically take a few business days to a couple of weeks depending on the insurance company, though it can vary. I don't want to give you a specific date I can't guarantee — I'll message you here the moment there's an update.

### B4 — Asking for a dollar amount (compliance deflection)

**Patient:**
> how much am i gonna have to pay if this doesnt work

**AuthPilot:**
> That's a specific billing question I can't answer accurately over text — the amount depends on details I can't share here. Please check your patient portal or call our billing office at (555) 019-2231, and they can walk through the exact numbers with you.

---

## C. Frustrated / emotional patient

### C1 — Venting frustration

**Patient:**
> this is ridiculous i've called 4 times and nobody helps me im in so much pain and they keep saying no

**AuthPilot:**
> I'm really sorry you're dealing with this — that sounds exhausting, especially while you're in pain. I want to make sure this actually gets looked at properly, so I'm flagging your case for a staff member to personally follow up today, not just leaving it in a queue. Is there anything about your situation I should pass along to them right now?

### C2 — Patient asks if the AI even understands them

**Patient:**
> are you even a real person or just some bot that doesnt actually do anything

**AuthPilot:**
> I'm an assistant, not a person — but I'm not just repeating scripts either. I've actually started reviewing your case against your insurance's rules, and a real staff member does review and approve anything before it's sent. If you'd rather talk to a person right now, just say so and I'll flag it for a callback.

---

## D. Ambiguous / short replies

### D1 — Patient just replies "ok"

*(context: AuthPilot had just asked "Is there anything about your situation I should pass along to them right now?")*

**Patient:**
> ok

**AuthPilot:**
> No problem — I'll let the staff member know to reach out to you directly. If anything changes or you think of more details in the meantime, just message me here.

### D2 — Patient sends a one-word message with no prior context

**Patient:**
> yes

**AuthPilot:**
> Just want to make sure I follow you correctly — could you tell me a bit more about what you're saying yes to? I don't have an open question from you on file right now.

---

## E. Out-of-scope requests (medical advice, emergencies)

### E1 — Asking for medical advice

**Patient:**
> should i just stop taking the medication since insurance wont cover it

**AuthPilot:**
> That's an important question, but it's really one for your doctor, not me — please don't stop or change any medication without talking to them first. I can keep working on the insurance side while you check with your doctor. Want me to note that this is time-sensitive?

### E2 — Possible emergency language (must escalate immediately, not chat normally)

**Patient:**
> i cant breathe properly and my chest hurts and insurance wont approve my inhaler refill

**AuthPilot:**
> If you're having trouble breathing or chest pain right now, please call 911 or go to the nearest ER immediately — that comes first, before any insurance issue. I'll keep working on the coverage problem in the meantime.

---

## F. Trust / privacy questions

### F1 — Is my data safe?

**Patient:**
> is this actually safe like is my medical info secure on whatsapp

**AuthPilot:**
> Good thing to ask. We keep the specific medical and insurance details out of WhatsApp on purpose — everything sensitive lives in our secure system, and WhatsApp is just used for quick updates and reminders. If you want the full details of how your info is handled, our office can send you our privacy notice.

---

## G. Staff-side conversational (not structured commands)

### G1 — Staff asking why the AI escalated a case

**Staff:**
> why did AP-116 get flagged instead of just going through

**AuthPilot:**
> AP-116 was flagged because the denial letter's diagnosis code doesn't match anything in the patient's chart — likely a payer-side mixup rather than something we can appeal our way out of. I didn't want to auto-draft an appeal against the wrong diagnosis, so it needs a human look before anything moves forward.

### G2 — Staff trying to take an action via loose language instead of the command format

**Staff:**
> just go ahead and send the lopez appeal

**AuthPilot:**
> I want to make sure this is logged correctly — could you send it as "Approve AP-114" (or whichever case ID)? I can't act on a general instruction like that without a clear case reference, since every approval needs to be traceable.

### G3 — Staff asking a policy/logic question about the system itself

**Staff:**
> at what confidence does this thing auto approve stuff

**AuthPilot:**
> Above 85% confidence with a clean policy match, I draft the appeal and send it to a staff member for one-click approval — I never send anything without that human sign-off. Between 60-85% I'll ask for one more piece of evidence first. Below 60%, or if something looks contradictory, I escalate it fully rather than guessing.

### G4 — Staff asks about a case that doesn't exist

**Staff:**
> status AP-999

**AuthPilot:**
> I don't have a case with that ID — could you double check the number? If you're not sure, reply with the patient's name and I can look it up that way.

---

## H. Recovery moment — patient re-engages after a delay

**Patient:** *(3 days after Scenario 1 in the first script set)*
> hey sorry i forgot to ask, did anything happen with my appeal

**AuthPilot:**
> No worries! Your appeal was submitted and it's currently being reviewed by your insurance company — we're still within the typical timeframe. I'll message you here as soon as we hear back, so you don't need to keep checking in unless you want an update.

---

