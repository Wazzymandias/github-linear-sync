#!/usr/bin/env node
import { Command } from 'commander';
import {findExistingIssue, getLinearClient, syncIssues, type SyncResults} from '../api/LinearAPI';
import {createGithubClient, fetchGithubIssues, validateGithubToken} from '../api/GitHubAPI';
import { LinearClient, IssuePayload } from '@linear/sdk';
import dotenv from 'dotenv';

dotenv.config();

const program = new Command();

function validateEnvVars(...vars: string[]) {
    const missing = vars.filter(v => !process.env[v]);
    if (missing.length) {
        console.error(`Missing required environment variables: ${missing.join(', ')}`);
        process.exit(1);
    }
}

program
    .command('linear')
    .description('Linear-related commands')
    .addCommand(
        new Command('ls')
            .description('List Linear resources')
            // Keep existing general ls command
            .action(async () => {
                validateEnvVars('LINEAR_API_KEY');
                const linear = getLinearClient();

                const teams = await linear.teams();
                console.log('\nTeams:');
                for (const team of teams.nodes) {
                    console.log(`- ${team.name} (${team.id})`);
                }

                const projects = await linear.projects();
                console.log('\nProjects:');
                for (const project of projects.nodes) {
                    console.log(`- ${project.name} (${project.id})`);
                }
            })
            // Add the new team-specific command
            .addCommand(
                new Command('team')
                    .description('List all accessible Linear teams and their IDs')
                    .option('-j, --json', 'Output in JSON format')
                    .action(async (opts) => {
                        validateEnvVars('LINEAR_API_KEY');
                        const linear = getLinearClient();
                        const teams = await linear.teams();

                        if (teams.nodes.length === 0) {
                            console.log('No teams found');
                            return;
                        }

                        if (opts.json) {
                            console.log(JSON.stringify(teams.nodes, null, 2));
                            return;
                        }

                        console.table(
                            teams.nodes.map(team => ({
                                Name: team.name,
                                ID: team.id,
                                Key: team.key,
                                'Issue Count': team.issueCount,
                                Private: team.private ? '🔒' : '🌐'
                            }))
                        );
                    })
            )
    );


program
    .command('sync')
    .description('Sync GitHub issues to Linear')
    .requiredOption('-r, --repos <repos...>', 'GitHub repositories (owner/repo format)')
    .requiredOption('-t, --team <id>', 'Linear team ID')
    .requiredOption('-p, --project <id>', 'Linear project ID')
    .option('-a, --authors <authors...>', 'Filter by GitHub usernames')
    .option('-s, --since <date>', 'Sync issues updated since date (YYYY-MM-DD)')
    .option('-i, --interactive', 'Interactively sync issues (default: true)', true)
    .action(async (opts) => {
        validateEnvVars('GITHUB_TOKEN', 'LINEAR_API_KEY');

        const github = createGithubClient(process.env.GITHUB_TOKEN!);
        const linear = getLinearClient();

        // Validate authors if provided
        if (opts.authors?.length) {
            console.log('Validating GitHub users...');
            const authorValidations = await Promise.all(
                opts.authors.map(async (author: any) => {
                    try {
                        await github.users.getByUsername({username: author});
                        return {author, valid: true};
                    } catch {
                        return {author, valid: false};
                    }
                })
            );
            const invalidAuthors = authorValidations.filter(v => !v.valid);
            if (invalidAuthors.length) {
                console.error('Invalid GitHub usernames:', invalidAuthors.map(a => a.author).join(', '));
                process.exit(1);
            }
            console.log(`Users validated ${opts.authors}`);
        }

        console.log(`Fetching GitHub issues [authors: ${opts.authors}] [repos: ${opts.repos}]...`);
        const issues = await fetchGithubIssues(github, {
            repos: opts.repos,
            authors: opts.authors,
            since: opts.since ? new Date(opts.since) : undefined
        });

        if (issues.length === 0) {
            console.log(`No issues found, exiting...`)
            process.exit(0);
        }
        console.log(`Found ${issues.length} issues to sync`);

        const filteredIssues = await Promise.all(
            issues.map(async (issue) => {
                const existingIssue = await findExistingIssue(linear, issue);
                return (existingIssue === null && issue.state.toLowerCase() === 'closed') ? undefined : issue;
            })
        );
        const filtered = filteredIssues.filter(issue => issue !== undefined);
        console.log(`Filtered ${issues.length - filtered.length} issues which were closed on Github and did not exist on Linear`);

        // Preview issues in interactive mode
        if (opts.interactive) {
            console.log('\nIssues to be synced:');
            console.table(
                filtered
                    .map(issue => ({
                    'GitHub Title': issue.title,
                    'GitHub State': issue.state,
                    'GitHub URL': issue.html_url,
                    'Linear State': issue.state === 'closed' ? 'Done' : 'Backlog',
                    'Linear Title': issue.title,
                    'Linear Project': opts.project
                }))
            );

            const response = confirm(`Proceed with syncing ${filtered.length} issues?`);
            if (!response) {
                console.log('Sync cancelled');
                return;
            }
        }

        console.log('Syncing to Linear...');
        const results = await syncIssues(
            linear,
            github,
            filtered,
            opts.project,
            opts.team
        ) as SyncResults;

        console.log('\nSync complete:');
        console.log(`✅ ${results.succeeded.length} issues synced successfully`);
        if (results.failed.length) {
            console.log(`❌ ${results.failed.length} issues failed to sync:`);
            results.failed.forEach(({ message }: { message: string }) => {
                console.log(`  - ${message}`);
            });
        }
    });


