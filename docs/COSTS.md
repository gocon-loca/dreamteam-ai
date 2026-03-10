# What DreamTeam Costs (and How to Keep It Affordable)

DreamTeam uses Claude (by Anthropic) to do the actual coding work. You pay for this in one of two ways.

## Your options

### Option 1: Claude Pro or Max subscription

If you already have a Claude subscription ($20/mo Pro or $100/mo Max), **Claude Code CLI can use your existing plan.** No API key needed — just run `claude` in your terminal and log in.

**Pro ($20/mo):**
- Includes a generous daily allowance of Claude usage
- Enough for 5-10 routine goals per day
- May hit daily limits during heavy overnight runs
- DreamTeam detects these limits and pauses automatically

**Max ($100/mo):**
- Much higher daily allowance
- Enough for most autonomous workflows
- Best value if you're running DreamTeam regularly

**How to set up:** Just run `claude` in your terminal and sign in with your Anthropic account. Claude Code will use your subscription automatically. No `ANTHROPIC_API_KEY` needed.

### Option 2: Anthropic API (pay-per-use)

Pay only for what you use. Get an API key from [console.anthropic.com](https://console.anthropic.com).

**Typical costs:**

| Model | Cost per goal | When used |
|-------|--------------|-----------|
| Claude Haiku | $0.05–0.30 | Routine goals (first attempt) |
| Claude Sonnet | $0.20–0.80 | Retry after Haiku fails |
| Claude Opus | $0.50–2.00 | Complex goals, final escalation |

**A typical overnight run** (10-20 goals across multiple projects) costs $5–15.

**How to set up:** Set `ANTHROPIC_API_KEY=sk-ant-...` in your environment before starting DreamTeam.

### Option 3: Other providers (coming soon)

DreamTeam currently works with Claude via the Claude Code CLI. Support for other model providers (OpenAI, open-source models via Ollama, etc.) depends on Claude Code CLI support for those providers. If Claude Code adds support for alternative backends, DreamTeam will automatically benefit.

For now, if you want to use other models:
- The Claude Code CLI is the execution engine — DreamTeam doesn't call models directly
- Check [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code) for the latest on provider support

## Budget controls

DreamTeam has built-in spending protection:

```
/budget 10        # Set daily budget to $10
/budget           # Check current spending
```

**Built-in protections:**
- **Daily budget cap** — stops dispatching when reached (default: $25/day)
- **Per-goal cost limit** — kills a goal if it's spending too much (default: $2 for routine, $5 for complex)
- **Circuit breakers** — pauses a project after 3 consecutive failures instead of retrying forever
- **Model ladder** — starts with the cheapest model, only escalates when needed
- **Session limit detection** — automatically pauses if you hit subscription daily limits

## Cost optimization tips

1. **Write good CLAUDE.md files** for your projects. The better the context, the more likely Haiku succeeds on the first try (cheapest).

2. **Use complexity tags.** Mark simple goals as `routine` — they start with Haiku (~$0.10) instead of Opus (~$1.00).

3. **Add TEST_COMMANDS** to goals. Explicit acceptance criteria catch failures before the expensive review agent runs.

4. **Set a daily budget** with `/budget`. Start low ($5-10) and increase as you see the value.

5. **Watch your digest.** The morning digest shows cost-per-goal. If some goals are expensive and failing, refine the goal description or split it up.
