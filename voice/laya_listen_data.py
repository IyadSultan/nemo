"""Labeled sentences for teaching Laya the second brain's no-wake-word listening.

Each sentence is something the mic could hear. Two labels:
  route:  "assistant" (a finished request for the assistant),
          "cut_off" (the start of a request, stopped mid-sentence),
          "other" (talk with people, thinking aloud, phone or TV sound)
  intent: which second-brain function it needs, or "none"

All sentences are invented for this purpose. No patient data.
TRAIN and VAL come from templates and hand-written lists below.
TEST is written separately, in different wording, and is never trained on.
PROBE is the 10 sentences Laya failed before training.
"""

import itertools
import random

INTENTS = [
    "notes", "todo", "email_read", "email_write", "calendar", "meeting",
    "memo_save", "memo_find", "time", "web", "follow_up", "stop", "none",
]

PEOPLE = ["Rashid", "Sara", "Dr. Khaled", "Lina", "Omar", "Maha", "the nurse manager", "Hiba", "Dr. Amal", "Yousef"]
TOPICS = ["the AML protocol", "the steering committee", "the grant budget", "the ICU dashboard", "the ethics submission",
          "the bone marrow transplant audit", "the AI strategy draft", "the tumor board slides", "the pharmacy report",
          "the radiology contract", "the annual report", "the residency rotation"]
DAYS = ["today", "tomorrow", "this week", "on Sunday", "next Monday", "this afternoon", "on Thursday"]

# ---------- finished requests for the assistant, by intent ----------
ASSISTANT = {
    "todo": [
        "What's on my to-do list {day}?", "What do I have to do {day}?", "Read me my tasks", "Any deadlines {day}?",
        "What is overdue on my list?", "Which tasks are due {day}?", "What's left on my plate {day}",
        "Do I have anything due for {topic}?", "List my open tasks", "What should I work on next?",
    ],
    "notes": [
        "What do my notes say about {topic}?", "Who is on {topic}?", "Find my notes on {topic}",
        "What did we decide about {topic}?", "Summarize {topic} for me", "Where is the file for {topic}?",
        "Tell me what I wrote about {topic}", "What's the status of {topic}?", "Look up {topic} in my notes",
        "Who leads {topic}?",
    ],
    "email_read": [
        "Read me today's emails", "Any new emails?", "Which emails need a reply {day}?", "Did {person} email me?",
        "Summarize my inbox", "Read the last email from {person}", "Do I have urgent emails?",
        "What did {person} say in the email about {topic}?", "How many emails did I get today?",
    ],
    "email_write": [
        "Reply to {person} and say I agree", "Draft an email to {person} about {topic}", "Write back to {person} that I will join",
        "Send {person} an email asking for {topic}", "Email {person} that the meeting moved to {day}",
        "Draft a reply to the last email", "Write an email to {person} thanking them",
    ],
    "calendar": [
        "What's on my calendar {day}?", "Do I have meetings {day}?", "When is my next meeting?", "Am I free {day} afternoon?",
        "What time is the meeting about {topic}?", "What's my schedule {day}?", "Is there anything on my calendar {day}?",
    ],
    "meeting": [
        "Set up a meeting with {person} {day} at ten", "Book a meeting about {topic} {day}", "Create a meeting with {person} at two",
        "Schedule a call with {person} {day}", "Put a meeting on my calendar {day} at noon about {topic}",
        "Send {person} an invite for {day} at three",
    ],
    "memo_save": [
        "Save a memo: call {person} about {topic}", "Remember that {person} owes me the slides", "Make a note to review {topic} {day}",
        "Take a memo, the budget is due {day}", "Note that {topic} needs a second review", "Save this: ask {person} about {topic}",
    ],
    "memo_find": [
        "Read my memos", "What memos did I save {day}?", "Did I save a memo about {topic}?", "Read back my last memo",
        "What did I ask you to remember?", "Show my recent memos",
    ],
    "time": [
        "What time is it?", "What's the date today?", "What day is it?", "Where am I?", "What's today's date",
        "Tell me the time", "Is it Thursday today?",
    ],
    "web": [
        "What's the news today?", "Search the web for {topic}", "Look up the latest ASCO guidelines", "What's the weather in Amman?",
        "Find news about cancer AI", "Look online for the FDA approval of the new CAR-T", "What's the exchange rate of the dinar?",
    ],
    "follow_up": [
        "What did I just ask you?", "Say that again", "Can you repeat that?", "And what about {day}?", "Tell me more about that",
        "What did you say about {person}?", "Go on", "Remind me what you said a minute ago", "And who else?",
    ],
    "stop": [
        "Stop", "Stop talking", "That's enough", "Okay stop", "Be quiet", "Cancel that", "Never mind", "Enough, thanks",
        "Stop, I got it",
    ],
}

