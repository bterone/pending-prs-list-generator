#!/usr/bin/env node

const axios = require('axios');
const fs = require('fs');

class PRMarkdownGenerator {
  constructor() {
    this.githubToken = process.env.GITHUB_TOKEN;
    this.baseURL = 'https://api.github.com';
    // Login of the authenticated token owner ("me"); resolved lazily.
    this.viewerLogin = null;
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

      // Resolve "me" (the token owner) once, so we can tell our own review
      // activity apart from other reviewers'.
      if (this.githubToken && !this.viewerLogin) {
        try {
          const me = await axios.get(`${this.baseURL}/user`, { headers });
          this.viewerLogin = me.data.login;
        } catch (error) {
          this.viewerLogin = null;
        }
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
   * Fetch review threads via the GraphQL API. REST does not expose whether a
   * thread is resolved, nor whether a comment is a pending (draft) one, so we
   * query reviewThreads directly. Requires an authenticated token. Returns each
   * thread as { isResolved, comments: [{ login, type, state }] }.
   */
  async fetchReviewThreads(owner, repo, number, headers) {
    const query = `
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes {
                isResolved
                comments(first: 50) {
                  nodes {
                    state
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

    return threads.map(thread => ({
      isResolved: thread.isResolved,
      comments: (thread.comments?.nodes || []).map(c => ({
        login: c.author?.login || null,
        type: c.author?.__typename || null,
        state: c.state || null
      }))
    }));
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
   * True when a login is a bot rather than a real reviewer
   */
  isBot(login, type) {
    if (!login) return true;
    if (type === 'Bot') return true;
    return login.includes('bot') || login === 'gitstream-cm';
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
      !this.isBot(comment.user.login, comment.user.type)
    );
  }

  /**
   * Get the set of logins currently requested (or re-requested) for review
   */
  getRequestedReviewers(pr) {
    return new Set((pr.requested_reviewers || []).map(r => r.login));
    // Note: team review requests (pr.requested_teams) are not expanded into
    // individual members; resolving those would need extra API calls.
  }

  /**
   * Get the unresolved review threads that are awaiting the PR author.
   * A thread counts when it is not resolved and has at least one SUBMITTED
   * comment from a real reviewer (not the PR author, not a bot). Pending
   * (draft) comments are ignored - those belong to the viewer's own unsent
   * review, not to the author's to-do list.
   * Returns [{ reviewers: [login, ...] }].
   */
  getOpenThreads(pr) {
    if (!pr.reviewThreads) return [];

    const author = pr.user.login;
    const open = [];

    for (const thread of pr.reviewThreads) {
      if (thread.isResolved) continue;

      const reviewers = new Set();
      for (const comment of thread.comments) {
        if (comment.state && comment.state !== 'SUBMITTED') continue; // skip drafts
        if (comment.login === author) continue;
        if (this.isBot(comment.login, comment.type)) continue;
        reviewers.add(comment.login);
      }

      if (reviewers.size > 0) open.push({ reviewers: [...reviewers] });
    }

    return open;
  }

  /**
   * Check if the PR has comments for the author to fix.
   * The ball is in the author's court when there is an open (unresolved) thread
   * whose reviewer has NOT been re-requested. If every open thread's reviewer is
   * currently re-requested, the author has responded and it is review time again
   * (handled by "Requires review").
   */
  hasCommentsToFix(pr) {
    const requested = this.getRequestedReviewers(pr);

    // Preferred path: use real thread-resolution data from GraphQL
    if (pr.reviewThreads) {
      return this.getOpenThreads(pr).some(thread =>
        thread.reviewers.some(reviewer => !requested.has(reviewer))
      );
    }

    // Fallback (no token / GraphQL unavailable): any non-bot commenter who has
    // not been re-requested implies there is still something for the author.
    const comments = this.getAllComments(pr);
    if (comments.length === 0) return false;

    const commenters = new Set(
      comments.map(c => c.user.login).filter(login => login !== pr.user.login)
    );
    for (const commenter of commenters) {
      if (!requested.has(commenter)) return true;
    }
    return false;
  }

  /**
   * True when the viewer (me) has a pending/draft review that has not been
   * submitted yet. GitHub only returns a PENDING review for the token owner.
   */
  hasPendingReviewByViewer(pr) {
    return (pr.reviews || []).some(review =>
      review.state === 'PENDING' &&
      (!this.viewerLogin || review.user?.login === this.viewerLogin)
    );
  }

  /**
   * Count the viewer's own pending (draft) review comments, for display.
   */
  getMyPendingCommentCount(pr) {
    if (!pr.reviewThreads) return 0;

    let count = 0;
    pr.reviewThreads.forEach(thread => {
      thread.comments.forEach(comment => {
        if (comment.state === 'PENDING' &&
          (!this.viewerLogin || comment.login === this.viewerLogin)) {
          count++;
        }
      });
    });
    return count;
  }

  /**
   * Get commenters whose explicit approval is still outstanding.
   * These are users with 2+ comments who have not approved, excluding the PR
   * author, the viewer (me - my own approvals surface under "Requires review"),
   * and anyone currently re-requested (the ball is in their court as a reviewer,
   * so the PR is in review, not waiting on a nudge).
   */
  getProlificCommentersWithoutApproval(pr) {
    const comments = this.getAllComments(pr);
    const approvedUsers = new Set(this.getApprovals(pr).map(a => a.user.login));
    const requested = this.getRequestedReviewers(pr);
    const prOwner = pr.user.login;

    const commentCounts = new Map();
    comments.forEach(comment => {
      const user = comment.user.login;
      commentCounts.set(user, (commentCounts.get(user) || 0) + 1);
    });

    const prolificCommenters = [];
    for (const [user, count] of commentCounts.entries()) {
      if (count >= 2 &&
        !approvedUsers.has(user) &&
        user !== prOwner &&
        user !== this.viewerLogin &&
        !requested.has(user)) {
        prolificCommenters.push(user);
      }
    }

    return prolificCommenters;
  }

  /**
   * Return true if run `a` is more recent than run `b`
   * (by start time, falling back to completion time, then id)
   */
  isNewerRun(a, b) {
    const ta = new Date(a.started_at || a.completed_at || 0).getTime();
    const tb = new Date(b.started_at || b.completed_at || 0).getTime();
    if (ta !== tb) return ta > tb;
    return (a.id || 0) > (b.id || 0);
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

    // Legacy combined commit status API. The rollup `state` and the `statuses`
    // list already reflect only the latest status per context, so no dedup needed.
    const combinedState = pr.combinedStatus?.state;
    if (combinedState === 'failure' || combinedState === 'error') {
      (pr.combinedStatus.statuses || []).forEach(status => {
        if (status.state === 'failure' || status.state === 'error') {
          names.push(status.context);
        }
      });
    }

    // Checks API (GitHub Actions and most modern CI). GitHub returns one run per
    // check suite, so a single commit can have several runs sharing a name (e.g.
    // a superseded run plus its re-run). Keep only the most recent run per name,
    // mirroring how GitHub's UI decides a check's status.
    const latestByName = new Map();
    (pr.checkRuns || []).forEach(run => {
      const existing = latestByName.get(run.name);
      if (!existing || this.isNewerRun(run, existing)) {
        latestByName.set(run.name, run);
      }
    });

    // Only genuine failures count as "broken". `cancelled` means the run was
    // superseded/concurrency-cancelled, and `action_required`/`neutral`/`skipped`
    // are not failures, so none of those are treated as broken CI.
    const failingConclusions = new Set(['failure', 'timed_out']);
    for (const run of latestByName.values()) {
      if (run.status === 'completed' && failingConclusions.has(run.conclusion)) {
        names.push(run.name);
      }
    }

    return [...new Set(names)];
  }

  /**
   * Categorize PRs based on the review criteria.
   *
   * Priority order (a PR lands in the first bucket it matches):
   *   1. High priority (label-based escalation)
   *   2. Review pending comments (I have an unsubmitted draft review)
   *   3. Broken CI
   *   4. Have some comments to fix (open thread, reviewer not re-requested)
   *   5. Need one more approval (exactly 1 approval)
   *   6. Needs approvals from prolific commenters (2+ comments, not approved)
   *   7. Requires review (0 approvals, nothing outstanding)
   *   8. Needs merging (2+ approvals, no blockers)
   *   9. Uncategorized (safety net)
   */
  categorizePRs(prs) {
    const categories = {
      highPriority: [],
      reviewPendingComments: [],
      brokenCI: [],
      hasCommentsToFix: [],
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
      const hasPendingReview = this.hasPendingReviewByViewer(pr);
      const isHighPriority = this.hasHighPriorityLabel(pr);

      // High priority PRs get their own escalation bucket regardless of status
      if (isHighPriority) {
        categories.highPriority.push(pr);
      }
      // My own unsubmitted draft review — a personal reminder to finish it
      else if (hasPendingReview) {
        categories.reviewPendingComments.push(pr);
      }
      // Broken CI: one or more failed status checks / check runs
      else if (hasFailedCI) {
        categories.brokenCI.push(pr);
      }
      // Comments to fix: open thread whose reviewer has not been re-requested
      else if (hasCommentsToFixFlag) {
        categories.hasCommentsToFix.push(pr);
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

    if (categories.reviewPendingComments.length > 0) {
      markdown += `## Review pending comments (Reminder for me :zany_face:)\n`;
      categories.reviewPendingComments.forEach(pr => {
        const count = this.getMyPendingCommentCount(pr);
        const detail = count > 0 ? ` (${count} pending comment${count !== 1 ? 's' : ''})` : '';
        markdown += `- [${pr.title}](${pr.html_url})${detail}\n`;
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

    if (categories.hasCommentsToFix.length > 0) {
      markdown += `## Have some comments to fix :wrench:\n`;
      categories.hasCommentsToFix.forEach(pr => {
        const openCount = this.getOpenThreads(pr).length;
        const detail = openCount > 0
          ? ` (${openCount} open thread${openCount !== 1 ? 's' : ''})`
          : '';
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
        const commenters = this.getProlificCommentersWithoutApproval(pr).join(', ');
        markdown += `- [${pr.title}](${pr.html_url}) (waiting for: ${commenters})\n`;
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
                required to detect resolved vs open review threads and your own
                pending draft reviews via GraphQL)

Features:
  - Fetches all open pull requests from one or multiple repositories
  - Prioritizes PRs with "high priority", "urgent", or "critical" labels
  - Flags PRs with failing CI (commit status + check runs)
  - Reminds you about your own unsubmitted draft reviews
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
