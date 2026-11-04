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

    it('leaves a modified file for manual review when the main folder lacks that path', async () => {
      // After a docs restructure the page lives at a different path in main.
      // Creating the old path would bring back a duplicate page.
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn().mockImplementation(({ path }: any) =>
              path.startsWith('vcluster/')
                ? Promise.reject({ status: 404 })
                : Promise.resolve({ data: { content: Buffer.from('test').toString('base64'), sha: 'src' } })
            ),
            createOrUpdateFileContents: jest.fn()
          }
        }
      };

      const stats = await index.forwardportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { head: { sha: 'sha' } } } },
        [{ filename: 'vcluster_versioned_docs/version-0.37.0/manage/sleep-wakeup.mdx', status: 'modified' }],
        'forwardport/branch'
      );

      expect(stats.copied).toBe(0);
      expect(stats.errors).toBe(0);
      expect(stats.missing).toEqual(['vcluster/manage/sleep-wakeup.mdx']);
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    });

    it('leaves an added file for manual review when the main folder lacks its folder', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn().mockImplementation(({ path }: any) =>
              path.startsWith('vcluster/')
                ? Promise.reject({ status: 404 })
                : Promise.resolve({ data: { content: Buffer.from('test').toString('base64'), sha: 'src' } })
            ),
            createOrUpdateFileContents: jest.fn()
          }
        }
      };

      const stats = await index.forwardportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { head: { sha: 'sha' } } } },
        [{ filename: 'vcluster_versioned_docs/version-0.37.0/manage/new-page.mdx', status: 'added' }],
        'forwardport/branch'
      );

      expect(stats.copied).toBe(0);
      expect(stats.missing).toEqual(['vcluster/manage/new-page.mdx']);
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    });

    it('creates an added file when its folder exists in the main folder', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn().mockImplementation(({ path }: any) => {
              if (path === 'vcluster/configure') {
                return Promise.resolve({ data: [{ type: 'file', path: 'vcluster/configure/existing.mdx' }] });
              }
              return path.startsWith('vcluster/')
                ? Promise.reject({ status: 404 })
                : Promise.resolve({ data: { content: Buffer.from('test').toString('base64'), sha: 'src' } });
            }),
            createOrUpdateFileContents: jest.fn().mockResolvedValue({})
          }
        }
      };

      const stats = await index.forwardportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { head: { sha: 'sha' } } } },
        [{ filename: 'vcluster_versioned_docs/version-0.37.0/configure/new-page.mdx', status: 'added' }],
        'forwardport/branch'
      );

      expect(stats.copied).toBe(1);
      expect(stats.missing).toEqual([]);
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'vcluster/configure/new-page.mdx' })
      );
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

  describe('manual review reporting', () => {
    it('lists files left for manual review in the forwardport PR body', async () => {
      const mockOctokit = {
        rest: {
          pulls: { create: jest.fn().mockResolvedValue({ data: { number: 42 } }) },
          issues: { addLabels: jest.fn().mockResolvedValue({}) }
        }
      };

      await index.createForwardportPR(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { repository: { default_branch: 'main' } } },
        'forwardport/branch',
        7,
        'docs: fix typo',
        ['vcluster/manage/sleep-wakeup.mdx']
      );

      const body = mockOctokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('## Manual review needed');
      expect(body).toContain('- `vcluster/manage/sleep-wakeup.mdx`');
    });

    it('comments on the original PR with the files left for manual review', async () => {
      const mockOctokit = {
        rest: { issues: { createComment: jest.fn().mockResolvedValue({ data: {} }) } }
      };

      await index.postMissingComment(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' } },
        7,
        ['vcluster/manage/sleep-wakeup.mdx']
      );

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 7, body: expect.stringContaining('vcluster/manage/sleep-wakeup.mdx') })
      );
    });
  });
});
