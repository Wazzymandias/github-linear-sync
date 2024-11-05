// src/linear.ts
import type {IssueCreateInput} from "@linear/sdk/dist/_generated_documents";
import {LinearClient, Issue as LinearIssue, WorkflowState, IssuePayload} from '@linear/sdk'
import type { components } from '@octokit/openapi-types'
import type {Octokit} from "@octokit/rest";

const createGithubTitle = (issue: GithubIssue) =>
    `[🛠️GH] ${issue.repository_url?.split('/').slice(-2).join('/')}#${issue.number}: ${issue.title}`;



type GithubIssue = components['schemas']['issue']

// Adding proper interface for sync results
export interface SyncResults {
    succeeded: IssuePayload[];
    failed: Array<{
        error: unknown;
        message: string;
    }>;
}

export function getLinearClient(): LinearClient {
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
        console.error('LINEAR_API_KEY environment variable is required');
        process.exit(1);
    }
    return new LinearClient({ apiKey });
}

interface LinkedIssue {
    linearId: string;
    githubUrl: string;
    isDeleted?: boolean;
}


export async function validateLinearProject(
    client: LinearClient,
    projectIdOrSlug: string
): Promise<boolean> {
    try {
        // First try to find project by listing all and filtering
        const { nodes } = await client.projects({});
        const project = nodes.find(p =>
            p.id === projectIdOrSlug ||
            p.slugId === projectIdOrSlug ||
            p.url.includes(projectIdOrSlug)
        );

        if (!project) {
            console.error(`No project found matching: ${projectIdOrSlug}`);
            return false;
        }

        // Store the actual ID for later use
        projectIdOrSlug = project.id;
        return true;
    } catch (error) {
        if (error instanceof Error) {
            console.error('Project validation error:', error.message);
        }
        return false;
    }
}


export async function checkGithubIssueExists(
    octokit: Octokit,
    issueUrl: string
): Promise<boolean> {
    const [owner, repo, number] = issueUrl
        .replace('https://github.com/', '')
        .replace('/issues/', '/')
        .split('/');

    try {
        await octokit.issues.get({
            owner,
            repo,
            issue_number: parseInt(number)
        });
        return true;
    } catch {
        return false;
    }
}

interface WorkflowStates {
    backlog: WorkflowState
    done: WorkflowState
}

// Step 1: Get workflow states with error handling
async function getWorkflowStates(
    client: LinearClient,
    teamId: string
): Promise<WorkflowStates> {
    const workflow = await client.workflowStates({
        filter: {
            team: { id: { eq: teamId } }
        }
    })

    const backlog = workflow.nodes.find(s => s.name === 'Backlog')
    const done = workflow.nodes.find(s => s.name === 'Done')

    if (!backlog || !done) {
        const missing = [
            !backlog && 'Backlog',
            !done && 'Done'
        ].filter(Boolean).join(', ')

        throw new Error(
            `Required workflow states missing for team ${teamId}: ${missing}`
        )
    }

    return { backlog, done }
}

// Step 2: Find existing issue with error handling
// Update findExistingIssue to check all possible linking fields
export async function findExistingIssue(
    client: LinearClient,
    githubIssue: GithubIssue
): Promise<LinearIssue | null> {
    const issueUrl = githubIssue.html_url!;
    const title = createGithubTitle(githubIssue);

    const issues = await client.issues({
        filter: {
            or: [
                { description: { contains: issueUrl } },
                { title: { eq: title } }
            ]
        }
    });
    return issues.nodes[0] ?? null;
}


// Step 3: Main sync function with comprehensive error handling
export async function syncGithubIssueToLinear(
    client: LinearClient,
    githubClient: Octokit,
    githubIssue: GithubIssue,
    projectIdOrSlug: string,
    teamId: string
): Promise<IssuePayload> {
    if (!githubIssue.html_url) {
        throw new Error('GitHub issue URL is required');
    }

    // Get the actual project first
    const { nodes } = await client.projects({});
    const project = nodes.find(p =>
        p.id === projectIdOrSlug ||
        p.slugId === projectIdOrSlug ||
        p.url.includes(projectIdOrSlug)
    );

    if (!project) {
        throw new Error(`Linear project not found: ${projectIdOrSlug}`);
    }

    // Use the correct project ID for the rest of the sync
    const projectId = project.id;

    const states = await getWorkflowStates(client, teamId);
    const existingIssue = await findExistingIssue(client, githubIssue);
    const githubIssueExists = await checkGithubIssueExists(
        githubClient,
        githubIssue.html_url
    );

    // Short circuit: Don't create new Linear issues for closed GitHub issues
    if (!existingIssue && githubIssue.state.toLowerCase() === 'closed') {
        throw new Error(
            `Skipping closed GitHub issue: ${githubIssue.html_url}`
        );
    }

    const issueData: IssueCreateInput = {
        title: createGithubTitle(githubIssue),
        description: [
            githubIssue.body,
            '',
            `GitHub: ${githubIssue.html_url}`,
            githubIssueExists ? '' : '⚠️ Original GitHub issue was deleted',
            `Last Synced: ${new Date().toISOString()}`
        ].filter(Boolean).join('\n'),
        projectId,
        teamId,
        stateId: githubIssue.state.toLowerCase() === 'closed' || !githubIssueExists
            ? states.done.id
            : states.backlog.id,
    };

    return existingIssue
        ? await existingIssue.update(issueData)
        : await client.createIssue(issueData);
}

// Step 4: Usage example
export async function syncIssues(
    client: LinearClient,
    githubClient: Octokit,
    issues: GithubIssue[],
    projectId: string,
    teamId: string
): Promise<SyncResults> {
    const results = await Promise.allSettled(
        issues.map(issue =>
            syncGithubIssueToLinear(
                client,
                githubClient,
                issue,
                projectId,
                teamId
            )
        )
    );

    return {
        succeeded: results
            .filter((r): r is PromiseFulfilledResult<IssuePayload> =>
                r.status === 'fulfilled'
            )
            .map(r => r.value),
        failed: results
            .filter((r): r is PromiseRejectedResult =>
                r.status === 'rejected'
            )
            .map(r => ({
                error: r.reason,
                message: r.reason instanceof Error ? r.reason.message : 'Unknown error'
            }))
    };
}


// src/types.ts
export interface SyncResult {
    succeeded: LinearIssue[]
    failed: Array<{
        error: unknown
        message: string
    }>
}
