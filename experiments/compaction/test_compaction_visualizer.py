import unittest
from copy import deepcopy
from dataclasses import replace
from compaction_model import Settings, State, Summary, next_operation, simulate, prepare, advance, Replay


class CompactionTests(unittest.TestCase):
    def assert_coverage(self, state):
        cursor = 1
        for start, end in sorted((state.summaries[i].start, state.summaries[i].end) for i in state.active):
            self.assertEqual(start, cursor, "Active coverage must not overlap or leave gaps")
            cursor = end + 1
        self.assertEqual(cursor, state.archived + 1)
        self.assertLessEqual(state.archived, state.turns)

    def test_all_slider_values(self):
        cfg = Settings()
        replay = Replay(cfg)
        for turns in range(1, 1001):
            final = replay.for_turn(turns)[-1]
            self.assertEqual(final.turns, turns)
            self.assertLessEqual(final.tokens(cfg), cfg.target)
            self.assertGreaterEqual(turns - final.archived, min(turns, cfg.tail))
            self.assert_coverage(final)
            for summary in final.summaries:
                if summary.level == 1:
                    self.assertEqual(summary.end - summary.start + 1, cfg.batch)
                else:
                    children = [final.summaries[i] for i in summary.children]
                    self.assertEqual(len(children), cfg.group)
                    self.assertTrue(all(s.level == summary.level - 1 for s in children))
                    self.assertEqual((summary.start, summary.end), (children[0].start, children[-1].end))
                    self.assertTrue(all(a.end + 1 == b.start for a, b in zip(children, children[1:])))

    def test_intermediate_coverage_and_retention(self):
        states = prepare(State(1000), Settings())
        for before, after in zip(states, states[1:]):
            self.assert_coverage(before)
            self.assert_coverage(after)
            self.assertEqual(after.summaries[:-1], before.summaries)
            self.assertIn(after.summaries[-1].id, after.active)
            self.assertLess(after.tokens(Settings()), before.tokens(Settings()))
        self.assertGreaterEqual(max(s.level for s in states[-1].summaries), 3)

    def test_budget_trigger_and_stop(self):
        self.assertEqual(len(simulate(30, Settings())), 1)
        states = simulate(31, Settings())
        self.assertEqual(len(states), 2)
        self.assertEqual(states[-1].archived, 3)
        self.assertEqual(states[-1].tokens(Settings()), 30750)

    def test_fixed_batch_residual_failure(self):
        cfg = Settings(tail=100, batch=3, target=101000, overhead=0)
        states = simulate(102, cfg)
        self.assertEqual(len(states), 1)
        self.assertIn("Blocked", next_operation(states[-1], cfg)[1])
        # An imported 103-turn transcript can fit; a live chat cannot skip the
        # failed 102nd request just to reach that more convenient batch boundary.
        self.assertEqual(simulate(103, cfg)[-1].turns, 102)
        rescued = prepare(State(103), cfg)[-1]
        self.assertEqual(rescued.archived, 3)
        self.assertLessEqual(rescued.tokens(cfg), cfg.target)

    def test_deeper_level_can_win_pressure_selection(self):
        summaries = tuple(Summary(i, 2, i * 9 + 1, (i + 1) * 9) for i in range(6))
        summaries += tuple(Summary(i + 6, 1, 55 + i * 3, 57 + i * 3) for i in range(6))
        state = State(80, 72, summaries, tuple(range(12)))
        operation, _ = next_operation(state, Settings(target=16000))
        self.assertEqual(operation.level, 3)
        self.assertEqual(operation.children, (0, 1, 2))

    def test_nonshrinking_summary_and_retained_floor_fail(self):
        cfg = Settings(summary_tokens=3000)
        states = simulate(40, cfg)
        self.assertEqual(len(states), 1)
        self.assertIn("no token savings", next_operation(states[-1], cfg)[1])
        cfg = Settings(retained=1000)
        final = simulate(1000, cfg)[-1]
        self.assertIn("retained-summary floor", next_operation(final, cfg)[1])
        self.assert_coverage(final)

    def test_required_input_and_zero_summary_pool(self):
        cfg = Settings(target=1000, overhead=2000)
        self.assertIn("Blocked", next_operation(simulate(1, cfg)[-1], cfg)[1])
        cfg = Settings(target=10000, overhead=2000)
        final = prepare(State(11), cfg)[-1]
        self.assertEqual(final.archived, 3)
        self.assertIn("no space", next_operation(final, cfg)[1])

    def test_invalid_configuration(self):
        for cfg in [Settings(target=0), Settings(batch=0), Settings(group=1), Settings(retained=-1)]:
            with self.assertRaises(ValueError):
                simulate(100, cfg)
        with self.assertRaises(ValueError):
            simulate(1001, Settings())

    def represented_levels(self, state):
        levels = [0] * state.turns
        for i in state.active:
            summary = state.summaries[i]
            levels[summary.start - 1:summary.end] = [summary.level] * (summary.end - summary.start + 1)
        return levels

    def test_no_demotions_or_reactivated_children_across_batch_cycles(self):
        for cfg in (Settings(), Settings(batch=5, tail=12, group=2, retained=1),
                    Settings(batch=1, tail=2, group=4, retained=0)):
            previous = State(0)
            retired = set()
            for turn in range(1, 1001):
                steps = advance(previous, cfg)
                final = steps[-1]
                self.assertEqual(final.turns, turn)
                self.assertLessEqual(final.tokens(cfg), cfg.target)
                self.assertGreaterEqual(final.archived, previous.archived)
                self.assertEqual(final.summaries[:len(previous.summaries)], previous.summaries)
                self.assertFalse(retired.intersection(final.active))
                retired.update(set(previous.active) - set(final.active))
                for before, after in zip(self.represented_levels(previous), self.represented_levels(final)):
                    self.assertGreaterEqual(after, before)
                for state in steps:
                    self.assert_coverage(state)
                    starts = [state.summaries[i].start for i in state.active]
                    self.assertEqual(starts, sorted(starts))
                previous = final

    def test_301_to_302_regression_and_resume_without_replay_cache(self):
        cfg = Settings()
        replay = Replay(cfg)
        saved = replay.for_turn(301)[-1]
        resumed = advance(deepcopy(saved), cfg)[-1]
        self.assertEqual(resumed, replay.for_turn(302)[-1])
        for before, after in zip(self.represented_levels(saved), self.represented_levels(resumed)):
            self.assertGreaterEqual(after, before)
        self.assertEqual(simulate(302, cfg)[-1], resumed)
        replay.for_turn(1000)
        self.assertEqual(replay.for_turn(301)[-1], saved)
        self.assertEqual(replay.for_turn(302)[-1], resumed)

    def test_slack_keeps_selected_summary_ids_exactly(self):
        cfg = Settings()
        state = simulate(302, cfg)[-1]
        # Less other input frees capacity but must not expand saved children.
        looser = replace(cfg, overhead=0)
        self.assertEqual(prepare(state, looser), [state])
        incoming = replace(state, turns=state.turns + 1)
        self.assertLessEqual(incoming.tokens(looser), looser.target)
        self.assertEqual(advance(state, looser), [incoming])

    def test_pressure_then_relief_does_not_undo_promotions(self):
        cfg = Settings()
        state = simulate(300, cfg)[-1]
        tighter = replace(cfg, target=state.tokens(cfg) - 1500)
        compacted = prepare(state, tighter)[-1]
        self.assertLessEqual(compacted.tokens(tighter), tighter.target)
        self.assertNotEqual(compacted.active, state.active)
        self.assertEqual(prepare(compacted, cfg), [compacted])

    def test_blocked_request_cannot_be_skipped(self):
        cfg = Settings(tail=100, batch=3, target=101000, overhead=0)
        replay = Replay(cfg)
        blocked = replay.for_turn(1000)[-1]
        self.assertEqual(replay.blocked_at, 102)
        self.assertEqual(blocked.turns, 102)
        with self.assertRaisesRegex(ValueError, "previous request is blocked"):
            advance(blocked, cfg)
        self.assertEqual(prepare(blocked, cfg), [blocked])


if __name__ == "__main__":
    unittest.main()
