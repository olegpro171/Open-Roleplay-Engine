"""Stateful synthetic compaction strategy, independent of the visualizer.

The State is the simulation checkpoint, not a production storage schema. Actual
summary generation, tokenization, source revisions and transactions are not modeled.
"""

from dataclasses import dataclass, replace

TOKENS_PER_TURN = 1000


@dataclass(frozen=True)
class Settings:
    target: int = 32000
    overhead: int = 2000
    tail: int = 8
    batch: int = 3
    summary_tokens: int = 750
    group: int = 3
    retained: int = 3

    def validate(self):
        if self.target < 1 or self.overhead < 0 or self.tail < 0:
            raise ValueError("Target must be positive; overhead and minimum tail cannot be negative.")
        if self.batch < 1 or self.summary_tokens < 1 or self.group < 2 or self.retained < 0:
            raise ValueError("Batch and summary size must be positive; promotion group must be at least 2.")


@dataclass(frozen=True)
class Summary:
    id: int
    level: int
    start: int
    end: int
    children: tuple = ()


@dataclass(frozen=True)
class Operation:
    level: int
    start: int
    end: int
    children: tuple = ()

@dataclass(frozen=True)
class State:
    turns: int
    archived: int = 0
    summaries: tuple = ()
    active: tuple = ()

    def tokens(self, settings):
        return (settings.overhead + (self.turns - self.archived) * TOKENS_PER_TURN
                + len(self.active) * settings.summary_tokens)


def next_operation(state, settings):
    """Return (candidate, explanation). No mutation or actual model calls."""
    if state.tokens(settings) <= settings.target:
        return None, "Ready: the complete input fits the target. No further compaction."
    verbatim = state.turns - state.archived
    if verbatim >= settings.tail + settings.batch:
        if settings.summary_tokens >= settings.batch * TOKENS_PER_TURN:
            return None, "Blocked: the first-layer summary would provide no token savings."
        return Operation(1, state.archived + 1, state.archived + settings.batch), "Summarize the oldest full turn batch."
    required = settings.overhead + verbatim * TOKENS_PER_TURN
    if required > settings.target:
        return None, (f"Blocked: required verbatim turns + other input need {required:,} tokens; "
                      f"target is {settings.target:,}. No full turn batch can leave the minimum tail.")
    pool = settings.target - required
    if pool <= 0:
        return None, "Blocked: no space remains for summaries covering archived history."
    candidates = []
    for level in sorted({state.summaries[i].level for i in state.active}):
        layer = sorted((state.summaries[i] for i in state.active
                        if state.summaries[i].level == level), key=lambda s: s.start)
        if len(layer) < settings.group + settings.retained:
            continue
        children = layer[:settings.group]
        if any(a.end + 1 != b.start for a, b in zip(children, children[1:])):
            continue
        # U_k / (S / 2**k); on equal pressure prefer the deeper level.
        pressure = len(layer) * settings.summary_tokens * 2 ** level / pool
        operation = Operation(level + 1, children[0].start, children[-1].end,
                              tuple(s.id for s in children))
        candidates.append((pressure, level, operation))
    if not candidates:
        return None, "Blocked: no complete promotion batch satisfies the retained-summary floor."
    pressure, level, operation = max(candidates, key=lambda item: item[:2])
    return operation, f"Promote oldest L{level} batch: greatest eligible relative pressure ({pressure:.2f})."


def commit(state, operation):
    """Simulate a successfully saved summary, retaining every lower representation."""
    summary = Summary(len(state.summaries), operation.level, operation.start,
                      operation.end, operation.children)
    summaries = state.summaries + (summary,)
    active = tuple(sorted(
        tuple(i for i in state.active if i not in operation.children) + (summary.id,),
        key=lambda i: summaries[i].start,
    ))
    return State(state.turns, operation.end if operation.level == 1 else state.archived,
                 summaries, active)


def simulate(turns, settings):
    """Replay a growing chat; return preparation steps for the requested turn.

    For an existing chat use advance() with its committed State. A cold replay is
    deterministic but unnecessary when that state is available. Imported histories
    can explicitly use prepare(State(turns), settings); that is a different history
    of compaction decisions and is not a sequence of live requests.
    """
    return list(Replay(settings).for_turn(turns))


def prepare(state, settings):
    """Compact the existing representation only as necessary; never restore children."""
    settings.validate()
    states = [state]
    while True:
        operation, _ = next_operation(states[-1], settings)
        if operation is None:
            return states
        states.append(commit(states[-1], operation))


def advance(state, settings):
    """Append one synthetic completed turn to a previously prepared chat.

    Persist the returned final State between requests. Carry its cutoff, immutable
    saved summaries, and selected IDs forward; never choose a new tree from the
    transcript length. A blocked request must be repaired/retried before advancing.
    """
    settings.validate()
    if state.turns and state.tokens(settings) > settings.target:
        raise ValueError("The previous request is blocked; prepare it before adding another turn.")
    return prepare(replace(state, turns=state.turns + 1), settings)


class Replay:
    """Append one turn at a time, caching immutable per-request preparation steps."""

    def __init__(self, settings):
        settings.validate()
        self.settings = settings
        self.frames = []
        self.blocked_at = None

    def for_turn(self, turns):
        if not 1 <= turns <= 1000:
            raise ValueError("Select between 1 and 1,000 completed turns.")
        while len(self.frames) < turns and self.blocked_at is None:
            previous = self.frames[-1][-1] if self.frames else State(0)
            steps = tuple(advance(previous, self.settings))
            self.frames.append(steps)
            if steps[-1].tokens(self.settings) > self.settings.target:
                # A failed request cannot be skipped to reach a later, easier batch boundary.
                self.blocked_at = steps[-1].turns
        return self.frames[min(turns, len(self.frames)) - 1]
