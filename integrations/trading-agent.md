# Memory for trading agents

A trading agent without memory repeats its mistakes every session. This recipe gives a trading agent (or a human trader working with one) a persistent journal-and-review loop on top of the standard memory system: raw trade logs go in, distilled pattern pages come out, and recall surfaces the relevant lesson the moment a similar setup appears in the conversation.

## What this is, and what it is not

This is **memory**: a structured journal, post-trade reviews, and distilled observations from your own trading history. It makes an agent disciplined and self-consistent.

It is **not prediction**. An LLM cannot simulate a market: there is no price impact, no slippage, no liquidity, and its training data leaks hindsight. Distilled pages describe patterns observed in *your own past trades*; treat every one of them as a hypothesis to verify with a real backtest on historical data before it touches capital. The distill prompt below enforces this framing: counted observations only, no predictive claims, no invented statistics.

## Directory layout

Follows the standard schema; no core changes needed.

```
agent-memory/
  sources/            raw trade journal entries (indexed, NOT injected by recall)
    trade-2026-07-04-eurusd-breakout.md
  entities/           one page per instrument or setup you trade
    eurusd.md
    setup-orb-breakout.md
  concepts/           distilled rules and regime notes (this is what recall injects)
    rule-no-entries-before-cpi.md
    pattern-orb-fails-in-chop.md
  summaries/          weekly/monthly reviews
    review-2026-w27.md
```

Raw journal entries live in `sources/` on purpose: they are indexed for the distiller but excluded from prompt recall, so a hundred trade logs never drown a conversation. The distilled `concepts/` pages are what the agent actually gets to see.

## Journal entry schema (sources/)

One file per trade, written by the agent (or you) right after close:

```markdown
---
type: trade
instrument: EURUSD
setup: orb-breakout
direction: long
opened: 2026-07-04T08:32Z
closed: 2026-07-04T11:05Z
r_multiple: -0.8
outcome: loss
tags: [orb-breakout, eurusd, news-day]
---

## Thesis
Opening-range breakout above 1.0842 after inside day; targeted 1R at prior high.

## Execution
Entered 3 minutes after the break. CPI release at 09:30 was on the calendar; ignored it.

## Outcome
Stopped out on the CPI spike, price then went to target without me.

## Note to self
The setup was fine, the timing filter was missing.
```

Frontmatter fields the distiller counts on: `setup`, `direction`, `r_multiple`, `outcome` (`win` | `loss` | `scratch`), `tags`. Everything else is free-form.

## The review loop

1. **Log**: after every closed trade the agent writes one `sources/trade-*.md` entry. Cheap, mechanical, no LLM needed.
2. **Distill**: on a schedule (or after every N trades), run the distiller with the trading prompt instead of the default one:

   ```bash
   DISTILL_PROMPT=scripts/distill-prompt-trading.md bash scripts/distill.sh
   # or set the prompt path the same way your install invokes distill.ps1
   ```

   The trading prompt (see `scripts/distill-prompt-trading.md`) reads recent journal entries and updates `concepts/` and `entities/` pages with *counted* observations: "orb-breakout on news days: 0 wins out of 4 this month (see [[trade-2026-07-04-eurusd-breakout]])". Never probabilities, never predictions.
3. **Recall**: next time the agent discusses an ORB entry on a CPI day, the standard recall hook injects `pattern-orb-fails-in-chop.md` or the news-day rule before the agent acts. That is the whole point: the lesson arrives at decision time, unprompted.
4. **Review**: weekly, distill a `summaries/review-<week>.md` rolling up R-totals per setup, rule violations, and open questions. These make the long-term drift visible.

## Recall examples

With a few weeks of journal history, these conversation fragments trigger useful injections:

- "thinking about a breakout long on EURUSD" surfaces `entities/eurusd.md` and any breakout-pattern concepts
- "there is a CPI print at 2:30" surfaces the news-day rule
- "why do I keep getting stopped out" surfaces the loss-pattern pages

## Guardrails, restated

- Distilled pages contain **counts from your own journal with source links**, never win-rate predictions or expected values.
- A pattern page is a **backtest candidate**, not a signal. The distill prompt writes this disclaimer into every pattern page it creates.
- Position sizing, risk limits and order execution belong in your trading system, not in memory. Memory informs; it never trades.