# ---------- talk that is not for the assistant (hard negatives use the same words) ----------
OTHER = [
    "{person}, did you finish the slides for {topic}?", "Did you send the email to {person}?", "{person}, can you check {topic} {day}?",
    "I told {person} the protocol needs another revision", "We should meet {day} about {topic}", "Let's ask {person} about {topic}",
    "Do you know what time the meeting is?", "{person} said the budget is late again", "I think {topic} is in good shape",
    "Hmm, where did I put my glasses", "Okay, see you tomorrow, bye", "Thanks {person}, that was helpful",
    "Yes, I'm on the call, can you hear me?", "Can you share your screen, {person}?", "Sorry, I was on mute",
    "The patient in bed four needs a repeat CBC", "Please call the pharmacy about the dose", "Let me think about this for a second",
    "So the main point of the paper is the survival benefit", "Hello? Yes, this is Iyad speaking", "I'll be there in ten minutes",
    "Did you eat already?", "Close the door please", "{person}, what do you think about {topic}?",
    "In other news, the markets closed higher today", "And now the weather for tomorrow", "Welcome back to the show",
    "Next slide please", "As you can see in this figure, the response rate improved", "We need more data before we decide",
    "My email is not working again", "I have a meeting with {person} {day}, I think", "Remind {person} to bring the consent forms",
    "Who took my charger?", "The kids have school {day}", "Can you pass me the water?", "That's a good question, {person}",
    "I'm not sure the committee will agree", "Let me read it out: the primary endpoint was overall survival",
    "Stop the infusion if the pressure drops", "{person}, stop, wait for me", "Okay, so what's the plan for {topic}?",
]

# ---------- the start of a request, cut off ----------
CUT_OFF = [
    "What's on my", "Can you tell me what", "Read me the", "Draft an email to", "What do my notes say about the",
    "Set up a meeting with", "Search the web for", "Remind me to", "What time is the", "Find my notes on",
    "Save a memo that", "Which emails need", "What did {person} say about the", "Do I have any", "Who is on the",
    "Book a meeting about", "Look up the latest", "Tell me about",
]


def fill(template, rng):
    return template.format(person=rng.choice(PEOPLE), topic=rng.choice(TOPICS), day=rng.choice(DAYS))


def build(seed=7, per_template=4):
    """Expand templates into labeled rows, then split 85/15 into train and val."""
    rng = random.Random(seed)
    rows = []
    for intent, templates in ASSISTANT.items():
        for template in templates:
            for _ in range(per_template if "{" in template else 1):
                rows.append({"text": fill(template, rng), "route": "assistant", "intent": intent})
    for template in OTHER:
        for _ in range(per_template if "{" in template else 1):
            rows.append({"text": fill(template, rng), "route": "other", "intent": "none"})
    for template in CUT_OFF:
        for _ in range(2 if "{" in template else 1):
            rows.append({"text": fill(template, rng), "route": "cut_off", "intent": "none"})
    # Same sentence twice adds nothing.
    seen, unique = set(), []
    for row in rows:
        if row["text"] not in seen:
            seen.add(row["text"])
            unique.append(row)
    rng.shuffle(unique)
    cut = int(len(unique) * 0.85)
    return unique[:cut], unique[cut:]


# ---------- written separately, different wording; never trained on ----------
TEST = [
    ("Hey brain, anything I forgot to do this week?", "assistant", "todo"),
    ("Which of my tasks are late?", "assistant", "todo"),
    ("Pull up what I know about the pediatric sarcoma project", "assistant", "notes"),
    ("Who was in charge of the AI committee again, according to my notes?", "assistant", "notes"),
    ("Is there anything important in my mail?", "assistant", "email_read"),
    ("Has Ahmad written to me today?", "assistant", "email_read"),
    ("Answer Fatima's email and tell her Tuesday works", "assistant", "email_write"),
    ("What's my next appointment?", "assistant", "calendar"),
    ("Am I busy at four?", "assistant", "calendar"),
    ("Schedule half an hour with Nour on Wednesday", "assistant", "meeting"),
    ("Jot this down: renew the license before June", "assistant", "memo_save"),
    ("Play back the notes I dictated yesterday", "assistant", "memo_find"),
    ("What's the time now?", "assistant", "time"),
    ("Check online whether the conference was postponed", "assistant", "web"),
    ("Wait, what was the second thing you said?", "assistant", "follow_up"),
    ("Okay, that's enough, thank you", "assistant", "stop"),
    ("Ahmad, did you upload the abstract?", "other", "none"),
    ("We'll discuss the budget after lunch", "other", "none"),
    ("Can you hear me now? I think my mic was off", "other", "none"),
    ("Nour, let's schedule something for next week", "other", "none"),
    ("Honestly I don't know why the server keeps crashing", "other", "none"),
    ("Thank you all for joining today's meeting", "other", "none"),
    ("And that concludes tonight's broadcast", "other", "none"),
    ("Fatima, could you email me the minutes?", "other", "none"),
    ("Where are my car keys", "other", "none"),
    ("Let me see, the dose was adjusted on day three", "other", "none"),
    ("Could you look up", "cut_off", "none"),
    ("What did I write about the", "cut_off", "none"),
    ("Send an email to", "cut_off", "none"),
    ("How many tasks do I", "cut_off", "none"),
]

PROBE = [
    ("What's on my to-do list this week?", "assistant", "todo"),
    ("Can you send the minutes to Rashid after lunch?", "ambiguous", "none"),  # could be either; not scored
    ("So I told him the protocol needs another revision", "other", "none"),
    ("What time is it", "assistant", "time"),
    ("Read me today's emails", "assistant", "email_read"),
    ("I think we should meet on", "other", "none"),
    ("Okay, see you tomorrow, bye", "other", "none"),
    ("Did you finish the slides for the meeting with Sara?", "other", "none"),
    ("Remind me what I asked you a minute ago", "assistant", "follow_up"),
    ("Stop talking", "assistant", "stop"),
]

if __name__ == "__main__":
    train, val = build()
    counts = {}
    for row in train:
        counts[row["route"]] = counts.get(row["route"], 0) + 1
    print(len(train), "train", len(val), "val", counts, len(TEST), "test", len(PROBE), "probe")
