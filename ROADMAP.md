# ROADMAP — DreamTeam

## Vision
A self-improving autonomous agent orchestration system that reliably ships quality code overnight, learns from its mistakes, and communicates effectively with the human operator.

## Current Phase
**Phase: Observability & Intelligence Upgrade** — Adding visual verification, feedback loops, smart model routing, and roadmap-driven goal planning to improve agent output quality and reduce wasted compute.

## Next Steps (priority order)
1. **[HIGH]** Research & strategy archetype — agents for patent research, competitive analysis, and strategy work (non-coding goals)
2. **[HIGH]** Optimizer agent v1 — weekly analysis of cost, success rates, and patterns to suggest configuration improvements
3. **[MEDIUM]** Content creation goals — leverage existing content pipelines for blog posts, summaries, newsletters
4. **[MEDIUM]** Fill in DESIGN.md files for projects with actual design tokens
5. **[LOW]** Screenshot hosting — upload visual verification screenshots to Linear/S3 for human review

## Tech Debt
- Test scripts use standalone assert pattern — consider migrating to a test framework
- Goals.json can grow unbounded — need periodic archival of old completed goals
- DESIGN.md files are still template stubs for some projects

## Blockers / At-Risk
- Agent quality depends heavily on goal spec quality — underspecified goals still produce poor results
- Rate limiting on Claude API can stall overnight runs

## Completed (recent)
- Phase 10: Feedback loops — human feedback affects model routing, cross-check corrects quality scores
- Phase 9: Visual verification protocol for frontend agents
- Phase 8: Sequential thinking per archetype
- Phase 7: Director Log to Linear
- Phase 6: DESIGN.md templates
