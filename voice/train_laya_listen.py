"""Teach Laya the second brain's no-wake-word listening.

Same method as ~/code/laya_mlx/train_icdo.py: the encoder stays frozen and only
Laya's small decision head learns. Because the encoder never changes, each
sentence is encoded once and cached; epochs then train the head only (seconds, not minutes). Two choice questions:
  route:  is this sentence a finished request for the assistant, cut off, or other talk?
  intent: which second-brain function does it need?
Laya's yes/no answers were unusable for this, so both questions are choices.

Scores TEST and PROBE (never trained on) before and after, keeps the epoch with
the best validation score, and saves only the head weights:
  voice/models/laya-listen/head.safetensors   (git-ignored)
  voice/models/laya-listen/metrics.json

Run with the laya_mlx project's Python:
  ~/code/laya_mlx/.venv/bin/python voice/train_laya_listen.py
"""

import json
import time
import traceback
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
import numpy as np
from mlx.utils import tree_flatten, tree_map

import laya_mlx as laya
from laya_mlx.agent import collate_items

from laya_listen_data import PROBE, TEST, build

MODEL_ID = "aac6fef/laya-mlx"
OUT_DIR = Path(__file__).parent / "models" / "laya-listen"
EPOCHS = 20
# Higher than train_icdo.py's 3e-5: only the small head learns, on cached encoder output.
LEARNING_RATE = 3e-4
# The classes are uneven (many requests, few cut-offs). Repeat the rare ones in training.
OVERSAMPLE = {"assistant": 1, "other": 2, "cut_off": 5}

# The same questions the listening server asks. Keep them in step with voice/laya_server.py.
ROUTE = {
    "type": "choice",
    "instructions": "Who is this sentence for, and is it finished?",
    "criteria": {
        "assistant": "a finished question or request for the voice assistant",
        "cut_off": "the start of a request to the assistant, cut off mid-sentence",
        "other": "talk with other people, thinking aloud, or TV or phone sound",
    },
}
INTENT = {
    "type": "choice",
    "instructions": "What does the speaker want the voice assistant to do?",
    "criteria": {
        "notes": "answer from the user's notes",
        "todo": "tasks, to-dos, deadlines",
        "email_read": "read or summarize emails",
        "email_write": "draft or send an email",
        "calendar": "say what is on the calendar",
        "meeting": "create a meeting",
        "memo_save": "save a memo",
        "memo_find": "find saved memos",
        "time": "time, date, or place",
        "web": "news or a web search",
        "follow_up": "follow up on the last answer",
        "stop": "stop talking",
        "none": "nothing for the assistant",
    },
}
QUESTIONS = {"route": ROUTE, "intent": INTENT}


def encode(agent, text, qid):
    """Run the frozen encoder once for this sentence and question."""
    items, _internal = agent.prepare(text, {qid: QUESTIONS[qid]})
    batch = collate_items(items, agent.tok.pad_token_id, max_length=512)
    hidden = agent.model.encoder(mx.array(batch["input_ids"]), mx.array(batch["attention_mask"]))
    mx.eval(hidden)
    return hidden, batch


def choice_logits(model, hidden, batch):
    """Score each option from cached encoder output. Only the decision head learns."""
    hidden = mx.stop_gradient(hidden)
    hidden = hidden + model.type_emb(mx.array(batch["qtype"]))[:, None, :]
    mask = mx.array(batch["attention_mask"])
    hidden = model.head(hidden, mask[:, None, None, :].astype(mx.bool_))
    markers = hidden[mx.arange(hidden.shape[0])[:, None], mx.maximum(mx.array(batch["marker_pos"]), 0)]
    logits = model.scorer(markers).squeeze(-1).astype(mx.float32)
    return mx.where(mx.array(batch["marker_mask"]), logits, mx.array(-1e4, dtype=mx.float32))


def train_step(model, optimizer, hidden, batch, target):
    def loss_fn(inner):
        return nn.losses.cross_entropy(choice_logits(inner, hidden, batch), mx.array([target]), reduction="mean")

    loss, grads = nn.value_and_grad(model, loss_fn)(model)
    if not mx.isfinite(loss):
        return float("nan")
    grads = tree_map(lambda g: mx.clip(g, -0.5, 0.5), grads)
    optimizer.update(model, grads)
    mx.eval(model.parameters(), loss)
    return float(loss)


def head_weights(model):
    """Everything except the frozen encoder: the part this script trains."""
    return {name: mx.array(value) for name, value in tree_flatten(model.parameters()) if not name.startswith("encoder.")}


