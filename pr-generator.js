#!/usr/bin/env node

const axios = require('axios');
const fs = require('fs');

class PRMarkdownGenerator {
  constructor() {
    this.githubToken = process.env.GITHUB_TOKEN;
    this.baseURL = 'https://api.github.com';
  }

  /**
   * Parse repository string to extract owner and repo name
   * Supports formats: "owner/repo", "https://github.com/owner/repo", etc.
   */
  parseRepository(repoInput) {
    let owner, repo;

    if (repoInput.includes('github.com')) {
      const match = repoInput.match(/github\.com\/([^\/]+)\/([^\/\?#]+)/);
      if (match) {
        [, owner, repo] = match;
      }
    } else if (repoInput.includes('/')) {
      [owner, repo] = repoInput.split('/');
    } else {
      throw new Error('Invalid repository format. Use "owner/repo" or GitHub URL');
    }

    // Clean up repo name (remove .git suffix if present)
    repo = repo.replace(/\.git$/, '');

    return { owner, repo };
  }

  /**
   * Fetch all pull requests from the repository with detailed review information
   */
  async fetchPullRequests(owner, repo) {
    try {
      const headers = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'PR-Markdown-Generator'
      };

      if (this.githubToken) {
        headers['Authorization'] = `token ${this.githubToken}`;
      }

      let allPRs = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await axios.get(
          `${this.baseURL}/repos/${owner}/${repo}/pulls`,
          {
            headers,
            params: {
              state: 'open',
              per_page: 100,
              page: page
            }
          }
        );

        const prs = response.data;
        // Filter out draft PRs - only include PRs ready for review
        const readyForReviewPRs = prs.filter(pr => !pr.draft);
        allPRs = allPRs.concat(readyForReviewPRs);

        hasMore = prs.length === 100;
        page++;
      }

      // Fetch detailed review and comment information for each PR
      for (let pr of allPRs) {
        try {
          // Fetch reviews
          const reviewsResponse = await axios.get(
            `${this.baseURL}/repos/${owner}/${repo}/pulls/${pr.number}/reviews`,
            { headers }
          );
          pr.reviews = reviewsResponse.data;

          // Fetch review comments
          const reviewCommentsResponse = await axios.get(
            `${this.baseURL}/repos/${owner}/${repo}/pulls/${pr.number}/comments`,
            { headers }
          );
          pr.reviewComments = reviewCommentsResponse.data;

          // Fetch issue comments
          const issueCommentsResponse = await axios.get(
            `${this.baseURL}/repos/${owner}/${repo}/issues/${pr.number}/comments`,
            { headers }
          );
          pr.issueComments = issueCommentsResponse.data;

          // Fetch CI state for the PR head commit: both the legacy combined
          // status API (external CI reported via statuses) and the Checks API
          // (GitHub Actions and most modern CI)
          const statusResponse = await axios.get(
            `${this.baseURL}/repos/${owner}/${repo}/commits/${pr.head.sha}/status`,
            { headers }
          );
          pr.combinedStatus = statusResponse.data;

          const checkRunsResponse = await axios.get(
            `${this.baseURL}/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`,
            { headers }
          );
          pr.checkRuns = checkRunsResponse.data.check_runs || [];

          // Fetch review thread resolution state via GraphQL (needs a token;
          // the REST API does not expose whether a thread is resolved)
          pr.reviewThreads = this.githubToken
            ? await this.fetchReviewThreads(owner, repo, pr.number, headers)
            : null;

        } catch (error) {
          console.warn(`Failed to fetch detailed info for PR #${pr.number}: ${error.message}`);
          pr.reviews = [];
          pr.reviewComments = [];
          pr.issueComments = [];
          pr.combinedStatus = null;
          pr.checkRuns = [];
          pr.reviewThreads = null;
        }
      }

      return allPRs;
    } catch (error) {
      if (error.response?.status === 404) {
        throw new Error(`Repository "${owner}/${repo}" not found or not accessible`);
      } else if (error.response?.status === 403) {
        throw new Error('Rate limited or insufficient permissions. Consider setting GITHUB_TOKEN environment variable');
      } else {
        throw new Error(`Failed to fetch PRs: ${error.message}`);
      }
    }
  }

  /**
   * Fetch review thread resolution state via the GraphQL API.
   * REST does not expose whether a review thread is resolved, so we query
   * reviewThreads directly. Requires an authenticated token; returns the
   * threads as { isResolved, authorLogin, authorType }.
   */
  async fetchReviewThreads(owner, repo, number, headers) {
    const query = `
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes {
                isResolved
                comments(first: 1) {
                  nodes {
                    author { login __typename }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await axios.post(
      `${this.baseURL}/graphql`,
      { query, variables: { owner, repo, number } },
      { headers }
    );

    const threads =
      response.data?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];

    return threads.map(thread => {
      const author = thread.comments?.nodes?.[0]?.author;
      return {
        isResolved: thread.isResolved,
        authorLogin: author?.login || null,
        authorType: author?.__typename || null
      };
    });
  }

  /**
   * Get approved reviews (excluding dismissed ones)
   */
  getApprovals(pr) {
    if (!pr.reviews) return [];

    const latestReviewsByUser = new Map();

    // Get the latest review from each user
    pr.reviews
      .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at))
      .forEach(review => {
        latestReviewsByUser.set(review.user.login, review);
      });

    // Return only approved reviews
    return Array.from(latestReviewsByUser.values())
      .filter(review => review.state === 'APPROVED');
  }

  /**
   * Get all comments from real users (excluding bots)
   */
  getAllComments(pr) {
    const allComments = [
      ...(pr.reviewComments || []),
      ...(pr.issueComments || [])
    ];

    // Filter out bot comments (specifically gitstream-cm and other common bots)
    return allComments.filter(comment =>
      !comment.user.login.includes('bot') &&
      comment.user.login !== 'gitstream-cm' &&
      comment.user.type !== 'Bot'
    );
  }

  /**
   * Get commenters who have made 2+ comments and haven't approved
   */
  getProlificCommentersWithoutApproval(pr) {
    const comments = this.getAllComments(pr);
    const approvals = this.getApprovals(pr);
    const approvedUsers = new Set(approvals.map(approval => approval.user.login));
    const prOwner = pr.user.login;

    // Count comments by user
    const commentCounts = new Map();
    comments.forEach(comment => {
      const user = comment.user.login;
      commentCounts.set(user, (commentCounts.get(user) || 0) + 1);
    });

    // Find users with 2+ comments who haven't approved (excluding PR owner)
    const prolificCommenters = [];
    for (const [user, count] of commentCounts.entries()) {
      if (count >= 2 && !approvedUsers.has(user) && user !== prOwner) {
        prolificCommenters.push(user);
      }
    }

    return prolificCommenters;
  }

  /**
   * Check whether the PR has any unresolved review threads (open comments).
   * Uses GraphQL resolution data; excludes the PR owner's own threads and bots.
   * Returns false when thread data is unavailable (no token / fetch failed).
   */
  hasUnresolvedThreads(pr) {
    if (!pr.reviewThreads) {
      return false;
    }

    return pr.reviewThreads.some(thread => {
      if (thread.isResolved) return false;

      const login = thread.authorLogin;
      if (!login) return false;
      if (login === pr.user.login) return false; // PR owner's own thread
      if (thread.authorType === 'Bot') return false;
      if (login.includes('bot') || login === 'gitstream-cm') return false;

      return true;
    });
  }

  /**
   * Check if the PR has comments to fix.
   * Criteria: there are open (unresolved) review threads, AND/OR a commenter
   * has left feedback but has NOT been re-requested for review yet.
   */
  hasCommentsToFix(pr) {
    // Concrete open comments: any unresolved review thread
    if (this.hasUnresolvedThreads(pr)) {
      return true;
    }

    const comments = this.getAllComments(pr);
    if (comments.length === 0) {
      return false;
    }

    // Get all commenters (excluding PR owner)
    const commenters = new Set();
    comments.forEach(comment => {
      if (comment.user.login !== pr.user.login) {
        commenters.add(comment.user.login);
      }
    });

    if (commenters.size === 0) {
      return false;
    }

    // Get currently requested reviewers (including re-requested)
    const requestedReviewers = new Set();
    if (pr.requested_reviewers) {
      pr.requested_reviewers.forEach(reviewer => {
        requestedReviewers.add(reviewer.login);
      });
    }

    // Any commenter who hasn't been re-requested means there's still work to do
    for (const commenter of commenters) {
      if (!requestedReviewers.has(commenter)) {
        return true;
      }
    }

    return false; // Threads resolved and all commenters re-requested
  }

  /**
   * Get prolific commenters who have been re-requested for review
   * These are users with 2+ comments who are currently in requested_reviewers
   */
  getProlificCommentersReRequested(pr) {
    const comments = this.getAllComments(pr);
    const approvals = this.getApprovals(pr);
    const approvedUsers = new Set(approvals.map(approval => approval.user.login));
    const prOwner = pr.user.login;

    // Get currently requested reviewers
    const requestedReviewers = new Set();
    if (pr.requested_reviewers) {
      pr.requested_reviewers.forEach(reviewer => {
        requestedReviewers.add(reviewer.login);
      });
    }

    // Count comments by user
    const commentCounts = new Map();
    comments.forEach(comment => {
      const user = comment.user.login;
      commentCounts.set(user, (commentCounts.get(user) || 0) + 1);
    });

    // Find users with 2+ comments who are currently requested and haven't approved (excluding PR owner)
    const prolificCommentersReRequested = [];
    for (const [user, count] of commentCounts.entries()) {
      if (count >= 2 && requestedReviewers.has(user) && !approvedUsers.has(user) && user !== prOwner) {
        prolificCommentersReRequested.push(user);
      }
    }

    return prolificCommentersReRequested;
  }

  /**
   * Check if the PR has failing CI (failed combined status or check runs)
   */
  hasFailedStatusChecks(pr) {
    return this.getFailedCheckNames(pr).length > 0;
  }

  /**
   * Get the names of failing status checks / check runs for display
   */
  getFailedCheckNames(pr) {
    const names = [];

    // Legacy combined commit status API (external CI reported via statuses)
    const combinedState = pr.combinedStatus?.state;
    if (combinedState === 'failure' || combinedState === 'error') {
      (pr.combinedStatus.statuses || []).forEach(status => {
        if (status.state === 'failure' || status.state === 'error') {
          names.push(status.context);
        }
      });
    }

    // Checks API (GitHub Actions and most modern CI)
    const failingConclusions = new Set([
      'failure',
      'timed_out',
      'cancelled',
      'action_required'
    ]);
    (pr.checkRuns || []).forEach(run => {
      if (run.status === 'completed' && failingConclusions.has(run.conclusion)) {
        names.push(run.name);
      }
    });

    return names;
  }

  /**
   * Categorize PRs based on the new criteria
   *
   * Priority order (a PR lands in the first bucket it matches):
   *   1. High priority (label-based escalation)
   *   2. Have some comments to fix
   *   3. Broken CI
   *   4. Need one more approval (exactly 1 approval)
   *   5. Needs approvals from prolific commenters (2+ comments, not approved)
   *   6. Requires review (0 approvals)
   *   7. Needs merging (2+ approvals, no blockers)
   *   8. Uncategorized (safety net)
   */
  categorizePRs(prs) {
    const categories = {
      highPriority: [],
      hasCommentsToFix: [],
      brokenCI: [],
      needOneMoreApproval: [],
      needsProlificCommentersApproval: [],
      requiresReview: [],
      needsMerging: [],
      uncategorized: []
    };

    prs.forEach(pr => {
      const approvals = this.getApprovals(pr);
      const approvalCount = approvals.length;
      const prolificCommentersWithoutApproval = this.getProlificCommentersWithoutApproval(pr);
      const hasCommentsToFixFlag = this.hasCommentsToFix(pr);
      const hasFailedCI = this.hasFailedStatusChecks(pr);
      const isHighPriority = this.hasHighPriorityLabel(pr);

      // High priority PRs get their own escalation bucket regardless of status
      if (isHighPriority) {
        categories.highPriority.push(pr);
      }
      // Top priority: open comments and/or reviewers not yet re-requested
      else if (hasCommentsToFixFlag) {
        categories.hasCommentsToFix.push(pr);
      }
      // Broken CI: one or more failed status checks / check runs
      else if (hasFailedCI) {
        categories.brokenCI.push(pr);
      }
      // Need one more approval (exactly 1) — takes priority over prolific commenters
      else if (approvalCount === 1) {
        categories.needOneMoreApproval.push(pr);
      }
      // Needs approvals from prolific commenters (2+ comments, not yet approved)
      else if (prolificCommentersWithoutApproval.length > 0) {
        categories.needsProlificCommentersApproval.push(pr);
      }
      // Requires review (no approvals, nothing outstanding)
      else if (approvalCount === 0) {
        categories.requiresReview.push(pr);
      }
      // Needs merging (2+ approvals, no blockers — just forgot to merge).
      // Merged/closed PRs never reach here because only open PRs are fetched.
      else if (approvalCount >= 2) {
        categories.needsMerging.push(pr);
      }
      // Safety net: should stay empty, catches anything a future rule misses
      else {
        categories.uncategorized.push(pr);
      }
    });

    return categories;
  }

  /**
   * Check if a PR has high priority label
   */
  hasHighPriorityLabel(pr) {
    return pr.labels.some(label =>
      label.name.toLowerCase().includes('high priority') ||
      label.name.toLowerCase().includes('high-priority') ||
      label.name.toLowerCase().includes('priority : high') ||
      label.name.toLowerCase().includes('urgent') ||
      label.name.toLowerCase().includes('critical')
    );
  }

  /**
   * Sort PRs with high priority first
   */
  sortPRsByPriority(prs) {
    return prs.sort((a, b) => {
      const aHighPriority = this.hasHighPriorityLabel(a);
      const bHighPriority = this.hasHighPriorityLabel(b);

      if (aHighPriority && !bHighPriority) return -1;
      if (!aHighPriority && bHighPriority) return 1;

      // If both have same priority, sort by creation date (newest first)
      return new Date(b.created_at) - new Date(a.created_at);
    });
  }

  /**
   * Generate markdown content from categorized PRs
   * Can handle single or multiple repositories
   */
  generateMarkdown(prsData) {
    // Handle both single repo (legacy) and multiple repos format
    const isMultiRepo = Array.isArray(prsData);
    const repoDataArray = isMultiRepo ? prsData : [prsData];

    let markdown = '';

    // Combine all PRs from all repositories
    const allPRs = repoDataArray.reduce((acc, data) => acc.concat(data.prs), []);

    // Generate header
    if (isMultiRepo && repoDataArray.length > 1) {
      markdown += `# Pull Requests Summary\n\n`;
      markdown += `Generated on: ${new Date().toISOString().split('T')[0]}\n`;
      markdown += `Repositories: ${repoDataArray.length}\n`;
      markdown += `Total PRs: ${allPRs.length}\n\n`;
    } else {
      const { owner, repo } = repoDataArray[0];
      markdown += `# Pull Requests for ${owner}/${repo}\n\n`;
      markdown += `Generated on: ${new Date().toISOString().split('T')[0]}\n`;
      markdown += `Total PRs: ${allPRs.length}\n\n`;
    }

    // Categorize all PRs together
    const categories = this.categorizePRs(allPRs);

    // Add each category section (in priority order)
    if (categories.highPriority.length > 0) {
      markdown += `## High Priority :rotating_light:\n`;
      categories.highPriority.forEach(pr => {
        const approvals = this.getApprovals(pr);
        const approvalCount = approvals.length;
        const status = approvalCount === 0 ? 'needs review' :
          approvalCount === 1 ? 'needs one more approval' :
            'ready to merge';
        markdown += `- [${pr.title}](${pr.html_url}) (${status})\n`;
      });
      markdown += `\n`;
    }

    if (categories.hasCommentsToFix.length > 0) {
      markdown += `## Have some comments to fix :wrench:\n`;
      categories.hasCommentsToFix.forEach(pr => {
        const comments = this.getAllComments(pr);
        const commentCount = comments.length;
        markdown += `- [${pr.title}](${pr.html_url}) (${commentCount} comment${commentCount !== 1 ? 's' : ''})\n`;
      });
      markdown += `\n`;
    }

    if (categories.brokenCI.length > 0) {
      markdown += `## Broken CI :x:\n`;
      categories.brokenCI.forEach(pr => {
        const failed = this.getFailedCheckNames(pr);
        const detail = failed.length > 0 ? ` (failed: ${failed.join(', ')})` : '';
        markdown += `- [${pr.title}](${pr.html_url})${detail}\n`;
      });
      markdown += `\n`;
    }

    if (categories.needOneMoreApproval.length > 0) {
      markdown += `## Need one more approval :white_check_mark:\n`;
      categories.needOneMoreApproval.forEach(pr => {
        const approvals = this.getApprovals(pr);
        const approverName = approvals.length > 0 ? approvals[0].user.login : 'unknown';
        markdown += `- [${pr.title}](${pr.html_url}) (approved by ${approverName})\n`;
      });
      markdown += `\n`;
    }

    if (categories.needsProlificCommentersApproval.length > 0) {
      markdown += `## Needs approvals from previous :sparkles: prolific :sparkles: commenters\n`;
      categories.needsProlificCommentersApproval.forEach(pr => {
        const prolificCommentersReRequested = this.getProlificCommentersReRequested(pr);
        const prolificCommentersWithoutApproval = this.getProlificCommentersWithoutApproval(pr);

        let commentersList = '';
        let status = '';

        if (prolificCommentersReRequested.length > 0) {
          commentersList = prolificCommentersReRequested.join(', ');
          status = 're-requested';
        } else if (prolificCommentersWithoutApproval.length > 0) {
          commentersList = prolificCommentersWithoutApproval.join(', ');
          status = 'waiting for';
        }

        markdown += `- [${pr.title}](${pr.html_url}) (${status}: ${commentersList})\n`;
      });
      markdown += `\n`;
    }

    if (categories.requiresReview.length > 0) {
      markdown += `## Requires review :writing_hand:\n`;
      categories.requiresReview.forEach(pr => {
        markdown += `- [${pr.title}](${pr.html_url})\n`;
      });
      markdown += `\n`;
    }

    if (categories.needsMerging.length > 0) {
      markdown += `## Needs merging (Reminder for me :zany_face:)\n`;
      categories.needsMerging.forEach(pr => {
        const approvals = this.getApprovals(pr);
        const approvalCount = approvals.length;
        markdown += `- [${pr.title}](${pr.html_url}) (${approvalCount} approvals)\n`;
      });
      markdown += `\n`;
    }

    if (categories.uncategorized.length > 0) {
      markdown += `## Uncategorized :grey_question:\n`;
      categories.uncategorized.forEach(pr => {
        markdown += `- [${pr.title}](${pr.html_url})\n`;
      });
      markdown += `\n`;
    }

    if (allPRs.length === 0) {
      markdown += `No open pull requests found.\n`;
    }

    return markdown;
  }

