---
name: commit-and-push
description: Stage all changes, create a descriptive commit, and push to the remote branch. Use this skill whenever the user wants to commit their work, save changes to git, stage and push, "commit everything", "push my changes", "save and push", or any variant of committing and/or pushing code. Trigger even if the user just says "commit" or "push" in the context of git work.
---

# Commit and Push

This skill handles the full git commit-and-push workflow: reviewing what changed, writing a meaningful commit message, and pushing to the remote.

## Workflow

### Step 1: Understand the current state

Run these in parallel:
- `git status` — see what files changed (never use `-uall`)
- `git diff` — see the actual changes (staged and unstaged)
- `git log --oneline -5` — learn the commit message style used in this repo

Read the diff carefully. You need to understand *what* changed before writing a commit message about it.

### Step 2: Stage changes

Stage specific files rather than blindly using `git add .` or `git add -A`. This avoids accidentally committing `.env` files, secrets, large binaries, or generated files that shouldn't be tracked.

If you notice files that look like they shouldn't be committed (secrets, credentials, build artifacts), flag them to the user before staging.

### Step 3: Write the commit message

A good commit message:
- Uses the imperative mood: "Add feature" not "Added feature"
- Leads with the *why* or *what*, not the *how*
- Follows the repo's existing style (check `git log`)
- Is concise for simple changes; includes a body for complex ones

Common prefixes (use if the repo already uses them):
- `feat:` — new feature
- `fix:` — bug fix
- `chore:` — maintenance, deps, tooling
- `refactor:` — restructuring without behavior change
- `docs:` — documentation only
- `test:` — test changes

Always pass the commit message via heredoc to preserve formatting:
```bash
git commit -m "$(cat <<'EOF'
feat: add user authentication with JWT

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

Include `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>` in the commit.

### Step 4: Push

```bash
git push
```

If the branch has no upstream yet:
```bash
git push -u origin <branch-name>
```

If push fails because the remote has new commits, pull first:
```bash
git pull --rebase && git push
```

### Step 5: Confirm

After pushing, run `git status` and report the result to the user — confirming the branch is clean and the push succeeded.

## Safety checks

- **Never force push** to main/master. Warn the user if they request it.
- **Never skip hooks** (`--no-verify`) unless the user explicitly asks.
- **Never amend** a previous commit unless explicitly requested. If a pre-commit hook fails, fix the issue and create a new commit.
- If there's nothing to commit (clean working tree), tell the user — don't create an empty commit.

## Example outputs

**Good commit messages:**
- `fix: prevent crash when user list is empty`
- `feat(auth): add OAuth2 login flow`
- `chore: upgrade dependencies to latest versions`
- `refactor: extract payment logic into dedicated service`

**Bad commit messages:**
- `fix stuff`
- `WIP`
- `changes`
- `update`
