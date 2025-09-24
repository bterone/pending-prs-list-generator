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
node pr-generator.js facebook/react

# Using GitHub URL
node pr-generator.js https://github.com/microsoft/vscode

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

## 🚨 High Priority (3)

- [Fix critical memory leak in hooks](https://github.com/facebook/react/pull/123) - #123
  - Author: developer1
  - Created: Mon Jan 15 2025
  - Labels: high priority, bug

## 📋 All Pull Requests (42)

- [Add new component feature](https://github.com/facebook/react/pull/124) - #124
  - Author: developer2
  - Created: Sun Jan 14 2025
  - Labels: enhancement, feature
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
node --env-file=.env pr-generator.js https://github.com/easyhoteluk/easyhotel.react
node --env-file=.env pr-generator.js https://github.com/easyhoteluk/easyhotel.api
node --env-file=.env pr-generator.js https://github.com/easyhoteluk/easyhotel.cms
node --env-file=.env pr-generator.js https://github.com/easyhoteluk/aws-infrastructure
```