  /**
   * Main function to generate PR markdown for single or multiple repositories
   */
  async generatePRMarkdown(repoInputs, outputFile = null) {
    try {
      // Handle both single string and array of strings
      const repositories = Array.isArray(repoInputs) ? repoInputs : [repoInputs];

      console.log(`🔍 Processing ${repositories.length} repository/repositories...\n`);

      const allRepoData = [];
      let totalPRs = 0;
      let totalHighPriority = 0;

      // Fetch PRs from each repository
      for (const repoInput of repositories) {
        try {
          console.log(`📍 Parsing repository: ${repoInput}`);
          const { owner, repo } = this.parseRepository(repoInput);

          console.log(`📡 Fetching PRs from ${owner}/${repo}...`);
          const prs = await this.fetchPullRequests(owner, repo);

          const highPriorityCount = prs.filter(pr => this.hasHighPriorityLabel(pr)).length;
          console.log(`✓ Found ${prs.length} PRs (${highPriorityCount} high priority)\n`);

          allRepoData.push({ owner, repo, prs });
          totalPRs += prs.length;
          totalHighPriority += highPriorityCount;
        } catch (error) {
          console.error(`❌ Error processing ${repoInput}: ${error.message}`);
          console.log('Continuing with remaining repositories...\n');
        }
      }

      if (allRepoData.length === 0) {
        throw new Error('No repositories were successfully processed');
      }

      console.log(`📝 Generating markdown for ${totalPRs} total PRs...`);
      const markdown = this.generateMarkdown(allRepoData);

      // Generate filename
      let fileName;
      if (outputFile) {
        fileName = outputFile;
      } else if (allRepoData.length === 1) {
        const { owner, repo } = allRepoData[0];
        fileName = `${owner}-${repo}-prs.md`;
      } else {
        fileName = `combined-prs-${new Date().toISOString().split('T')[0]}.md`;
      }

      console.log(`💾 Writing to ${fileName}...`);
      fs.writeFileSync(fileName, markdown);

      console.log(`✅ Successfully generated ${fileName}`);

      // Show summary
      console.log(`📊 Summary: ${allRepoData.length} repositories, ${totalPRs} total PRs, ${totalHighPriority} high priority`);

      return fileName;
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
      process.exit(1);
    }
  }
}

