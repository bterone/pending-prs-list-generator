# PR Markdown Generator

A Node.js script that fetches pull requests from one or multiple GitHub repositories and generates a unified markdown file with organized listings, prioritizing high-priority PRs.

## Features

- 🔍 Fetches all open pull requests from any GitHub repository
- 🚨 Automatically prioritizes PRs with "high priority", "urgent", or "critical" labels
- 📝 Generates clean markdown with clickable PR titles
- 🔄 Handles pagination for repositories with many PRs
- 🔐 Supports GitHub token authentication for higher rate limits
- 🔀 Supports multiple repositories - combines PRs from all repos into unified categories
- 📊 Categorizes PRs by review status (needs approval, has comments to fix, etc.)
- ❌ Flags PRs with failing CI using the commit status and check-runs APIs
- 🧵 Distinguishes open vs resolved review threads via the GraphQL API (requires a token)
- 🤪 **NEW:** Reminds you about your own unsubmitted draft (pending) reviews

## Installation

```bash
yarn install
```

## Usage

### Basic Usage

#### Single Repository

```bash
# Using owner/repo format
node pr-generator.js bterone/pending-prs-list-generator

# Using GitHub URL
node pr-generator.js https://github.com/bterone/pending-prs-list-generator

# Specify custom output file
node pr-generator.js owner/repo --output my-custom-prs.md

# If .env file is provided
node --env-file=.env pr-generator.js https://github.com/bterone/pending-prs-list-generator
```

#### Multiple Repositories

```bash
# Combine PRs from multiple repositories
node pr-generator.js owner/repo1 owner/repo2 owner/repo3

# Mix different URL formats
node pr-generator.js owner/repo1 https://github.com/bterone/pending-prs-list-generator

# Specify custom output file for multiple repos
node pr-generator.js owner/repo1 owner/repo2 --output combined-prs.md
```

When using multiple repositories, all PRs are combined into unified categories regardless of which repository they came from. The PR links will correctly point to their respective repositories.

### With GitHub Token (Recommended)

For higher rate limits and access to private repositories:

```bash
export GITHUB_TOKEN=your_github_token_here
node pr-generator.js your-org/your-repo
```

### Example Output

#### Single Repository

```markdown
# Pull Requests for bterone/pending-prs-list-generator

Generated on: 2025-01-15
Total PRs: 45

## High Priority :rotating_light:
- [Critical bug fix](https://github.com/bterone/repo/pull/123) (needs review)
- [Security patch](https://github.com/bterone/repo/pull/124) (ready to merge)

## Review pending comments (Reminder for me :zany_face:)
- [Refactor billing module](https://github.com/bterone/repo/pull/136) (2 pending comments)

## Broken CI :x:
- [Flaky integration test](https://github.com/bterone/repo/pull/134) (failed: build, e2e-tests)

## Have some comments to fix :wrench:
- [API improvements](https://github.com/bterone/repo/pull/131) (5 open threads)
- [UI enhancements](https://github.com/bterone/repo/pull/132) (3 open threads)

## Need one more approval :white_check_mark:
- [Fix critical memory leak in hooks](https://github.com/bterone/repo/pull/125) (approved by user1)
- [Update dependencies](https://github.com/bterone/repo/pull/126) (approved by user2)

## Needs approvals from previous :sparkles: prolific :sparkles: commenters
- [Add new feature](https://github.com/bterone/repo/pull/128) (waiting for: user4)

## Requires review :writing_hand:
- [Documentation update](https://github.com/bterone/repo/pull/129)
- [Code cleanup](https://github.com/bterone/repo/pull/130)

## Needs merging (Reminder for me :zany_face:)
- [Performance optimization](https://github.com/bterone/repo/pull/133) (2 approvals)

## Uncategorized :grey_question:
- [Edge case not matched by any rule](https://github.com/bterone/repo/pull/135)
```

#### Multiple Repositories

```markdown
# Pull Requests Summary

Generated on: 2025-01-15
Repositories: 3
Total PRs: 87

## High Priority :rotating_light:
- [Critical bug in repo1](https://github.com/bterone/repo1/pull/123) (needs review)
- [Security fix in repo2](https://github.com/bterone/repo2/pull/456) (ready to merge)
- [Urgent update in repo3](https://github.com/bterone/repo3/pull/789) (needs one more approval)

## Need one more approval :white_check_mark:
- [Feature from repo1](https://github.com/bterone/repo1/pull/124) (approved by user1)
- [Fix from repo2](https://github.com/bterone/repo2/pull/457) (approved by user2)
...
```

Note: When using multiple repositories, PRs from all repos are combined into unified categories. Each PR link correctly points to its source repository.

## PR Categories

The script organizes PRs into the following categories. A PR lands in the **first** category it matches (priority order):

1. **High Priority** 🚨 - PRs with priority labels (urgent, critical, high priority)
2. **Review pending comments** 🤪 - You have an unsubmitted draft (pending) review on the PR - a reminder to finish and submit it
3. **Broken CI** ❌ - One or more failing status checks / check runs on the head commit (latest run per check only; superseded/cancelled runs are ignored)
4. **Have some comments to fix** 🔧 - An unresolved review thread whose reviewer has **not** been re-requested, so the ball is in the author's court
5. **Need one more approval** ✅ - PRs with exactly 1 approval (minimum target is 2). Ranks above prolific commenters
6. **Needs approvals from prolific commenters** ✨ - Someone with 2+ comments hasn't approved and isn't currently re-requested (excludes you and anyone whose re-review is already pending)
7. **Requires review** ✍️ - Fewer than 2 approvals with nothing outstanding: no comments, or all threads resolved, or the reviewers have been re-requested. Effectively your review queue
8. **Needs merging** 🤪 - PRs with 2+ approvals and no blockers, just waiting to be merged (merged/closed PRs drop off automatically since only open PRs are fetched)
9. **Uncategorized** ❓ - Safety-net catch-all; normally empty

The key distinction between **Have some comments to fix** and **Requires review** is *whose court the ball is in*: an open thread whose reviewer has not been re-requested means the author still owes a response (comments to fix), whereas a resolved thread or a re-requested reviewer means it's back to the reviewers (requires review).

> **Note:** Review-thread resolution and the "Review pending comments" reminder use GitHub's GraphQL/authenticated API and require a `GITHUB_TOKEN`. Without a token, "comments to fix" falls back to a re-request heuristic only (any commenter not currently re-requested), and draft-review reminders are unavailable. Team review requests are not expanded into individual members, so a reviewer requested only via a team is not counted as re-requested.

## Supported Priority Labels

The script automatically detects these labels as high priority:
- "high priority" or "high-priority"
- "priority : high"
- "urgent"
- "critical"

## Environment Variables

- `GITHUB_TOKEN` - GitHub personal access token. Recommended for higher rate limits and private repos, and **required** to detect resolved vs open review threads and your own pending draft reviews (the GraphQL API does not allow anonymous access)

## Requirements

- Node.js 12 or higher
- Internet connection
- Optional: GitHub personal access token for higher rate limits

## Command Line Options

- `--output` or `-o` - Specify custom output filename
- `--help` or `-h` - Display help information

## Output Files

- Single repository: `owner-repo-prs.md`
- Multiple repositories: `combined-prs-YYYY-MM-DD.md`
- Custom: Whatever you specify with `--output`