// Add this to the existing CLI file, before program.parse()

program
    .command('github')
    .description('GitHub-related commands')
    .addCommand(
        new Command('ls')
            .description('List GitHub resources')
            .addCommand(
                new Command('orgs')
                    .description('List accessible GitHub organizations')
                    .option('-j, --json', 'Output in JSON format')
                    .action(async (opts) => {
                        validateEnvVars('GITHUB_TOKEN');
                        const github = createGithubClient(process.env.GITHUB_TOKEN!);
                        await validateGithubToken(github);

                        const response = await github.orgs.listMembershipsForAuthenticatedUser();

                        if (response.data.length === 0) {
                            console.log(`No organizations found [${JSON.stringify(response)}]`);
                            return;
                        }

                        if (opts.json) {
                            console.log(JSON.stringify(response.data, null, 2));
                            return;
                        }

                        console.table(
                            response.data.map(org => ({
                                Name: org.organization,
                                URL: org.url,
                                State: org.state
                            }))
                        );
                    })
            )
            // List issues
            .addCommand(
                new Command('issues')
                    .description('List GitHub issues')
                    .option('-o, --org <org>', 'Filter by organization')
                    .option('-r, --repo <repo>', 'Filter by repository (format: owner/repo)')
                    .option('-a, --author <author>', 'Filter by issue author')
                    .option('-s, --since <date>', 'Filter by issues updated since date (YYYY-MM-DD)')
                    .option('-j, --json', 'Output in JSON format')
                    .action(async (opts) => {
                        validateEnvVars('GITHUB_TOKEN');
                        const github = createGithubClient(process.env.GITHUB_TOKEN!);

                        let repos: string[] = [];

                        if (opts.repo) {
                            repos = [opts.repo];
                        } else if (opts.org) {
                            const { data: orgRepos } = await github.repos.listForOrg({
                                org: opts.org,
                                per_page: 100
                            });
                            repos = orgRepos.map(repo => `${repo.owner.login}/${repo.name}`);
                        } else {
                            const { data: userRepos } = await github.repos.listForAuthenticatedUser({
                                per_page: 100
                            });
                            repos = userRepos.map(repo => `${repo.owner.login}/${repo.name}`);
                        }

                        console.log(`Fetching issues from ${repos.length} repositories...`);

                        const issues = await fetchGithubIssues(github, {
                            repos,
                            authors: opts.author ? [opts.author] : undefined,
                            since: opts.since ? new Date(opts.since) : undefined
                        });

                        if (issues.length === 0) {
                            console.log('No issues found');
                            return;
                        }

                        if (opts.json) {
                            console.log(JSON.stringify(issues, null, 2));
                            return;
                        }

                        console.table(
                            issues.map(issue => ({
                                Title: issue.title,
                                State: issue.state,
                                Repository: issue.repository_url?.split('/').slice(-2).join('/'),
                                Author: issue.user?.login || '-',
                                URL: issue.html_url,
                                Updated: new Date(issue.updated_at).toLocaleDateString()
                            }))
                        );
                    })
            )
    );

program.version('1.0.0');
program.parse(process.argv);
