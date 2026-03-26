---
name: create-pr
description: Create a GitHub pull request from the current branch with a well-structured title and summary. Use this skill whenever the user wants to open a PR, create a pull request, submit their branch for review, "open a PR", "make a PR", "submit a pull request", or any variant of creating a GitHub PR. Trigger even for casual phrasing like "PR this" or "can you open a PR for me".
---

# Create PR

This skill handles creating a well-structured GitHub pull request using the `gh` CLI.

## Workflow

### Step 1: Understand what's going into the PR

Run these in parallel:
- `git status` — confirm the working tree is clean (if not, suggest committing first)
- `git log --oneline main..HEAD` — see all commits that will be in the PR
- `git diff main...HEAD` — see the full diff from the base branch
- `gh pr list --state open` — check if a PR already exists for this branch

If there are uncommitted changes, ask the user if they want to commit them first (or invoke the `commit-and-push` skill).

### Step 2: Determine the base branch

Default base branch is `main`. If the repo uses `master` or a different convention, detect it from `git remote show origin` or `gh repo view`.

### Step 3: Push the branch if needed

Check if the branch is pushed to remote:
```bash
git rev-parse --abbrev-ref --symbolic-full-name @{u}
```

If there's no upstream, push first:
```bash
git push -u origin <branch-name>
```

### Step 4: Write the PR title and body

**Title:**
- Short (under 70 characters), imperative, descriptive
- Should complete the sentence: "This PR will..."
- Match the repo's existing PR title style (check with `gh pr list --limit 5`)

**Body structure:**
```markdown
## Summary
- What this PR does (2-4 bullet points)
- Why it's needed

## Changes
- List significant files or components changed
- Call out any breaking changes or migration steps

## Test plan
- [ ] How to verify the changes work
- [ ] Any edge cases to test
- [ ] Manual testing steps if automated tests aren't sufficient

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Tailor the body to the size and nature of the change — a one-line bug fix doesn't need an elaborate test plan, but a new feature or refactor does.

### Step 5: Create the PR

```bash
gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
...

## Test plan
...

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

If the user wants a draft PR (not ready for review yet):
```bash
gh pr create --draft --title "..." --body "..."
```

### Step 6: Confirm

Report the PR URL back to the user so they can open it.

## Things to watch for

- **Sensitive files in diff**: If the diff contains `.env`, credentials, secrets, or large binaries, warn the user before creating the PR.
- **PR already exists**: If a PR is already open for this branch, show it to the user and ask if they want to update it instead.
- **No commits ahead of main**: If the branch has no new commits, explain the situation and don't create an empty PR.
- **No `gh` CLI**: If `gh` isn't available or authenticated, tell the user to run `gh auth login` first.

## Example PR titles

- `Add email verification to signup flow`
- `Fix race condition in payment processing`
- `Refactor auth middleware to use JWT`
- `feat: support dark mode across all pages`
