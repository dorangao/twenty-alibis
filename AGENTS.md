# Twenty Alibis: instructions for coding agents

A bilingual murder mystery where every suspect is a Muse Ember agent. This repository is public.

## Rules that must hold in every change

1. **Code owns the truth; Ember only performs it.** A suspect's prompt never contains the hidden truth, other suspects' knowledge or undiscovered clues. The solver never reads the hidden truth. The accusation is scored by code.
2. **One model.** The product's AI uses only `muse-ember-1.0` through the Meta Model API. Do not add another AI provider or model as a dependency, a fallback or a helper.
3. **One way out.** Every model request goes through `createMetered()` in `src/metered.ts`. No other code may hold a model client. Requests are stateless inline text: no stored conversation ids, no file references, no hosted tools. No retries and no redirects. Each physical request carries a stable `attemptId` chosen by the caller, and each model turn after a tool call is a new request with its own id.
4. **Tests cost nothing.** No key and no model request in any test or workflow: the provider is always the fake one. `npm run check` and the default CI job use the in-memory store and no network. The durable store has its own job (`redis-store`) and its own command (`npm run test:redis`), which talk only to a throwaway Redis on the same machine.
5. **Nothing private in this repo.** Never commit `.env*` files, keys, raw usage traces, billing details or personal details. The settings template is `env.example`, with no values in it. Traces published here contain no prompt text, no reply text and no hidden solutions.
6. **Every user-facing string is bilingual:** English and Simplified Chinese.

## Working here

- One branch per change, a pull request per change, `npm run check` green before the pull request.
- Check `git status` first. Never switch a branch another agent has checked out; use your own worktree.
- Prefer changes whose result can be rechecked: a test, a solver verdict, a token count.
- A case is acceptable only if `checkCase()` accepts it. When you change the solver or the validator, the handwritten pair in `src/case/fixtures/archive.ts` must keep its verdicts: the pass case is accepted, the fail twin is refused.
