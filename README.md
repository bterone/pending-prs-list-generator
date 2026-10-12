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
- ❌ **NEW:** Flags PRs with failing CI using the commit status and check-runs APIs
- 🧵 **NEW:** Distinguishes open vs resolved review threads via the GraphQL API (requires a token)

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

## Have some comments to fix :wrench:
- [API improvements](https://github.com/bterone/repo/pull/131) (5 comments)
- [UI enhancements](https://github.com/bterone/repo/pull/132) (3 comments)

## Broken CI :x:
- [Flaky integration test](https://github.com/bterone/repo/pull/134) (failed: build, e2e-tests)

## Need one more approval :white_check_mark:
- [Fix critical memory leak in hooks](https://github.com/bterone/repo/pull/125) (approved by user1)
- [Update dependencies](https://github.com/bterone/repo/pull/126) (approved by user2)

## Needs approvals from previous :sparkles: prolific :sparkles: commenters
- [Refactor authentication](https://github.com/bterone/repo/pull/127) (re-requested: user3)
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
2. **Have some comments to fix** 🔧 - Open (unresolved) review threads, and/or commenters who have not yet been re-requested
3. **Broken CI** ❌ - One or more failing status checks / check runs on the head commit
4. **Need one more approval** ✅ - PRs with exactly 1 approval (minimum target is 2). Ranks above prolific commenters
5. **Needs approvals from prolific commenters** ✨ - PRs where users with 2+ comments still need to approve
6. **Requires review** ✍️ - PRs with no approvals and nothing outstanding
7. **Needs merging** 🤪 - PRs with 2+ approvals and no blockers, just waiting to be merged (merged/closed PRs drop off automatically since only open PRs are fetched)
8. **Uncategorized** ❓ - Safety-net catch-all; normally empty

> **Note:** Open vs resolved review thread detection uses GitHub's GraphQL API and requires a `GITHUB_TOKEN`. Without a token, "comments to fix" falls back to the re-request heuristic only (a commenter who has not been re-requested for review).

## Supported Priority Labels

The script automatically detects these labels as high priority:
- "high priority" or "high-priority"
- "priority : high"
- "urgent"
- "critical"

## Environment Variables

- `GITHUB_TOKEN` - GitHub personal access token. Recommended for higher rate limits and private repos, and **required** to detect resolved vs open review threads (the GraphQL API does not allow anonymous access)

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
