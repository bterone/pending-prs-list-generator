# PR Markdown Generator

A Node.js script that fetches pull requests from a GitHub repository and generates a markdown file with organized listings, prioritizing high-priority PRs.

## Features

- 🔍 Fetches all open pull requests from any GitHub repository
- 🚨 Automatically prioritizes PRs with "high priority", "urgent", or "critical" labels
- 📝 Generates clean markdown with clickable PR titles
- 👤 Includes author information, creation dates, and labels
- 🔄 Handles pagination for repositories with many PRs
- 🔐 Supports GitHub token authentication for higher rate limits

## Installation

```bash
yarn install
```

## Usage

### Basic Usage

```bash
# Using owner/repo format
node pr-generator.js bterone/pending-prs-list-generator

# Using GitHub URL
node pr-generator.js https://github.com/bterone/pending-prs-list-generator

# Specify custom output file
node pr-generator.js owner/repo my-custom-prs.md
```

### With GitHub Token (Recommended)

For higher rate limits and access to private repositories:

```bash
export GITHUB_TOKEN=your_github_token_here
node pr-generator.js your-org/your-repo
```

### Example Output

The generated markdown will look like:

```markdown
# Pull Requests for facebook/react

Generated on: 2025-01-15
Total PRs: 45

## Need one more approval :white_check_mark:

- [Fix critical memory leak in hooks](PR_URL) - #ISSUENUMBER
- [Fix critical memory leak in hooks](PR_URL) - #ISSUENUMBER

## Needs approvals from previous :sparkles: prolific :sparkles: commenters
- [Fix critical memory leak in hooks](PR_URL) - #ISSUENUMBER
- [Fix critical memory leak in hooks](PR_URL) - #ISSUENUMBER

## Requires review :writing_hand:
- [Fix critical memory leak in hooks](PR_URL) - #ISSUENUMBER
- [Fix critical memory leak in hooks](PR_URL) - #ISSUENUMBER

## Have some comments to fix :wrench:
- [Fix critical memory leak in hooks](PR_URL) - #ISSUENUMBER
- [Fix critical memory leak in hooks](PR_URL) - #ISSUENUMBER
- [Fix critical memory leak in hooks](PR_URL) - #ISSUENUMBER
```

## Supported Priority Labels

The script automatically detects these labels as high priority:
- "high priority" or "high-priority"
- "urgent"
- "critical"

## Requirements

- Node.js 12 or higher
- Internet connection
- Optional: GitHub personal access token for higher rate limits

## Common commands
```
node --env-file=.env pr-generator.js https://github.com/bterone/pending-prs-list-generator
```