// CLI Interface
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
PR Markdown Generator

Usage: node pr-generator.js <repository1> [repository2] [...] [--output <filename>]

Arguments:
  repository    One or more GitHub repositories (owner/repo or GitHub URL)
  --output      Optional output filename (default: owner-repo-prs.md for single repo,
                combined-prs-YYYY-MM-DD.md for multiple repos)

Examples:
  Single repository:
    node pr-generator.js facebook/react
    node pr-generator.js https://github.com/microsoft/vscode
    node pr-generator.js owner/repo --output my-prs.md

  Multiple repositories:
    node pr-generator.js facebook/react microsoft/vscode
    node pr-generator.js owner/repo1 owner/repo2 owner/repo3
    node pr-generator.js repo1 repo2 --output combined.md

Environment Variables:
  GITHUB_TOKEN  GitHub personal access token (recommended for higher rate limits;
                required to detect resolved vs open review threads via GraphQL)

Features:
  - Fetches all open pull requests from one or multiple repositories
  - Prioritizes PRs with "high priority", "urgent", or "critical" labels
  - Flags PRs with failing CI (commit status + check runs)
  - Detects open vs resolved review threads (requires GITHUB_TOKEN)
  - Generates organized markdown with PR titles as clickable links
  - Combines PRs from multiple repositories into a single report
  - Categorizes PRs by review status and priority
    `);
    process.exit(0);
  }

  // Parse arguments
  let repositories = [];
  let outputFile = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' || args[i] === '-o') {
      if (i + 1 < args.length) {
        outputFile = args[i + 1];
        i++; // Skip next argument
      }
    } else {
      repositories.push(args[i]);
    }
  }

  if (repositories.length === 0) {
    console.error('❌ Error: No repositories specified');
    process.exit(1);
  }

  const generator = new PRMarkdownGenerator();
  await generator.generatePRMarkdown(repositories, outputFile);
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = PRMarkdownGenerator;
