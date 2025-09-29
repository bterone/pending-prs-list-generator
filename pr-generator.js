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

        } catch (error) {
          console.warn(`Failed to fetch detailed info for PR #${pr.number}: ${error.message}`);
          pr.reviews = [];
          pr.reviewComments = [];
          pr.issueComments = [];
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
   * Get commenters who have made 3+ comments and haven't approved
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

    // Find users with 3+ comments who haven't approved (excluding PR owner)
    const prolificCommenters = [];
    for (const [user, count] of commentCounts.entries()) {
      if (count >= 3 && !approvedUsers.has(user) && user !== prOwner) {
        prolificCommenters.push(user);
      }
    }

    return prolificCommenters;
  }

  /**
   * Check if PR has comments from users who are NOT currently requested for review
   * New criteria: commenters have left comments but are NOT re-requested or requested for review
   */
  hasCommentsToFix(pr) {
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
    
    // Add individual requested reviewers
    if (pr.requested_reviewers) {
      pr.requested_reviewers.forEach(reviewer => {
        requestedReviewers.add(reviewer.login);
      });
    }
    
    // Add team requested reviewers
    if (pr.requested_teams) {
      pr.requested_teams.forEach(team => {
        // Note: We can't easily get team members without additional API calls
        // For now, we'll assume team requests don't affect individual commenters
      });
    }

    // Check if any commenter is NOT currently requested for review
    for (const commenter of commenters) {
      if (!requestedReviewers.has(commenter)) {
        return true; // Found a commenter who has comments but is not requested
      }
    }

    return false; // All commenters are currently requested for review
  }

  /**
   * Get prolific commenters who have been re-requested for review
   * These are users with 3+ comments who are currently in requested_reviewers
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

    // Find users with 3+ comments who are currently requested and haven't approved (excluding PR owner)
    const prolificCommentersReRequested = [];
    for (const [user, count] of commentCounts.entries()) {
      if (count >= 3 && requestedReviewers.has(user) && !approvedUsers.has(user) && user !== prOwner) {
        prolificCommentersReRequested.push(user);
      }
    }

    return prolificCommentersReRequested;
  }

  /**
   * Check if the review owner has approved the PR
   */
  hasReviewOwnerApproval(pr) {
    const reviewOwner = process.env.REVIEW_OWNER;
    if (!reviewOwner) {
      return false;
    }
    const approvals = this.getApprovals(pr);
    return approvals.some(approval => approval.user.login === reviewOwner);
  }

  /**
   * Categorize PRs based on the new criteria
   */
  categorizePRs(prs) {
    const categories = {
      highPriority: [],
      needOneMoreApproval: [],
      needsProlificCommentersApproval: [],
      requiresReview: [],
      hasCommentsToFix: [],
      needsMerging: []
    };

    prs.forEach(pr => {
      const approvals = this.getApprovals(pr);
      const approvalCount = approvals.length;
      const prolificCommentersReRequested = this.getProlificCommentersReRequested(pr);
      const prolificCommentersWithoutApproval = this.getProlificCommentersWithoutApproval(pr);
      const hasCommentsToFixFlag = this.hasCommentsToFix(pr);
      const hasReviewOwnerApproval = this.hasReviewOwnerApproval(pr);
      const isHighPriority = this.hasHighPriorityLabel(pr);

      // High priority PRs get their own category regardless of other status
      if (isHighPriority) {
        categories.highPriority.push(pr);
      }
      // Prioritize prolific commenters who have been re-requested (3+ comments and currently requested)
      else if (prolificCommentersReRequested.length > 0) {
        categories.needsProlificCommentersApproval.push(pr);
      }
      // Has comments to fix (commenters have left comments but are NOT requested for review)
      else if (hasCommentsToFixFlag) {
        categories.hasCommentsToFix.push(pr);
      }
      // Needs merging (2+ approvals, no comments to fix, but no review owner approval)
      else if (approvalCount >= 2 && !hasCommentsToFixFlag && !hasReviewOwnerApproval) {
        categories.needsMerging.push(pr);
      }
      // Needs approvals from prolific commenters (3+ comments but not currently requested)
      else if (prolificCommentersWithoutApproval.length > 0) {
        categories.needsProlificCommentersApproval.push(pr);
      }
      // Need one more approval (exactly 1 approval)
      else if (approvalCount === 1) {
        categories.needOneMoreApproval.push(pr);
      }
      // Requires review (no approvals or reviews)
      else if (approvalCount === 0) {
        categories.requiresReview.push(pr);
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
   */
  generateMarkdown(prs, owner, repo) {
    const categories = this.categorizePRs(prs);

    let markdown = `# Pull Requests for ${owner}/${repo}\n\n`;
    markdown += `Generated on: ${new Date().toISOString().split('T')[0]}\n`;
    markdown += `Total PRs: ${prs.length}\n\n`;

    // Add each category section
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

    if (categories.hasCommentsToFix.length > 0) {
      markdown += `## Have some comments to fix :wrench:\n`;
      categories.hasCommentsToFix.forEach(pr => {
        const comments = this.getAllComments(pr);
        const commentCount = comments.length;
        markdown += `- [${pr.title}](${pr.html_url}) (${commentCount} comment${commentCount !== 1 ? 's' : ''})\n`;
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

    if (prs.length === 0) {
      markdown += `No open pull requests found.\n`;
    }

    return markdown;
  }

  /**
   * Main function to generate PR markdown
   */
  async generatePRMarkdown(repoInput, outputFile = null) {
    try {
      console.log('🔍 Parsing repository...');
      const { owner, repo } = this.parseRepository(repoInput);

      console.log(`📡 Fetching PRs from ${owner}/${repo}...`);
      const prs = await this.fetchPullRequests(owner, repo);

      console.log(`📝 Generating markdown for ${prs.length} PRs...`);
      const markdown = this.generateMarkdown(prs, owner, repo);

      const fileName = outputFile || `${owner}-${repo}-prs.md`;

      console.log(`💾 Writing to ${fileName}...`);
      fs.writeFileSync(fileName, markdown);

      console.log(`✅ Successfully generated ${fileName}`);

      // Show summary
      const highPriorityCount = prs.filter(pr => this.hasHighPriorityLabel(pr)).length;
      console.log(`📊 Summary: ${prs.length} total PRs, ${highPriorityCount} high priority`);

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
====================

Usage: node pr-generator.js <repository> [output-file]

Arguments:
  repository    GitHub repository (owner/repo or GitHub URL)
  output-file   Optional output filename (default: owner-repo-prs.md)

Examples:
  node pr-generator.js facebook/react
  node pr-generator.js https://github.com/microsoft/vscode
  node pr-generator.js owner/repo my-prs.md

Environment Variables:
  GITHUB_TOKEN  GitHub personal access token (recommended for higher rate limits)

Features:
  - Fetches all open pull requests
  - Prioritizes PRs with "high priority", "urgent", or "critical" labels
  - Generates organized markdown with PR titles as clickable links
  - Includes author, creation date, and labels for each PR
    `);
    process.exit(0);
  }

  const repository = args[0];
  const outputFile = args[1];

  const generator = new PRMarkdownGenerator();
  await generator.generatePRMarkdown(repository, outputFile);
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = PRMarkdownGenerator;