def restore(model, saved):
    model.load_weights(list(saved.items()), strict=False)
    mx.eval(model.parameters())


def score(agent, rows):
    """Route accuracy, intent accuracy on requests, and the send decision (route == assistant)."""
    route_hits = intent_hits = intent_n = 0
    tp = fp = fn = scored = 0
    misses = []
    for text, route, intent in rows:
        if route == "ambiguous":
            continue
        scored += 1
        answers = agent.predict(text, QUESTIONS)["answers"]
        got_route, got_intent = answers["route"]["choice"], answers["intent"]["choice"]
        route_hits += int(got_route == route)
        if route == "assistant":
            intent_n += 1
            intent_hits += int(got_intent == intent)
        send, should = got_route == "assistant", route == "assistant"
        tp += int(send and should)
        fp += int(send and not should)
        fn += int(should and not send)
        if got_route != route:
            misses.append(f"{text!r}: {route} -> {got_route}")
    return {
        "n": scored,
        "route_acc": round(route_hits / max(scored, 1), 3),
        "intent_acc": round(intent_hits / max(intent_n, 1), 3),
        "wrong_sends": fp,
        "missed_requests": fn,
        "send_precision": round(tp / max(tp + fp, 1), 3),
        "send_recall": round(tp / max(tp + fn, 1), 3),
        "misses": misses,
    }


def examples(rows):
    made = []
    for row in rows:
        for _ in range(OVERSAMPLE[row["route"]]):
            made.append((row["text"], "route", list(ROUTE["criteria"]).index(row["route"])))
        made.append((row["text"], "intent", list(INTENT["criteria"]).index(row["intent"])))
    return made


def run_epoch(agent, optimizer, made, cache):
    total = 0.0
    for index in np.random.permutation(len(made)):
        text, qid, target = made[int(index)]
        hidden, batch = cache[(text, qid)]
        total += train_step(agent.model, optimizer, hidden, batch, target)
    return total / max(len(made), 1)


def main():
    np.random.seed(7)
    train_rows, val_rows = build(per_template=6)
    val = [(r["text"], r["route"], r["intent"]) for r in val_rows]
    print(f"train {len(train_rows)}  val {len(val)}  test {len(TEST)}  probe {len(PROBE)}")

    agent = laya.load(MODEL_ID, dtype="float32")
    before = {"test": score(agent, TEST), "probe": score(agent, PROBE)}
    print("BEFORE", json.dumps({k: {x: y for x, y in v.items() if x != "misses"} for k, v in before.items()}), flush=True)

    optimizer = optim.Adam(learning_rate=LEARNING_RATE)
    made = examples(train_rows)
    started = time.perf_counter()
    cache = {}
    for text, qid, _target in made:
        if (text, qid) not in cache:
            cache[(text, qid)] = encode(agent, text, qid)
    print(f"encoded {len(cache)} sentence-question pairs in {time.perf_counter() - started:.0f}s", flush=True)
    best_val, best = -1.0, head_weights(agent.model)
    history = []
    for epoch in range(1, EPOCHS + 1):
        started = time.perf_counter()
        loss = run_epoch(agent, optimizer, made, cache)
        v = score(agent, val)
        # Wrong sends are the costly mistake (talking over a meeting), so they weigh double.
        val_score = v["route_acc"] - 2 * v["wrong_sends"] / max(v["n"], 1) + 0.5 * v["intent_acc"]
        history.append({"epoch": epoch, "loss": round(loss, 4), "val": {x: y for x, y in v.items() if x != "misses"},
                        "seconds": round(time.perf_counter() - started, 1)})
        print("epoch", history[-1], flush=True)
        if val_score >= best_val:
            best_val, best = val_score, head_weights(agent.model)

    restore(agent.model, best)
    after = {"test": score(agent, TEST), "probe": score(agent, PROBE)}
    print("AFTER", json.dumps({k: {x: y for x, y in v.items() if x != "misses"} for k, v in after.items()}))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    mx.save_safetensors(str(OUT_DIR / "head.safetensors"), best)
    (OUT_DIR / "metrics.json").write_text(json.dumps({
        "model": MODEL_ID, "trained": "decision head; encoder frozen", "epochs": EPOCHS,
        "train_examples": len(made), "before": before, "after": after, "history": history,
    }, indent=2) + "\n")
    print("saved", OUT_DIR)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("FAILED while training:")
        traceback.print_exc()
        raise SystemExit(1)
