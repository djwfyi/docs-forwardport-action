import * as core from '@actions/core';
import * as github from '@actions/github';

// Define versioned folders and their main counterparts
const FOLDER_MAPPING: Record<string, string> = {
  'platform_versioned_docs': 'platform',
  'vcluster_versioned_docs': 'vcluster'
};

// Label that triggers forwardport
const FORWARDPORT_LABEL = 'forwardport-main';

// Type for a GitHub label
interface GitHubLabel {
  name: string;
  color?: string;
  description?: string;
}

// Main function, exported for testing
export async function run(): Promise<void> {
  try {
    // Get inputs
    const token = core.getInput('github_token', { required: true });

    const octokit = github.getOctokit(token);
    const context = github.context;

    // Check if this is a PR event
    if (!context.payload.pull_request) {
      core.setFailed('This action can only be run on pull request events');
      return;
    }

    // Get PR details
    const prNumber = context.payload.pull_request.number;
    const merged = context.payload.pull_request.merged || false;
    const labels = context.payload.pull_request.labels || [];

    // Check if this is a label event
    if (context.payload.action === 'labeled') {
      const addedLabel = context.payload.label?.name || '';

      if (addedLabel !== FORWARDPORT_LABEL) {
        core.info(`Added label "${addedLabel}" is not ${FORWARDPORT_LABEL}, skipping`);
        return;
      }

      // Only process label events if the PR is already merged
      if (!merged) {
        core.info('PR is labeled but not merged yet, skipping forwardport until merge');
        return;
      }
    } else {
      // For closed events, check if it's merged and has the label
      if (!merged) {
        core.info('PR not merged, skipping');
        return;
      }

      const hasLabel = labels.some((l: GitHubLabel) => l.name === FORWARDPORT_LABEL);
      if (!hasLabel) {
        core.info(`No ${FORWARDPORT_LABEL} label found, skipping`);
        return;
      }
    }

    // Get changed files from the PR
    const { data: files } = await octokit.rest.pulls.listFiles({
      ...context.repo,
      pull_number: prNumber
    });

    // Filter to versioned doc files only
    const versionedFiles = files.filter(file => {
      return file.filename.startsWith('vcluster_versioned_docs/') ||
             file.filename.startsWith('platform_versioned_docs/');
    });

    if (versionedFiles.length === 0) {
      core.info('No versioned doc files changed, skipping');
      return;
    }

    // Check if a forwardport PR already exists for this PR
    const existingPR = await checkExistingForwardportPR(
      octokit,
      context,
      prNumber
    );

    if (existingPR) {
      core.info(`Forwardport PR #${existingPR.number} already exists for PR #${prNumber}, skipping`);
      return;
    }

    // Create a branch for this forwardport
    const timestamp = new Date().getTime();
    const branchName = `forwardport/to-main-${prNumber}-${timestamp}`;

    // Create the branch
    await createBranch(octokit, context, branchName);

    // Process files and get stats
    const stats = await forwardportFiles(
      octokit,
      context,
      versionedFiles,
      branchName
    );

    // Only create a PR if we successfully copied at least one file
    if (stats.copied > 0) {
      // Get original PR title
      const originalPRTitle = context.payload.pull_request.title;

      // Create a PR
      await createForwardportPR(
        octokit,
        context,
        branchName,
        prNumber,
        originalPRTitle
      );
    } else {
      core.info('No files were successfully copied, skipping PR creation');
    }

  } catch (error: any) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

async function createBranch(
  octokit: any,
  context: any,
  branchName: string
): Promise<void> {
  // Get the default branch
  const { data: repo } = await octokit.rest.repos.get({
    ...context.repo
  });

  const defaultBranch = repo.default_branch;

  // Get the ref for the default branch
  const { data: ref } = await octokit.rest.git.getRef({
    ...context.repo,
    ref: `heads/${defaultBranch}`
  });

  // Create the new branch
  await octokit.rest.git.createRef({
    ...context.repo,
    ref: `refs/heads/${branchName}`,
    sha: ref.object.sha
  });

  core.info(`Created branch ${branchName}`);
}

// Interface for forwardport statistics
interface ForwardportStats {
  copied: number;
  skipped: number;
  errors: number;
}

// Exported for testing
export async function forwardportFiles(
  octokit: any,
  context: any,
  files: any[],
  branchName: string
): Promise<ForwardportStats> {
  // Track stats for reporting
  let copied = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files) {
    try {
      // Skip if file was deleted in the PR
      if (file.status === 'removed') {
        core.info(`Skipping deleted file: ${file.filename}`);
        skipped++;
        continue;
      }

      // Parse the versioned path
      // e.g., vcluster_versioned_docs/version-0.27.0/configure/foo.mdx
      const parts = file.filename.split('/');
      const versionedFolder = parts[0]; // e.g., vcluster_versioned_docs
      // parts[1] is version-X.Y.Z, skip it
      const relativePath = parts.slice(2).join('/'); // e.g., configure/foo.mdx

      const mainFolder = FOLDER_MAPPING[versionedFolder];
      if (!mainFolder) {
        core.info(`Unknown versioned folder: ${versionedFolder}, skipping`);
        skipped++;
        continue;
      }

      const targetPath = `${mainFolder}/${relativePath}`;

      core.info(`Forwardporting ${file.filename} to ${targetPath}`);

      // Get the file content from the PR's head branch
      const { data: content } = await octokit.rest.repos.getContent({
        ...context.repo,
        path: file.filename,
        ref: context.payload.pull_request.head.sha
      });

      // Check if the target file already exists to get its SHA
      let sha = '';
      try {
        const { data: existingFile } = await octokit.rest.repos.getContent({
          ...context.repo,
          path: targetPath,
          ref: branchName
        });
        sha = existingFile.sha;
      } catch (error) {
        // File doesn't exist yet, which is fine
        core.info(`Target file doesn't exist yet, will create: ${targetPath}`);
      }

      // Create or update the file in the main folder
      try {
        await octokit.rest.repos.createOrUpdateFileContents({
          ...context.repo,
          path: targetPath,
          message: `Forwardport: Copy ${file.filename} to ${targetPath}`,
          content: typeof content.content === 'string' ? content.content : Buffer.from(content.content).toString('base64'),
          branch: branchName,
          sha: sha || undefined
        });
      } catch (createError: any) {
        // Check if this is a SHA conflict (file was created between check and write)
        const isShaConflict = createError.status === 409 || createError.message?.includes('but expected');
        if (isShaConflict) {
          core.info(`SHA conflict detected for ${targetPath}, retrying with current SHA...`);

          // Re-fetch the current SHA
          const { data: conflictFile } = await octokit.rest.repos.getContent({
            ...context.repo,
            path: targetPath,
            ref: branchName
          });

          // Retry with the correct SHA
          await octokit.rest.repos.createOrUpdateFileContents({
            ...context.repo,
            path: targetPath,
            message: `Forwardport: Copy ${file.filename} to ${targetPath}`,
            content: typeof content.content === 'string' ? content.content : Buffer.from(content.content).toString('base64'),
            branch: branchName,
            sha: conflictFile.sha
          });
          core.info(`Retry successful for ${targetPath}`);
        } else {
          throw createError;
        }
      }

      copied++;
      core.info(`Forwardported ${file.filename} to ${targetPath}`);
    } catch (error: any) {
      errors++;
      core.warning(`Error forwardporting file ${file.filename}: ${error.message}`);
    }
  }

  // Create stats object
  const stats: ForwardportStats = {
    copied,
    skipped,
    errors
  };

  core.info(`Forwardport stats - Copied: ${copied}, Skipped: ${skipped}, Errors: ${errors}`);

  // Return the stats
  return stats;
}

