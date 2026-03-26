---
name: create-branch
description: Create a new git branch with a descriptive, contextually appropriate name based on the current work. Use this skill whenever the user wants to create a branch, start new work on a branch, "branch this", "make a branch for X", "create a feature branch", "spin up a branch", or any variant of creating a git branch. Trigger even for casual phrasing like "can you branch this?" or "I need a new branch".
---

# Create Branch

This skill creates a new git branch with a well-named, descriptive identifier derived from the current work context — what's changed, what the user is building, or what they've described in the conversation.

## Workflow

### Step 1: Gather context

Run these in parallel to understand what work is happening:
- `git status` — see what's changed or in progress
- `git branch --show-current` — know what branch you're on now
- `git log --oneline -5` — see recent commit history for naming style cues

Also consider what the user has said in the conversation — if they described a task, bug, or feature, that's the richest signal for the branch name.

### Step 2: Propose a branch name

Craft a branch name that:
- Uses **kebab-case** (all lowercase, words separated by hyphens)
- Starts with a **type prefix** matching the nature of the work:
  - `feature/` or `feat/` — new functionality
  - `fix/` — bug fixes
  - `chore/` — maintenance, tooling, deps
  - `refactor/` — restructuring without behavior change
  - `docs/` — documentation only
  - `experiment/` — exploratory or uncertain work
- Is **specific but concise** — aim for 3-6 words after the prefix
- Reflects *what* is being built, not *how*

If the repo already has branches with a consistent naming convention (check `git branch -a`), match that convention.

**Example mapping:**
- "I'm adding OAuth login" → `feature/oauth-login`
- "fix the crash when user list is empty" → `fix/empty-user-list-crash`
- "upgrade dependencies" → `chore/upgrade-dependencies`
- "refactor the payment service" → `refactor/payment-service`
- Unstaged changes to `auth/login.py` and `auth/tokens.py` → `feature/auth-token-handling`

### Step 3: Confirm if the name isn't obvious

If the context is **clear** (user stated the purpose, or the diff makes it obvious), just create the branch and tell the user what you named it.

If the context is **ambiguous** (no changes, no description, vague request), propose the name first and ask for a quick confirmation or correction before creating it. Keep this lightweight — one line, not a whole back-and-forth.

### Step 4: Create and switch to the branch

```bash
git switch -c <branch-name>
```

Or if `git switch` isn't available (older Git):
```bash
git checkout -b <branch-name>
```

### Step 5: Confirm

Tell the user the branch was created and they're now on it. One sentence is enough.

## Edge cases

- **Already on a feature branch**: If the user is already on a non-main branch, note it and ask if they want to branch off of it or switch back to main first.
- **Branch name already exists**: If the name collides, append a short suffix (e.g., `-2`) or ask the user.
- **No git repo**: Tell the user `git init` is needed first.
- **User provides a name explicitly**: Use it as-is — don't second-guess explicit names.

## Good branch name examples

- `feature/user-profile-avatar-upload`
- `fix/login-redirect-loop`
- `chore/remove-deprecated-api-calls`
- `refactor/split-auth-middleware`
- `docs/add-api-reference`
- `experiment/llm-summarization-pipeline`

## Bad branch name examples

- `my-branch` — not descriptive
- `fix` — too vague
- `WIP` — not a name
- `dev-2025-03-26` — date-based names age poorly
- `FEATURE_USER_AUTH` — wrong case convention
