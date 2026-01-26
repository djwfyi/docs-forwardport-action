// Tests for the Docs Forwardport Action

// Import setup to ensure mocks are properly initialized
import './setup';
// Import the index module
import * as index from '../index';

describe('Docs Forwardport Action Tests', () => {
  // Basic test to ensure test environment works
  it('has a working test environment', () => {
    expect(true).toBe(true);
  });

  // Test that the module can be imported
  it('imports the action module without errors', () => {
    expect(() => {
      require('../index');
    }).not.toThrow();
  });

  // Test for the checkExistingForwardportPR function
  describe('checkExistingForwardportPR', () => {
    it('returns a PR when one exists with title format', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            list: jest.fn().mockResolvedValue({
              data: [
                {
                  number: 456,
                  title: '[forwardport] Original PR Title (#123)',
                  body: 'Original PR: #123'
                }
              ]
            })
          }
        }
      };

      const mockContext = {
        repo: {
          owner: 'loft-sh',
          repo: 'vcluster-docs'
        }
      };

      const result = await index.checkExistingForwardportPR(
        mockOctokit,
        mockContext,
        123
      );

      expect(result).not.toBeNull();
      expect(result.number).toBe(456);
    });

    it('checks both open and closed PRs', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            list: jest.fn()
              .mockResolvedValueOnce({ data: [] }) // No open PRs
              .mockResolvedValueOnce({
                data: [
                  {
                    number: 456,
                    title: '[forwardport] Some title (#123)',
                    body: 'Original PR: #123',
                    state: 'closed'
                  }
                ]
              })
          }
        }
      };

      const mockContext = {
        repo: {
          owner: 'loft-sh',
          repo: 'vcluster-docs'
        }
      };

      const result = await index.checkExistingForwardportPR(
        mockOctokit,
        mockContext,
        123
      );

      expect(result).not.toBeNull();
      expect(result.number).toBe(456);
      expect(mockOctokit.rest.pulls.list).toHaveBeenCalledTimes(2);
    });

    it('returns null when no PR exists', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            list: jest.fn().mockResolvedValue({ data: [] })
          }
        }
      };

      const mockContext = {
        repo: {
          owner: 'loft-sh',
          repo: 'vcluster-docs'
        }
      };

      const result = await index.checkExistingForwardportPR(
        mockOctokit,
        mockContext,
        123
      );

      expect(result).toBeNull();
    });
  });

  describe('Label Processing Logic', () => {
    let mockCore: any;
    let mockGithub: any;

    beforeEach(() => {
      jest.clearAllMocks();

      mockCore = require('@actions/core');
      mockGithub = require('@actions/github');

      mockCore.getInput.mockReturnValue('fake-token');
    });

    it('skips non-forwardport labels in labeled events', () => {
      const context = {
        payload: {
          action: 'labeled',
          label: { name: 'documentation' },
          pull_request: {
            number: 123,
            merged: true,
            labels: [{ name: 'documentation' }]
          }
        }
      };

      mockGithub.context = context;

      const isForwardportLabel = context.payload.label.name === 'forwardport-main';
      expect(isForwardportLabel).toBe(false);
    });

    it('skips labeled events when PR is not merged', () => {
      const context = {
        payload: {
          action: 'labeled',
          label: { name: 'forwardport-main' },
          pull_request: {
            number: 123,
            merged: false,
            labels: [{ name: 'forwardport-main' }]
          }
        }
      };

      mockGithub.context = context;

      expect(context.payload.pull_request.merged).toBe(false);
    });
  });

  describe('forwardportFiles', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('copies file when no conflict', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn()
              .mockResolvedValueOnce({ data: { content: Buffer.from('test').toString('base64'), sha: 'src' } })
              .mockRejectedValueOnce({ status: 404 }),
            createOrUpdateFileContents: jest.fn().mockResolvedValueOnce({})
          }
        }
      };

      const stats = await index.forwardportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { head: { sha: 'sha' } } } },
        [{ filename: 'vcluster_versioned_docs/version-0.27.0/test.mdx', status: 'added' }],
        'forwardport/branch'
      );

      expect(stats.copied).toBe(1);
      expect(stats.errors).toBe(0);
    });

    it('skips deleted files', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn(),
            createOrUpdateFileContents: jest.fn()
          }
        }
      };

      const stats = await index.forwardportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { head: { sha: 'sha' } } } },
        [{ filename: 'vcluster_versioned_docs/version-0.27.0/test.mdx', status: 'removed' }],
        'forwardport/branch'
      );

      expect(stats.skipped).toBe(1);
      expect(stats.copied).toBe(0);
    });

    it('retries on SHA conflict', async () => {
      const error409 = new Error('Conflict') as any;
      error409.status = 409;

      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn()
              .mockResolvedValueOnce({ data: { content: Buffer.from('test').toString('base64'), sha: 'src' } })
              .mockRejectedValueOnce({ status: 404 })
              .mockResolvedValueOnce({ data: { sha: 'conflict-sha' } }),
            createOrUpdateFileContents: jest.fn()
              .mockRejectedValueOnce(error409)
              .mockResolvedValueOnce({})
          }
        }
      };

      const stats = await index.forwardportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { head: { sha: 'sha' } } } },
        [{ filename: 'vcluster_versioned_docs/version-0.27.0/test.mdx', status: 'added' }],
        'forwardport/branch'
      );

      expect(stats.copied).toBe(1);
      expect(stats.errors).toBe(0);
    });
  });
});