// Exported for testing
export async function checkExistingForwardportPR(
  octokit: any,
  context: any,
  originalPRNumber: number
): Promise<any | null> {
  try {
    // Search for both open and closed PRs that mention the original PR number
    const states: Array<'open' | 'closed'> = ['open', 'closed'];

    for (const state of states) {
      const { data: prs } = await octokit.rest.pulls.list({
        ...context.repo,
        state: state,
        sort: 'created',
        direction: 'desc',
        per_page: 100
      });

      // Look for PRs with the forwardport title format
      for (const pr of prs) {
        const matchesTitle = pr.title.includes('[forwardport]') && pr.title.includes(`(#${originalPRNumber})`);
        const referencesOriginalPR = pr.body && pr.body.includes(`Original PR: #${originalPRNumber}`);

        if (matchesTitle || referencesOriginalPR) {
          core.info(`Found existing ${state} forwardport PR #${pr.number} from PR #${originalPRNumber}`);
          return pr;
        }
      }
    }

    return null;
  } catch (error: any) {
    core.warning(`Error checking for existing forwardport PRs: ${error.message}`);
    return null;
  }
}

// Exported for testing
export async function createForwardportPR(
  octokit: any,
  context: any,
  branchName: string,
  originalPRNumber: number,
  originalPRTitle: string
): Promise<void> {
  // Create PR title in the format: [forwardport] original title (#original_pr_number)
  const prTitle = `[forwardport] ${originalPRTitle} (#${originalPRNumber})`;

  // Create a PR
  const { data: pr } = await octokit.rest.pulls.create({
    ...context.repo,
    title: prTitle,
    body: `This PR forwardports changes from versioned docs to the main documentation folder.\n\nOriginal PR: #${originalPRNumber}`,
    head: branchName,
    base: context.payload.repository.default_branch
  });

  // Add labels to the new PR
  await octokit.rest.issues.addLabels({
    ...context.repo,
    issue_number: pr.number,
    labels: ['forwardport']
  });

  core.info(`Created forwardport PR #${pr.number}`);
}

run();
