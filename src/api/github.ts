import {Octokit} from "@octokit/rest";
import type { components } from '@octokit/openapi-types'

interface GitHubErrorResponse {
    status: number;
    message: string;
}

function isGitHubError(error: unknown): error is GitHubErrorResponse {
    return (
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        'message' in error
    );
}

export const createGithubClient = (token: string) => new Octokit({
    auth: token,
    headers: {
        'X-GitHub-Api-Version': '2022-11-28',
        accept: 'application/vnd.github.v3+json',
    },
    baseUrl: 'https://api.github.com'
});

export async function validateGithubToken(github: Octokit) {
    try {
        const { data: user } = await github.users.getAuthenticated();
        console.log(`Authenticated as GitHub user: ${user.login}`);

        // Check token scopes
        const { headers } = await github.request('GET /');
        const scopes = headers['x-oauth-scopes']?.split(', ') || [];

        if (!scopes.includes('repo')) {
            console.error('GitHub token missing required repo scope');
            console.error('Current scopes:', scopes.join(', '));
            process.exit(1);
        }
    } catch (error) {
        console.error('GitHub authentication failed:', error);
        process.exit(1);
    }
}

/**
 * Fetches GitHub issues from multiple repositories in parallel
 * @param octokit - Authenticated Octokit client
 * @param options - Fetch options
 * @param options.repos - Array of repositories in 'owner/repo' format
 * @param options.authors - Optional array of GitHub usernames to filter by
 * @param options.since - Optional date to fetch issues updated after
 * @returns Promise of GitHub issues array
 * @example
 * ```ts
 * const github = createGithubClient(process.env.GITHUB_TOKEN)
 * const issues = await fetchGithubIssues(github, {
 *   repos: ['owner/repo1', 'owner/repo2'],
 *   authors: ['username1', 'username2'],
 *   since: new Date('2023-01-01')
 * })
 * ```
 */
export async function fetchGithubIssues(
    octokit: Octokit,
    { repos, authors, since }: {
        repos: string[]
        authors?: string[]
        since?: Date
    }
) {
    // Validate token first
    await validateGithubToken(octokit);

    const fetchRepoIssues = async ([owner, repo]: string[]) => {
        try {
            // Check if repo exists and we have access
            const { data: repoData } = await octokit.repos.get({
                owner,
                repo,
                headers: {
                    // Some orgs require this for private repos
                    authorization: `token ${process.env.GITHUB_TOKEN}`,
                }
            });

            // console.log(`repository data: ${JSON.stringify(repoData)}`);

            if (!repoData.permissions?.pull) {
                console.error(`No read access to ${owner}/${repo}`);
                return [];
            }

            const { data } = await octokit.issues.listForRepo({
                owner,
                repo,
                state: 'all',
                per_page: 100,
                since: since?.toISOString(),
                headers: {
                    authorization: `token ${process.env.GITHUB_TOKEN}`,
                }
            });

            return data
                .filter(issue => !issue.pull_request)
                .filter(issue => issue.user && (!authors?.length || authors.map(a=> a.toLowerCase()).includes(issue.user.login.toLowerCase())))
        } catch (error) {
            if (isGitHubError(error)) {
                if (error.status === 404) {
                    console.error(`Repository ${owner}/${repo} not found or no access`);
                } else {
                    console.error(`Error fetching ${owner}/${repo}:`, error.message);
                }
            } else {
                console.error(`Unexpected error fetching ${owner}/${repo}`);
            }
            return [];
        }
    };

    const repoPromises = repos
        .map(repo => repo.split('/'))
        .filter(([owner, repo]) => owner && repo)
        .map(fetchRepoIssues);

    const issuesPerRepo = await Promise.all(repoPromises);
    return issuesPerRepo.flat();
}
