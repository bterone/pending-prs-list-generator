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
    
    // Count comments by user
    const commentCounts = new Map();
    comments.forEach(comment => {
      const user = comment.user.login;
      commentCounts.set(user, (commentCounts.get(user) || 0) + 1);
    });
    
    // Find users with 3+ comments who haven't approved
    const prolificCommenters = [];
    for (const [user, count] of commentCounts.entries()) {
      if (count >= 3 && !approvedUsers.has(user)) {
        prolificCommenters.push(user);
      }
    }
    
    return prolificCommenters;
  }

  /**
   * Check if PR has unresolved comments (assuming all comments are unresolved for now)
   */
  hasUnresolvedComments(pr) {
    const comments = this.getAllComments(pr);
    return comments.length > 0;
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
      needOneMoreApproval: [],
      needsProlificCommentersApproval: [],
      requiresReview: [],
      hasCommentsToFix: [],
      needsMerging: []
    };

    prs.forEach(pr => {
      const approvals = this.getApprovals(pr);
      const approvalCount = approvals.length;
      const prolificCommenters = this.getProlificCommentersWithoutApproval(pr);
      const hasUnresolvedComments = this.hasUnresolvedComments(pr);
      const hasReviewOwnerApproval = this.hasReviewOwnerApproval(pr);

      // Needs merging (2+ approvals, no unresolved comments, but no review owner approval)
      if (approvalCount >= 2 && !hasUnresolvedComments && !hasReviewOwnerApproval) {
        categories.needsMerging.push(pr);
      }
      // Need one more approval (exactly 1 approval)
      else if (approvalCount === 1) {
        categories.needOneMoreApproval.push(pr);
      }
      // Needs approvals from prolific commenters
      else if (prolificCommenters.length > 0) {
        categories.needsProlificCommentersApproval.push(pr);
      }
      // Has comments to fix
      else if (hasUnresolvedComments) {
        categories.hasCommentsToFix.push(pr);
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
      label.name.toLowerCase().includes('priority: high') ||
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
    if (categories.needOneMoreApproval.length > 0) {
      markdown += `## Need one more approval :white_check_mark:\n\n`;
      categories.needOneMoreApproval.forEach(pr => {
        const approvals = this.getApprovals(pr);
        const approverName = approvals.length > 0 ? approvals[0].user.login : 'unknown';
        markdown += `- [${pr.title}](${pr.html_url}) (approved by ${approverName})\n`;
      });
      markdown += `\n`;
    }

    if (categories.needsProlificCommentersApproval.length > 0) {
      markdown += `## Needs approvals from previous :sparkles: prolific :sparkles: commenters\n\n`;
      categories.needsProlificCommentersApproval.forEach(pr => {
        const prolificCommenters = this.getProlificCommentersWithoutApproval(pr);
        const commentersList = prolificCommenters.join(', ');
        markdown += `- [${pr.title}](${pr.html_url}) (waiting for: ${commentersList})\n`;
      });
      markdown += `\n`;
    }

    if (categories.requiresReview.length > 0) {
      markdown += `## Requires review :writing_hand:\n\n`;
      categories.requiresReview.forEach(pr => {
        markdown += `- [${pr.title}](${pr.html_url})\n`;
      });
      markdown += `\n`;
    }

    if (categories.hasCommentsToFix.length > 0) {
      markdown += `## Have some comments to fix :wrench:\n\n`;
      categories.hasCommentsToFix.forEach(pr => {
        const comments = this.getAllComments(pr);
        const commentCount = comments.length;
        markdown += `- [${pr.title}](${pr.html_url}) (${commentCount} comment${commentCount !== 1 ? 's' : ''})\n`;
      });
      markdown += `\n`;
    }

    if (categories.needsMerging.length > 0) {
      markdown += `## Needs merging (Reminder for me :zany_face:)\n\n`;
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
