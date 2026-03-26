---
name: review-pr
description: Review a GitHub pull request by fetching its diff, comments, and context, then providing structured feedback on code quality, bugs, and improvements. Use this skill whenever the user wants to review a PR, get feedback on a pull request, "review this PR", "look at PR #123", "check this pull request", "give feedback on a PR", or any variant of reviewing GitHub PRs. Also trigger when the user pastes a GitHub PR URL and asks for thoughts or a review.
---

# Review PR

This skill fetches a pull request's diff and context, then provides thorough, structured code review feedback.

## Workflow

### Step 1: Identify the PR

The user will typically provide:
- A PR number: `#123`
- A URL: `https://github.com/owner/repo/pull/123`
- A description: "the auth PR" (in which case, list open PRs to find it)

If no PR is specified, list recent open PRs:
```bash
gh pr list --limit 10
```

### Step 2: Fetch PR context

Run these in parallel:
```bash
# PR metadata, description, and status
gh pr view <number> --json title,body,author,baseRefName,headRefName,state,labels,reviewDecision,checks

# The diff
gh pr diff <number>

# Existing review comments
gh pr view <number> --json comments,reviews
```

Also fetch the PR's files list to understand scope:
```bash
gh pr view <number> --json files
```

### Step 3: Read the code deeply

Don't skim. For each changed file:
- Understand what the code *was* doing before
- Understand what it's doing *now*
- Consider whether the change achieves what the PR description says

For larger PRs, read the diff in logical chunks — start with core logic changes, then tests, then config/docs.

### Step 4: Structure your review

Organize feedback into these categories:

#### Bugs and correctness issues
Things that are wrong and will cause failures, data corruption, or incorrect behavior. Be specific about *why* it's a bug and what the impact is.

#### Security concerns
Injection vulnerabilities, authentication bypasses, exposed secrets, insufficient input validation, insecure defaults. Flag these prominently.

#### Logic and design
- Does the approach make sense for the problem?
- Are there simpler ways to achieve the same result?
- Does it handle edge cases?
- Is error handling appropriate?

#### Code quality
- Readability: Is it clear what the code does?
- Naming: Are variables, functions, classes named well?
- Duplication: Is there unnecessary repetition?
- Dead code: Is anything unused or unreachable?

#### Tests
- Are there tests for the new behavior?
- Do tests cover edge cases and failure paths?
- Are existing tests still valid?

#### Nits (optional, low-priority)
Minor style suggestions, typos, formatting. Label these clearly as "Nit:" so the author knows they're optional.

### Step 5: Write the review

**Format:**

```
## Summary
[1-3 sentences: what the PR does, overall impression, whether it's ready to merge]

**Verdict:** ✅ Approve / 🔄 Request changes / 💬 Comments only

---

## Issues

### [Critical/Major/Minor] Issue title
**File:** `path/to/file.ts:42`
**Problem:** What's wrong and why it matters
**Suggestion:** How to fix it (include a code snippet if helpful)

---

## Suggestions (non-blocking)
- ...

## Nits
- ...

## What's good
[Acknowledge what's done well — this helps the author learn and builds good collaboration]
```

**Tone:**
- Be direct but constructive. "This will cause a null pointer exception when X is empty" not "This might have issues."
- Explain *why* something is a problem, not just that it is.
- Separate blockers from nice-to-haves clearly.
- Acknowledge good work — a review that's all criticism is demoralizing and less useful.

### Step 6: Post the review (if requested)

If the user wants to post the review to GitHub:
```bash
# Approve
gh pr review <number> --approve --body "..."

# Request changes
gh pr review <number> --request-changes --body "..."

# Comment only
gh pr review <number> --comment --body "..."
```

Ask the user if they want the review posted, or just want the analysis in the conversation.

## What makes a great review

- **Prioritize clearly.** A PR with 20 comments where everything looks equally important is overwhelming. Mark things as blocking vs. optional.
- **Be specific.** "This function is too long" is less useful than "This function does three things — fetching, transforming, and saving. Splitting it would make each part testable independently."
- **Show, don't just tell.** When suggesting a fix, show a code snippet. It's faster for the author and removes ambiguity.
- **Consider the author's perspective.** If a change looks odd, ask a clarifying question before assuming it's wrong — there may be context you're missing.
- **Check the PR description.** If the PR says "this fixes bug X", verify that it actually fixes it, and that it doesn't introduce new bugs doing so.

## Checklist for every review

- [ ] Does the code do what the PR description says?
- [ ] Are there any obvious bugs or logic errors?
- [ ] Is input validation present where data comes from outside the system?
- [ ] Are there tests? Do they cover the happy path and failure cases?
- [ ] Are there any hardcoded secrets, credentials, or environment-specific values?
- [ ] Will this change break anything that depends on the modified interfaces?
- [ ] Is there anything in the diff that looks unrelated to the stated goal?
