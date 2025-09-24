#!/usr/bin/env node

const axios = require('axios');
const fs = require('fs');
const path = require('path');

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
   * Fetch all pull requests from the repository
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
   * Check if a PR has high priority label
   */
  hasHighPriorityLabel(pr) {
    return pr.labels.some(label => 
      label.name.toLowerCase().includes('high priority') ||
      label.name.toLowerCase().includes('high-priority') ||
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
   * Generate markdown content from PRs
   */
  generateMarkdown(prs, owner, repo) {
    const sortedPRs = this.sortPRsByPriority(prs);
    
    let markdown = `# Pull Requests for ${owner}/${repo}\n\n`;
    markdown += `Generated on: ${new Date().toISOString().split('T')[0]}\n`;
    markdown += `Total PRs: ${prs.length}\n\n`;

    // Separate high priority and regular PRs for clear sections
    const highPriorityPRs = sortedPRs.filter(pr => this.hasHighPriorityLabel(pr));
    const regularPRs = sortedPRs.filter(pr => !this.hasHighPriorityLabel(pr));

    if (highPriorityPRs.length > 0) {
      markdown += `## 🚨 High Priority (${highPriorityPRs.length})\n\n`;
      highPriorityPRs.forEach(pr => {
        markdown += `- [${pr.title}](${pr.html_url})\n`;
      });
    }

    if (regularPRs.length > 0) {
      markdown += `## 📋 All Pull Requests (${regularPRs.length})\n\n`;
      regularPRs.forEach(pr => {
        markdown += `- [${pr.title}](${pr.html_url})\n`;
      });
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
