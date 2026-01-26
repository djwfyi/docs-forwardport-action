import { Context } from '@actions/github/lib/context';

// Create a properly typed mock GitHub client
export const createMockGitHubClient = () => {
  return {
    rest: {
      pulls: {
        listFiles: jest.fn().mockResolvedValue({
          data: [
            { filename: 'vcluster_versioned_docs/version-0.22.0/guide.md', status: 'modified' },
            { filename: 'platform_versioned_docs/version-4.2.0/intro.md', status: 'modified' },
            { filename: 'other/file.md', status: 'modified' }
          ]
        }),
        list: jest.fn().mockResolvedValue({
          data: []
        }),
        create: jest.fn().mockResolvedValue({
          data: { number: 456 }
        })
      },
      repos: {
        get: jest.fn().mockResolvedValue({
          data: { default_branch: 'main' }
        }),
        getContent: jest.fn().mockResolvedValue({
          data: { content: Buffer.from('Test content').toString('base64') }
        }),
        createOrUpdateFileContents: jest.fn().mockResolvedValue({})
      },
      git: {
        getRef: jest.fn().mockResolvedValue({
          data: { object: { sha: 'def456' } }
        }),
        createRef: jest.fn().mockResolvedValue({})
      },
      issues: {
        addLabels: jest.fn().mockResolvedValue({})
      }
    }
  };
};

// Create a mock context that matches the Context type
export const createMockContext = (overrides: any = {}): Partial<Context> => {
  return {
    eventName: 'pull_request',
    sha: 'abc123',
    ref: 'refs/heads/main',
    workflow: 'Test Workflow',
    action: 'Test Action',
    actor: 'test-user',
    job: 'test-job',
    runNumber: 1,
    runId: 123456,
    apiUrl: 'https://api.github.com',
    serverUrl: 'https://github.com',
    graphqlUrl: 'https://api.github.com/graphql',
    repo: {
      owner: 'loft-sh',
      repo: 'vcluster-docs'
    },
    issue: {
      owner: 'loft-sh',
      repo: 'vcluster-docs',
      number: 123
    },
    payload: {
      action: 'closed',
      pull_request: {
        number: 123,
        merged: true,
        labels: [{ name: 'forwardport-main' }],
        head: { sha: 'abc123' },
        title: 'Original PR Title'
      },
      repository: {
        default_branch: 'main'
      }
    },
    ...overrides
  };
};
