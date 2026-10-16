#!/usr/bin/env python3
"""Synthetic layered-context simulator. Run with a Python that includes Tk."""

# Re-export model types for existing scripts importing the visualizer.
from compaction_model import (
    Settings, Summary, Operation, State, next_operation, commit,
    prepare, advance, simulate, Replay,
)

BG = "#101722"
PANEL = "#182331"
TEXT = "#e7edf5"
MUTED = "#98a9bc"
ACTIVE = "#57d9b1"
PREPARED = "#ffca73"
ARCHIVED = "#62758d"
GRID = "#2b394a"
ERROR = "#ff8c94"


def launch():
    import tkinter as tk
    from tkinter import ttk

    class App:
        def __init__(self, root):
            self.root = root
            root.title("Roleplay Engine · Compaction lab")
            root.geometry("1240x880")
            root.minsize(1000, 760)
            root.configure(bg=BG)
            self.settings = Settings()
            self.replay = Replay(self.settings)
            self.states = []
            self.regions = []
            self.updating = False
            self.redraw_job = None
            style = ttk.Style()
            style.theme_use("clam")
            style.configure("TScrollbar", background=GRID, troughcolor=BG, bordercolor=BG)

            header = tk.Frame(root, bg=BG)
            header.pack(fill="x", padx=26, pady=(20, 12))
            self.label(header, "COMPACTION LAB", 11, ACTIVE).pack(anchor="w")
            self.label(header, "How history becomes memory", 25).pack(anchor="w", pady=(5, 3))
            self.label(header, "Synthetic completed turns · 1,000 tokens each · no model calls", 12, MUTED).pack(anchor="w")

            settings_box = tk.Frame(root, bg=PANEL, padx=14, pady=12)
            settings_box.pack(fill="x", padx=26)
            self.fields = {}
            fields = [("target", "Input target", 32000), ("overhead", "Other input", 2000),
                      ("tail", "Min. tail L", 8), ("batch", "Turn batch B", 3),
                      ("summary_tokens", "Tokens / summary", 750),
                      ("group", "Promotion group", 3), ("retained", "Retain / level", 3)]
            for column, (key, name, value) in enumerate(fields):
                cell = tk.Frame(settings_box, bg=PANEL)
                cell.grid(row=0, column=column, sticky="ew", padx=(0, 13))
                settings_box.columnconfigure(column, weight=1)
                self.label(cell, name, 10, MUTED, PANEL).pack(anchor="w")
                var = tk.StringVar(value=str(value))
                entry = tk.Entry(cell, textvariable=var, width=10, bg=BG, fg=TEXT,
                                 insertbackground=TEXT, relief="flat", font=("Helvetica", 12))
                entry.pack(fill="x", ipady=6, pady=(5, 0))
                entry.bind("<Return>", lambda event: self.rebuild())
                self.fields[key] = var
            self.button(settings_box, "Apply", self.rebuild).grid(row=0, column=7, sticky="s")
            self.label(root, "Experimental promotion: greatest Uₖ / (S / 2ᵏ), deeper level wins ties. "
                       "Numeric settings are illustrative, not product defaults.", 10, MUTED).pack(anchor="w", padx=26, pady=(7, 12))

            control = tk.Frame(root, bg=BG)
            control.pack(fill="x", padx=26)
            self.turn_value = tk.IntVar(value=150)
            self.label(control, "Completed turns", 12).pack(side="left")
            self.turn_count = self.label(control, "150", 15, ACTIVE)
            self.turn_count.pack(side="right")
            self.turn_slider = self.scale(root, self.turn_value, 1, 1000, self.turn_changed)
            self.turn_slider.pack(fill="x", padx=26)

            navigation = tk.Frame(root, bg=BG)
            navigation.pack(fill="x", padx=26, pady=(8, 2))
            self.button(navigation, "|‹ Start", lambda: self.select(0)).pack(side="left")
            self.button(navigation, "‹ Back", lambda: self.select(self.step.get() - 1)).pack(side="left", padx=5)
            self.button(navigation, "Save next ›", lambda: self.select(self.step.get() + 1)).pack(side="left")
            self.button(navigation, "Finish ›|", lambda: self.select(len(self.states) - 1)).pack(side="left", padx=5)
            self.step_label = self.label(navigation, "", 11, MUTED)
            self.step_label.pack(side="left", padx=10)
            self.zoom = tk.BooleanVar(value=False)
            tk.Checkbutton(navigation, text="Zoom: readable turn ticks", variable=self.zoom,
                           command=self.draw, bg=BG, fg=TEXT, selectcolor=PANEL,
                           activebackground=BG, activeforeground=TEXT).pack(side="right")
            self.step = tk.IntVar(value=0)
            self.step_slider = self.scale(root, self.step, 0, 1, lambda value: self.draw())
            self.step_slider.pack(fill="x", padx=26)
            self.metrics = self.label(root, "", 12)
            self.metrics.pack(anchor="w", padx=26, pady=(8, 4))
            self.budget = tk.Canvas(root, height=8, bg=GRID, highlightthickness=0)
            self.budget.pack(fill="x", padx=26)
            self.status = self.label(root, "", 11, PREPARED)
            self.status.configure(wraplength=1150, justify="left")
            self.status.pack(anchor="w", padx=26, pady=(7, 4))

            chart = tk.Frame(root, bg=BG)
            chart.pack(fill="both", expand=True, padx=26, pady=(5, 0))
            self.canvas = tk.Canvas(chart, bg=BG, highlightthickness=0)
            xbar = ttk.Scrollbar(chart, orient="horizontal", command=self.canvas.xview)
            ybar = ttk.Scrollbar(chart, orient="vertical", command=self.canvas.yview)
            self.canvas.configure(xscrollcommand=xbar.set, yscrollcommand=ybar.set)
            self.canvas.grid(row=0, column=0, sticky="nsew")
            ybar.grid(row=0, column=1, sticky="ns")
            xbar.grid(row=1, column=0, sticky="ew")
            chart.rowconfigure(0, weight=1)
            chart.columnconfigure(0, weight=1)
            self.canvas.bind("<Configure>", self.resize)
            self.canvas.bind("<Motion>", self.inspect)
            self.canvas.bind("<Leave>", lambda event: self.inspector.configure(text=self.hint))
            legend = tk.Frame(root, bg=BG)
            legend.pack(fill="x", padx=26, pady=(10, 4))
            for title, color in [("● Active / sent verbatim or as summary", ACTIVE),
                                 ("● Prepared / next source batch", PREPARED),
                                 ("● Archived / retained beneath a summary", ARCHIVED)]:
                self.label(legend, title, 10, color).pack(side="left", padx=(0, 23))
            self.hint = "Hover a turn or summary to inspect its coverage. Dashed summaries are saved children, excluded from input."
            self.inspector = self.label(root, self.hint, 11, MUTED)
            self.inspector.pack(anchor="w", padx=26, pady=(3, 5))
            self.label(root, "Replay preserves saved promotions. Backward = earlier snapshot; Apply changed settings = restart replay. "
                       "Summary lengths are assumed, not measured quality.", 10, MUTED).pack(anchor="w", padx=26, pady=(0, 15))
            self.rebuild()

        def label(self, parent, text, size=12, color=TEXT, bg=BG):
            return tk.Label(parent, text=text, bg=bg, fg=color, font=("Helvetica", size))

        def button(self, parent, text, command):
            return tk.Button(parent, text=text, command=command, bg=PANEL, fg=TEXT,
                             highlightbackground=BG, activebackground=GRID, activeforeground=TEXT,
                             relief="flat", padx=10, pady=5, font=("Helvetica", 11))

        def scale(self, parent, variable, low, high, command):
            return tk.Scale(parent, variable=variable, from_=low, to=high, orient="horizontal",
                            resolution=1, showvalue=False, command=command, bg=BG, fg=MUTED,
                            troughcolor=GRID, highlightthickness=0, activebackground=ACTIVE,
                            sliderrelief="flat", sliderlength=18, bd=0)

        def turn_changed(self, value):
            if not self.updating:
                self.rebuild(apply_settings=False)

        def rebuild(self, apply_settings=True):
            try:
                settings = (Settings(**{key: int(var.get()) for key, var in self.fields.items()})
                            if apply_settings else self.settings)
                settings.validate()
                if settings != self.replay.settings:
                    self.replay = Replay(settings)
                states = self.replay.for_turn(self.turn_value.get())
            except ValueError as error:
                self.status.configure(text=f"Settings not applied: {error}", fg=ERROR)
                return
            self.settings, self.states = settings, states
            self.updating = True
            self.step_slider.configure(to=max(1, len(states) - 1))
            self.step.set(len(states) - 1)
            self.updating = False
            self.draw()

        def select(self, index):
            self.step.set(max(0, min(index, len(self.states) - 1)))
            self.draw()

        def resize(self, event):
            if self.redraw_job:
                self.root.after_cancel(self.redraw_job)
            self.redraw_job = self.root.after(30, self.draw)

        def draw(self):
            self.redraw_job = None
            if not self.states or self.updating:
                return
            index = min(self.step.get(), len(self.states) - 1)
            state, cfg = self.states[index], self.settings
            operation, explanation = next_operation(state, cfg)
            tokens = state.tokens(cfg)
            self.turn_count.configure(text=f"{state.turns:,} turns · {state.turns * 1000:,} raw tokens")
            self.step_label.configure(text=f"This turn: {index} / {len(self.states) - 1} saves")
            self.metrics.configure(text=f"INPUT  {tokens:,} / {cfg.target:,} tokens     ·     "
                                   f"{state.turns - state.archived} verbatim     ·     {state.archived} archived     ·     "
                                   f"{len(state.active)} active summaries     ·     {cfg.overhead:,} other input")
            blocked = operation is None and tokens > cfg.target
            if state.turns < self.turn_value.get():
                explanation = (f"Replay stops at turn {state.turns}; cannot reach {self.turn_value.get()}. "
                               + explanation)
            self.status.configure(text=explanation, fg=ERROR if blocked else PREPARED if operation else ACTIVE)
            self.budget.delete("all")
            bw = self.budget.winfo_width()
            self.budget.create_rectangle(0, 0, bw * min(1, tokens / cfg.target), 8,
                                         fill=ERROR if tokens > cfg.target else ACTIVE, outline="")
            c = self.canvas
            c.delete("all")
            self.regions = []
            # Reserve rows using the final state so stepping does not shift the timeline.
            levels = max(2, max((s.level for s in self.states[-1].summaries), default=0))
            width = max(c.winfo_width(), 150 + state.turns * 9) if self.zoom.get() else max(c.winfo_width(), 700)
            height = max(c.winfo_height(), 110 + levels * 58)
            c.configure(scrollregion=(0, 0, width, height))
            left, right, bottom = 106, width - 30, height - 65
            unit = (right - left) / state.turns
            x = lambda turn: left + (turn - 1) * unit
            for level in range(levels + 1):
                y = bottom - level * 58
                c.create_line(left, y, right, y, fill=GRID)
                c.create_text(12, y, text="TURNS" if level == 0 else f"LEVEL {level}",
                              anchor="w", fill=MUTED, font=("Helvetica", 10))
            active_ids = set(state.active)
            prepared_ids = set(operation.children) if operation else set()
            for summary in state.summaries:
                y = bottom - summary.level * 58
                a, b = x(summary.start), x(summary.end + 1)
                color = PREPARED if summary.id in prepared_ids else ACTIVE if summary.id in active_ids else ARCHIVED
                inactive = summary.id not in active_ids
                c.create_line(a, y, b - min(2, unit / 4), y, fill=color,
                              width=2 if inactive else 5, dash=(3, 3) if inactive else ())
                c.create_line(a, y - 5, a, y + 5, fill=color)
                c.create_line(b, y - 5, b, y + 5, fill=color)
                if b - a > 55:
                    c.create_text((a + b) / 2, y - 14, text=f"{summary.start}–{summary.end}",
                                  fill=color, font=("Helvetica", 9))
                status = "Prepared for promotion; still in input" if summary.id in prepared_ids else "Active in input" if not inactive else "Retained child; excluded from input"
                source = f"{len(summary.children)} L{summary.level - 1} summaries" if summary.children else f"{summary.end - summary.start + 1} original turns"
                self.regions.append((a, y - 20, b, y + 10,
                                     f"L{summary.level} · turns {summary.start}–{summary.end} · {source} · {cfg.summary_tokens:,} tokens · {status}"))
            if operation:
                y = bottom - operation.level * 58
                a, b = x(operation.start), x(operation.end + 1)
                c.create_rectangle(a, y - 8, b, y + 8, outline=PREPARED, dash=(4, 3))
                c.create_text((a + b) / 2, y + 20, text="next summary", fill=PREPARED, font=("Helvetica", 9))
            for turn in range(1, state.turns + 1):
                prepared = operation and operation.level == 1 and operation.start <= turn <= operation.end
                color = ARCHIVED if turn <= state.archived else PREPARED if prepared else ACTIVE
                tx = x(turn) + unit / 2
                c.create_line(tx, bottom - 9, tx, bottom + 9, fill=color, width=max(1, min(3, unit * .5)))
            self.turn_geometry = (left, right, bottom, unit, state, operation)
            # Sparse labels at any scale, while every turn still has its own tick.
            interval = max(1, round(state.turns / max(2, (right - left) / 85)))
            labels = sorted(set([1, state.turns] + list(range(interval, state.turns - interval // 2, interval))))
            for turn in labels:
                c.create_text(x(turn) + unit / 2, bottom + 24, text=str(turn), fill=MUTED, font=("Helvetica", 9))
            floor = min(state.turns, cfg.tail)
            if floor:
                a = x(state.turns - floor + 1)
                c.create_line(a, bottom + 42, right, bottom + 42, fill=ACTIVE, width=2)
                c.create_text(right, bottom + 54, text=f"minimum tail: {floor}", anchor="e", fill=ACTIVE, font=("Helvetica", 9))

        def inspect(self, event):
            px, py = self.canvas.canvasx(event.x), self.canvas.canvasy(event.y)
            for a, top, b, bottom, text in reversed(self.regions):
                if a <= px <= b and top <= py <= bottom:
                    self.inspector.configure(text=text)
                    return
            left, right, y, unit, state, operation = self.turn_geometry
            if left <= px < right and abs(py - y) < 15:
                turn = min(state.turns, int((px - left) / unit) + 1)
                status = "Archived; represented by an active summary" if turn <= state.archived else "Active; sent verbatim"
                if operation and operation.level == 1 and operation.start <= turn <= operation.end:
                    status = "Prepared for compaction; still sent verbatim until saved"
                self.inspector.configure(text=f"Turn {turn} · 1,000 tokens · {status}")
                return
            self.inspector.configure(text=self.hint)

    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    launch()
