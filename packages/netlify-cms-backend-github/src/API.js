import { Base64 } from 'js-base64';
import semaphore from 'semaphore';
import { find, flow, get, hasIn, initial, last, partial, result, differenceBy } from 'lodash';
import trimStart from 'lodash/trimStart';
import { map } from 'lodash/fp';
import {
  getAllResponses,
  APIError,
  EditorialWorkflowError,
  filterPromisesWith,
  localForage,
  onlySuccessfulPromises,
  resolvePromiseProperties,
} from 'netlify-cms-lib-util';

const CMS_BRANCH_PREFIX = 'cms';

const replace404WithEmptyArray = err => {
  if (err && err.status === 404) {
    console.log('This 404 was expected and handled appropriately.');
    return [];
  } else {
    return Promise.reject(err);
  }
};

export default class API {
  constructor(config) {
    this.api_root = config.api_root || 'https://api.github.com';
    this.token = config.token || false;
    this.branch = config.branch || 'master';
    this.useOpenAuthoring = config.useOpenAuthoring;
    this.repo = config.repo || '';
    this.originRepo = config.originRepo || this.repo;
    this.repoURL = `/repos/${this.repo}`;
    // when not in 'useOpenAuthoring' mode originRepoURL === repoURL
    this.originRepoURL = `/repos/${this.originRepo}`;
    this.merge_method = config.squash_merges ? 'squash' : 'merge';
    this.initialWorkflowStatus = config.initialWorkflowStatus;
  }

  static DEFAULT_COMMIT_MESSAGE = 'Automatically generated by Netlify CMS';
  static DEFAULT_PR_BODY = 'Automatically generated by Netlify CMS';

  user() {
    if (!this._userPromise) {
      this._userPromise = this.request('/user');
    }
    return this._userPromise;
  }

  hasWriteAccess() {
    return this.request(this.repoURL)
      .then(repo => repo.permissions.push)
      .catch(error => {
        console.error('Problem fetching repo data from GitHub');
        throw error;
      });
  }

  requestHeaders(headers = {}) {
    const baseHeader = {
      'Content-Type': 'application/json',
      ...headers,
    };

    if (this.token) {
      baseHeader.Authorization = `token ${this.token}`;
      return baseHeader;
    }

    return baseHeader;
  }

  parseJsonResponse(response) {
    return response.json().then(json => {
      if (!response.ok) {
        return Promise.reject(json);
      }

      return json;
    });
  }

  urlFor(path, options) {
    const cacheBuster = new Date().getTime();
    const params = [`ts=${cacheBuster}`];
    if (options.params) {
      for (const key in options.params) {
        params.push(`${key}=${encodeURIComponent(options.params[key])}`);
      }
    }
    if (params.length) {
      path += `?${params.join('&')}`;
    }
    return this.api_root + path;
  }

  parseResponse(response) {
    const contentType = response.headers.get('Content-Type');
    if (contentType && contentType.match(/json/)) {
      return this.parseJsonResponse(response);
    }
    const textPromise = response.text().then(text => {
      if (!response.ok) {
        return Promise.reject(text);
      }
      return text;
    });
    return textPromise;
  }

  handleRequestError(error, responseStatus) {
    throw new APIError(error.message, responseStatus, 'GitHub');
  }

  async request(path, options = {}, parseResponse = response => this.parseResponse(response)) {
    // overriding classes can return a promise from requestHeaders
    const headers = await this.requestHeaders(options.headers || {});
    const url = this.urlFor(path, options);
    let responseStatus;
    return fetch(url, { ...options, headers })
      .then(response => {
        responseStatus = response.status;
        return parseResponse(response);
      })
      .catch(error => this.handleRequestError(error, responseStatus));
  }

  async requestAllPages(url, options = {}) {
    // overriding classes can return a promise from requestHeaders
    const headers = await this.requestHeaders(options.headers || {});
    const processedURL = this.urlFor(url, options);
    const allResponses = await getAllResponses(processedURL, { ...options, headers });
    const pages = await Promise.all(allResponses.map(res => this.parseResponse(res)));
    return [].concat(...pages);
  }

  generateContentKey(collectionName, slug) {
    if (!this.useOpenAuthoring) {
      // this doesn't use the collection, but we need to leave it that way for backwards
      // compatibility
      return slug;
    }

    return `${this.repo}/${collectionName}/${slug}`;
  }

  generateBranchName(contentKey) {
    return `${CMS_BRANCH_PREFIX}/${contentKey}`;
  }

  branchNameFromRef(ref) {
    return ref.substring('refs/heads/'.length);
  }

  contentKeyFromRef(ref) {
    return ref.substring(`refs/heads/${CMS_BRANCH_PREFIX}/`.length);
  }

  checkMetadataRef() {
    return this.request(`${this.repoURL}/git/refs/meta/_netlify_cms`, {
      cache: 'no-store',
    })
      .then(response => response.object)
      .catch(() => {
        // Meta ref doesn't exist
        const readme = {
          raw:
            '# Netlify CMS\n\nThis tree is used by the Netlify CMS to store metadata information for specific files and branches.',
        };

        return this.uploadBlob(readme)
          .then(item =>
            this.request(`${this.repoURL}/git/trees`, {
              method: 'POST',
              body: JSON.stringify({
                tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: item.sha }],
              }),
            }),
          )
          .then(tree => this.commit('First Commit', tree))
          .then(response => this.createRef('meta', '_netlify_cms', response.sha))
          .then(response => response.object);
      });
  }

  async storeMetadata(key, data) {
    // semaphore ensures metadata updates are always ordered, even if
    // calls to storeMetadata are not. concurrent metadata updates
    // will result in the metadata branch being unable to update.
    if (!this._metadataSemaphore) {
      this._metadataSemaphore = semaphore(1);
    }
    return new Promise((resolve, reject) =>
      this._metadataSemaphore.take(async () => {
        try {
          const branchData = await this.checkMetadataRef();
          const fileTree = {
            [`${key}.json`]: {
              path: `${key}.json`,
              raw: JSON.stringify(data),
              file: true,
            },
          };
          await this.uploadBlob(fileTree[`${key}.json`]);
          const changeTree = await this.updateTree(branchData.sha, '/', fileTree);
          const { sha } = await this.commit(`Updating “${key}” metadata`, changeTree);
          await this.patchRef('meta', '_netlify_cms', sha);
          localForage.setItem(`gh.meta.${key}`, {
            expires: Date.now() + 300000, // In 5 minutes
            data,
          });
          this._metadataSemaphore.leave();
          resolve();
        } catch (err) {
          reject(err);
        }
      }),
    );
  }

  retrieveMetadata(key) {
    const cache = localForage.getItem(`gh.meta.${key}`);
    return cache.then(cached => {
      if (cached && cached.expires > Date.now()) {
        return cached.data;
      }
      console.log(
        '%c Checking for MetaData files',
        'line-height: 30px;text-align: center;font-weight: bold',
      );

      const metadataRequestOptions = {
        params: { ref: 'refs/meta/_netlify_cms' },
        headers: { Accept: 'application/vnd.github.VERSION.raw' },
        cache: 'no-store',
      };

      const errorHandler = err => {
        if (err.message === 'Not Found') {
          console.log(
            '%c %s does not have metadata',
            'line-height: 30px;text-align: center;font-weight: bold',
            key,
          );
        }
        throw err;
      };

      if (!this.useOpenAuthoring) {
        return this.request(`${this.repoURL}/contents/${key}.json`, metadataRequestOptions)
          .then(response => JSON.parse(response))
          .catch(errorHandler);
      }

      const [user, repo] = key.split('/');
      return this.request(`/repos/${user}/${repo}/contents/${key}.json`, metadataRequestOptions)
        .then(response => JSON.parse(response))
        .catch(errorHandler);
    });
  }

  retrieveContent(path, branch, repoURL) {
    return this.request(`${repoURL}/contents/${path}`, {
      headers: { Accept: 'application/vnd.github.VERSION.raw' },
      params: { ref: branch },
      cache: 'no-store',
    }).catch(error => {
      if (hasIn(error, 'message.errors') && find(error.message.errors, { code: 'too_large' })) {
        const dir = path
          .split('/')
          .slice(0, -1)
          .join('/');
        return this.listFiles(dir, { repoURL, branch })
          .then(files => files.find(file => file.path === path))
          .then(file => this.getBlob(file.sha, { repoURL }));
      }
      throw error;
    });
  }

  readFile(path, sha, { branch = this.branch, repoURL = this.repoURL } = {}) {
    if (sha) {
      return this.getBlob(sha);
    } else {
      return this.retrieveContent(path, branch, repoURL);
    }
  }

  fetchBlob(sha, repoURL) {
    return this.request(
      `${repoURL}/git/blobs/${sha}`,
      {
        headers: { Accept: 'application/vnd.github.VERSION.raw' },
      },
      response => response,
    );
  }

  async fetchBlobContent(sha, repoURL) {
    const response = await this.fetchBlob(sha, repoURL);
    const text = await response.text();

    return text;
  }

  async getMediaAsBlob(sha, path) {
    const response = await this.fetchBlob(sha, this.repoURL);
    let blob;
    if (path.match(/.svg$/)) {
      const svg = await response.text();
      blob = new Blob([svg], { type: 'image/svg+xml' });
    } else {
      blob = await response.blob();
    }
    return blob;
  }

  async getMediaDisplayURL(sha, path) {
    const blob = await this.getMediaAsBlob(sha, path);

    return URL.createObjectURL(blob);
  }

  getBlob(sha, { repoURL = this.repoURL } = {}) {
    return localForage.getItem(`gh.${sha}`).then(cached => {
      if (cached) {
        return cached;
      }

      return this.fetchBlobContent(sha, repoURL).then(result => {
        localForage.setItem(`gh.${sha}`, result);
        return result;
      });
    });
  }

  listFiles(path, { repoURL = this.repoURL, branch = this.branch } = {}) {
    return this.request(`${repoURL}/contents/${path.replace(/\/$/, '')}`, {
      params: { ref: branch },
    })
      .then(files => {
        if (!Array.isArray(files)) {
          throw new Error(`Cannot list files, path ${path} is not a directory but a ${files.type}`);
        }
        return files;
      })
      .then(files => files.filter(file => file.type === 'file'));
  }

  readUnpublishedBranchFile(contentKey) {
    const metaDataPromise = this.retrieveMetadata(contentKey).then(data =>
      data.objects.entry.path ? data : Promise.reject(null),
    );
    const repoURL = this.useOpenAuthoring
      ? `/repos/${contentKey
          .split('/')
          .slice(0, 2)
          .join('/')}`
      : this.repoURL;
    return resolvePromiseProperties({
      metaData: metaDataPromise,
      fileData: metaDataPromise.then(data =>
        this.readFile(data.objects.entry.path, null, {
          branch: data.branch,
          repoURL,
        }),
      ),
      isModification: metaDataPromise.then(data =>
        this.isUnpublishedEntryModification(data.objects.entry.path, this.branch),
      ),
    }).catch(() => {
      throw new EditorialWorkflowError('content is not under editorial workflow', true);
    });
  }

  isUnpublishedEntryModification(path, branch) {
    return this.readFile(path, null, {
      branch,
      repoURL: this.originRepoURL,
    })
      .then(() => true)
      .catch(err => {
        if (err.message && err.message === 'Not Found') {
          return false;
        }
        throw err;
      });
  }

  getPRsForBranchName = ({
    branchName,
    state,
    base = this.branch,
    repoURL = this.repoURL,
    usernameOfFork,
  } = {}) => {
    // Get PRs with a `head` of `branchName`. Note that this is a
    // substring match, so we need to check that the `head.ref` of
    // at least one of the returned objects matches `branchName`.
    return this.requestAllPages(`${repoURL}/pulls`, {
      params: {
        head: usernameOfFork ? `${usernameOfFork}:${branchName}` : branchName,
        ...(state ? { state } : {}),
        base,
      },
    });
  };

  branchHasPR = async ({ branchName, ...rest }) => {
    const prs = await this.getPRsForBranchName({ branchName, ...rest });
    return prs.some(pr => pr.head.ref === branchName);
  };

  getUpdatedOpenAuthoringMetadata = async (contentKey, { metadata: metadataArg } = {}) => {
    const metadata = metadataArg || (await this.retrieveMetadata(contentKey)) || {};
    const { pr: prMetadata, status } = metadata;

    // Set the status to draft if no corresponding PR is recorded
    if (!prMetadata && status !== 'draft') {
      const newMetadata = { ...metadata, status: 'draft' };
      this.storeMetadata(contentKey, newMetadata);
      return newMetadata;
    }

    // If no status is recorded, but there is a PR, check if the PR is
    // closed or not and update the status accordingly.
    if (prMetadata) {
      const { number: prNumber } = prMetadata;
      const originPRInfo = await this.getPullRequest(prNumber);
      const { state: currentState, merged_at: mergedAt } = originPRInfo;
      if (currentState === 'closed' && mergedAt) {
        // The PR has been merged; delete the unpublished entry
        const [, collectionName, slug] = contentKey.split('/');
        this.deleteUnpublishedEntry(collectionName, slug);
        return;
      } else if (currentState === 'closed' && !mergedAt) {
        if (status !== 'draft') {
          const newMetadata = { ...metadata, status: 'draft' };
          await this.storeMetadata(contentKey, newMetadata);
          return newMetadata;
        }
      } else {
        if (status !== 'pending_review') {
          // PR is open and has not been merged
          const newMetadata = { ...metadata, status: 'pending_review' };
          await this.storeMetadata(contentKey, newMetadata);
          return newMetadata;
        }
      }
    }

    return metadata;
  };

  async listUnpublishedBranches() {
    console.log(
      '%c Checking for Unpublished entries',
      'line-height: 30px;text-align: center;font-weight: bold',
    );
    const onlyBranchesWithOpenPRs = filterPromisesWith(({ ref }) =>
      this.branchHasPR({ branchName: this.branchNameFromRef(ref), state: 'open' }),
    );
    const getUpdatedOpenAuthoringBranches = flow([
      map(async branch => {
        const contentKey = this.contentKeyFromRef(branch.ref);
        const metadata = await this.getUpdatedOpenAuthoringMetadata(contentKey);
        // filter out removed entries
        if (!metadata) {
          return Promise.reject('Unpublished entry was removed');
        }
        return branch;
      }),
      onlySuccessfulPromises,
    ]);
    try {
      const branches = await this.request(`${this.repoURL}/git/refs/heads/cms`).catch(
        replace404WithEmptyArray,
      );
      const filterFunction = this.useOpenAuthoring
        ? getUpdatedOpenAuthoringBranches
        : onlyBranchesWithOpenPRs;
      return await filterFunction(branches);
    } catch (err) {
      console.log(
        '%c No Unpublished entries',
        'line-height: 30px;text-align: center;font-weight: bold',
      );
      throw err;
    }
  }

  /**
   * Retrieve statuses for a given SHA. Unrelated to the editorial workflow
   * concept of entry "status". Useful for things like deploy preview links.
   */
  async getStatuses(sha) {
    try {
      const resp = await this.request(`${this.originRepoURL}/commits/${sha}/status`);
      return resp.statuses;
    } catch (err) {
      if (err && err.message && err.message === 'Ref not found') {
        return [];
      }
      throw err;
    }
  }

  composeFileTree(files) {
    let filename;
    let part;
    let parts;
    let subtree;
    const fileTree = {};

    files.forEach(file => {
      if (file.skip) {
        return;
      }
      parts = file.path.split('/').filter(part => part);
      filename = parts.pop();
      subtree = fileTree;
      while ((part = parts.shift())) {
        subtree[part] = subtree[part] || {};
        subtree = subtree[part];
      }
      subtree[filename] = file;
      file.file = true;
    });

    return fileTree;
  }

  async persistFiles(entry, mediaFiles, options) {
    const files = entry ? mediaFiles.concat(entry) : mediaFiles;

    // mark files to skip, has to be done here as uploadBlob sets the uploaded flag
    files.forEach(file => {
      if (file.uploaded) {
        file.skip = true;
      } else {
        file.skip = false;
      }
    });

    const uploadPromises = files.filter(file => !file.skip).map(file => this.uploadBlob(file));
    await Promise.all(uploadPromises);

    if (!options.useWorkflow) {
      const fileTree = this.composeFileTree(files);

      return this.getBranch()
        .then(branchData => this.updateTree(branchData.commit.sha, '/', fileTree))
        .then(changeTree => this.commit(options.commitMessage, changeTree))
        .then(response => this.patchBranch(this.branch, response.sha));
    } else {
      const mediaFilesList = mediaFiles.map(({ sha, path }) => ({
        path: trimStart(path, '/'),
        sha,
      }));
      return this.editorialWorkflowGit(files, entry, mediaFilesList, options);
    }
  }

  getFileSha(path, branch) {
    /**
     * We need to request the tree first to get the SHA. We use extended SHA-1
     * syntax (<rev>:<path>) to get a blob from a tree without having to recurse
     * through the tree.
     */

    const pathArray = path.split('/');
    const filename = last(pathArray);
    const directory = initial(pathArray).join('/');
    const fileDataPath = encodeURIComponent(directory);
    const fileDataURL = `${this.repoURL}/git/trees/${branch}:${fileDataPath}`;

    return this.request(fileDataURL, { cache: 'no-store' }).then(resp => {
      const { sha } = resp.tree.find(file => file.path === filename);
      return sha;
    });
  }

  deleteFile(path, message, options = {}) {
    if (this.useOpenAuthoring) {
      return Promise.reject('Cannot delete published entries as an Open Authoring user!');
    }

    const branch = options.branch || this.branch;

    return this.getFileSha(path, branch).then(sha => {
      const opts = { method: 'DELETE', params: { sha, message, branch } };
      if (this.commitAuthor) {
        opts.params.author = {
          ...this.commitAuthor,
          date: new Date().toISOString(),
        };
      }
      const fileURL = `${this.repoURL}/contents/${path}`;
      return this.request(fileURL, opts);
    });
  }

  async createBranchAndPullRequest(branchName, sha, commitMessage) {
    await this.createBranch(branchName, sha);
    return this.createPR(commitMessage, branchName);
  }

  async editorialWorkflowGit(files, entry, mediaFilesList, options) {
    const contentKey = this.generateContentKey(options.collectionName, entry.slug);
    const branchName = this.generateBranchName(contentKey);
    const unpublished = options.unpublished || false;
    if (!unpublished) {
      // Open new editorial review workflow for this entry - Create new metadata and commit to new branch
      const fileTree = this.composeFileTree(files);
      const userPromise = this.user();
      const branchData = await this.getBranch();
      const changeTree = await this.updateTree(branchData.commit.sha, '/', fileTree);
      const commitResponse = await this.commit(options.commitMessage, changeTree);

      let pr;
      if (this.useOpenAuthoring) {
        await this.createBranch(branchName, commitResponse.sha);
      } else {
        pr = await this.createBranchAndPullRequest(
          branchName,
          commitResponse.sha,
          options.commitMessage,
        );
      }

      const user = await userPromise;
      return this.storeMetadata(contentKey, {
        type: 'PR',
        pr: pr
          ? {
              number: pr.number,
              head: pr.head && pr.head.sha,
            }
          : undefined,
        user: user.name || user.login,
        status: this.initialWorkflowStatus,
        branch: branchName,
        collection: options.collectionName,
        commitMessage: options.commitMessage,
        title: options.parsedData && options.parsedData.title,
        description: options.parsedData && options.parsedData.description,
        objects: {
          entry: {
            path: entry.path,
            sha: entry.sha,
          },
          files: mediaFilesList,
        },
        timeStamp: new Date().toISOString(),
      });
    } else {
      // Entry is already on editorial review workflow - just update metadata and commit to existing branch
      const metadata = await this.retrieveMetadata(contentKey);
      // mark media files to remove
      const metadataMediaFiles = get(metadata, 'objects.files', []);
      const mediaFilesToRemove = differenceBy(metadataMediaFiles, mediaFilesList, 'path').map(
        file => ({ ...file, remove: true }),
      );
      const fileTree = this.composeFileTree(files.concat(mediaFilesToRemove));
      const branchData = await this.getBranch(branchName);
      const changeTree = await this.updateTree(branchData.commit.sha, '/', fileTree);
      const commit = await this.commit(options.commitMessage, changeTree);
      const { title, description } = options.parsedData || {};

      const pr = metadata.pr ? { ...metadata.pr, head: commit.sha } : undefined;
      const objects = {
        entry: { path: entry.path, sha: entry.sha },
        files: mediaFilesList,
      };
      const updatedMetadata = { ...metadata, pr, title, description, objects };

      if (options.hasAssetStore) {
        await this.storeMetadata(contentKey, updatedMetadata);
        return this.patchBranch(branchName, commit.sha);
      }

      if (pr) {
        return this.rebasePullRequest(pr.number, branchName, contentKey, metadata, commit);
      } else if (this.useOpenAuthoring) {
        // if a PR hasn't been created yet for the forked repo, just patch the branch
        await this.patchBranch(branchName, commit.sha, { force: true });
      }

      return this.storeMetadata(contentKey, updatedMetadata);
    }
  }

  /**
   * Rebase a pull request onto the latest HEAD of it's target base branch
   * (should generally be the configured backend branch). Only rebases changes
   * in the entry file.
   */
  async rebasePullRequest(prNumber, branchName, contentKey, metadata, head) {
    const { path } = metadata.objects.entry;

    try {
      /**
       * Get the published branch and create new commits over it. If the pull
       * request is up to date, no rebase will occur.
       */
      const [baseBranch, commits] = await Promise.all([
        this.getBranch(),
        this.getPullRequestCommits(prNumber, head),
      ]);

      /**
       * Sometimes the list of commits for a pull request isn't updated
       * immediately after the PR branch is patched. There's also the possibility
       * that the branch has changed unexpectedly. We account for both by adding
       * the head if it's missing, or else throwing an error if the PR head is
       * neither the head we expect nor its parent.
       */
      const finalCommits = this.assertHead(commits, head);
      const rebasedHead = await this.rebaseSingleBlobCommits(baseBranch.commit, finalCommits, path);

      /**
       * Update metadata, then force update the pull request branch head.
       */
      const pr = { ...metadata.pr, head: rebasedHead.sha };
      const timeStamp = new Date().toISOString();
      const updatedMetadata = { ...metadata, pr, timeStamp };
      await this.storeMetadata(contentKey, updatedMetadata);
      return this.patchBranch(branchName, rebasedHead.sha, { force: true });
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  /**
   * Rebase an array of commits one-by-one, starting from a given base SHA. Can
   * accept an array of commits as received from the GitHub API. All commits are
   * expected to change the same, single blob.
   */
  rebaseSingleBlobCommits(baseCommit, commits, pathToBlob) {
    /**
     * If the parent of the first commit already matches the target base,
     * return commits as is.
     */
    if (commits.length === 0 || commits[0].parents[0].sha === baseCommit.sha) {
      return Promise.resolve(last(commits));
    }

    /**
     * Re-create each commit over the new base, applying each to the previous,
     * changing only the parent SHA and tree for each, but retaining all other
     * info, such as the author/committer data.
     */
    const newHeadPromise = commits.reduce((lastCommitPromise, commit) => {
      return lastCommitPromise.then(newParent => {
        /**
         * Normalize commit data to ensure it's not nested in `commit.commit`.
         */
        const parent = this.normalizeCommit(newParent);
        const commitToRebase = this.normalizeCommit(commit);

        return this.rebaseSingleBlobCommit(parent, commitToRebase, pathToBlob);
      });
    }, Promise.resolve(baseCommit));

    /**
     * Return a promise that resolves when all commits have been created.
     */
    return newHeadPromise;
  }

  /**
   * Rebase a commit that changes a single blob. Also handles updating the tree.
   */
  rebaseSingleBlobCommit(baseCommit, commit, pathToBlob) {
    /**
     * Retain original commit metadata.
     */
    const { message, author, committer } = commit;

    /**
     * Set the base commit as the parent.
     */
    const parent = [baseCommit.sha];

    /**
     * Get the blob data by path.
     */
    return (
      this.getBlobInTree(commit.tree.sha, pathToBlob)

        /**
         * Create a new tree consisting of the base tree and the single updated
         * blob. Use the full path to indicate nesting, GitHub will take care of
         * subtree creation.
         */
        .then(blob => this.createTree(baseCommit.tree.sha, [{ ...blob, path: pathToBlob }]))

        /**
         * Create a new commit with the updated tree and original commit metadata.
         */
        .then(tree => this.createCommit(message, tree.sha, parent, author, committer))
    );
  }

  /**
   * Get a pull request by PR number.
   */
  getPullRequest(prNumber) {
    return this.request(`${this.originRepoURL}/pulls/${prNumber} }`);
  }

  /**
   * Get the list of commits for a given pull request.
   */
  getPullRequestCommits(prNumber) {
    return this.requestAllPages(`${this.originRepoURL}/pulls/${prNumber}/commits`);
  }

  /**
   * Returns `commits` with `headToAssert` appended if it's the child of the
   * last commit in `commits`. Returns `commits` unaltered if `headToAssert` is
   * already the last commit in `commits`. Otherwise throws an error.
   */
  assertHead(commits, headToAssert) {
    const headIsMissing = headToAssert.parents[0].sha === last(commits).sha;
    const headIsNotMissing = headToAssert.sha === last(commits).sha;

    if (headIsMissing) {
      return commits.concat(headToAssert);
    } else if (headIsNotMissing) {
      return commits;
    }

    throw Error('Editorial workflow branch changed unexpectedly.');
  }

  async updateUnpublishedEntryStatus(collectionName, slug, status) {
    const contentKey = this.generateContentKey(collectionName, slug);
    const metadata = await this.retrieveMetadata(contentKey);

    if (!this.useOpenAuthoring) {
      return this.storeMetadata(contentKey, {
        ...metadata,
        status,
      });
    }

    if (status === 'pending_publish') {
      throw new Error('Open Authoring entries may not be set to the status "pending_publish".');
    }

    const { pr: prMetadata } = metadata;
    if (prMetadata) {
      const { number: prNumber } = prMetadata;
      const originPRInfo = await this.getPullRequest(prNumber);
      const { state } = originPRInfo;
      if (state === 'open' && status === 'draft') {
        await this.closePR(prMetadata);
        return this.storeMetadata(contentKey, {
          ...metadata,
          status,
        });
      }

      if (state === 'closed' && status === 'pending_review') {
        await this.openPR(prMetadata);
        return this.storeMetadata(contentKey, {
          ...metadata,
          status,
        });
      }
    }

    if (!prMetadata && status === 'pending_review') {
      const branchName = this.generateBranchName(contentKey);
      const commitMessage = metadata.commitMessage || API.DEFAULT_COMMIT_MESSAGE;
      const { number, head } = await this.createPR(commitMessage, branchName);
      return this.storeMetadata(contentKey, {
        ...metadata,
        pr: { number, head },
        status,
      });
    }
  }

  async deleteUnpublishedEntry(collectionName, slug) {
    const contentKey = this.generateContentKey(collectionName, slug);
    const branchName = this.generateBranchName(contentKey);
    return (
      this.retrieveMetadata(contentKey)
        .then(metadata => (metadata && metadata.pr ? this.closePR(metadata.pr) : Promise.resolve()))
        .then(() => this.deleteBranch(branchName))
        // If the PR doesn't exist, then this has already been deleted -
        // deletion should be idempotent, so we can consider this a
        // success.
        .catch(err => {
          if (err.message === 'Reference does not exist') {
            return Promise.resolve();
          }
          console.error(err);
          return Promise.reject(err);
        })
    );
  }

  publishUnpublishedEntry(collectionName, slug) {
    const contentKey = this.generateContentKey(collectionName, slug);
    const branchName = this.generateBranchName(contentKey);
    return this.retrieveMetadata(contentKey)
      .then(metadata => this.mergePR(metadata.pr, metadata.objects))
      .then(() => this.deleteBranch(branchName));
  }

  createRef(type, name, sha) {
    return this.request(`${this.repoURL}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/${type}/${name}`, sha }),
    });
  }

  patchRef(type, name, sha, opts = {}) {
    const force = opts.force || false;
    return this.request(`${this.repoURL}/git/refs/${type}/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha, force }),
    });
  }

  deleteRef(type, name) {
    return this.request(`${this.repoURL}/git/refs/${type}/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  }

  getBranch(branch = this.branch) {
    return this.request(`${this.repoURL}/branches/${encodeURIComponent(branch)}`);
  }

  createBranch(branchName, sha) {
    return this.createRef('heads', branchName, sha);
  }

  assertCmsBranch(branchName) {
    return branchName.startsWith(`${CMS_BRANCH_PREFIX}/`);
  }

  patchBranch(branchName, sha, opts = {}) {
    const force = opts.force || false;
    if (force && !this.assertCmsBranch(branchName)) {
      throw Error(`Only CMS branches can be force updated, cannot force update ${branchName}`);
    }
    return this.patchRef('heads', branchName, sha, { force });
  }

  deleteBranch(branchName) {
    return this.deleteRef('heads', branchName);
  }

  async createPR(title, head) {
    const headReference = this.useOpenAuthoring ? `${(await this.user()).login}:${head}` : head;
    return this.request(`${this.originRepoURL}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        body: API.DEFAULT_PR_BODY,
        head: headReference,
        base: this.branch,
      }),
    });
  }

  async openPR(pullRequest) {
    const { number } = pullRequest;
    console.log('%c Re-opening PR', 'line-height: 30px;text-align: center;font-weight: bold');
    return this.request(`${this.originRepoURL}/pulls/${number}`, {
      method: 'PATCH',
      body: JSON.stringify({
        state: 'open',
      }),
    });
  }

  closePR(pullRequest) {
    const { number } = pullRequest;
    console.log('%c Deleting PR', 'line-height: 30px;text-align: center;font-weight: bold');
    return this.request(`${this.originRepoURL}/pulls/${number}`, {
      method: 'PATCH',
      body: JSON.stringify({
        state: 'closed',
      }),
    });
  }

  mergePR(pullrequest, objects) {
    const { head: headSha, number } = pullrequest;
    console.log('%c Merging PR', 'line-height: 30px;text-align: center;font-weight: bold');
    return this.request(`${this.originRepoURL}/pulls/${number}/merge`, {
      method: 'PUT',
      body: JSON.stringify({
        commit_message: 'Automatically generated. Merged on Netlify CMS.',
        sha: headSha,
        merge_method: this.merge_method,
      }),
    }).catch(error => {
      if (error instanceof APIError && error.status === 405) {
        return this.forceMergePR(pullrequest, objects);
      } else {
        throw error;
      }
    });
  }

  forceMergePR(pullrequest, objects) {
    const files = objects.files.concat(objects.entry);
    const fileTree = this.composeFileTree(files);
    let commitMessage = 'Automatically generated. Merged on Netlify CMS\n\nForce merge of:';
    files.forEach(file => {
      commitMessage += `\n* "${file.path}"`;
    });
    console.log(
      '%c Automatic merge not possible - Forcing merge.',
      'line-height: 30px;text-align: center;font-weight: bold',
    );
    return this.getBranch()
      .then(branchData => this.updateTree(branchData.commit.sha, '/', fileTree))
      .then(changeTree => this.commit(commitMessage, changeTree))
      .then(response => this.patchBranch(this.branch, response.sha));
  }

  getTree(sha) {
    if (sha) {
      return this.request(`${this.repoURL}/git/trees/${sha}`);
    }
    return Promise.resolve({ tree: [] });
  }

  /**
   * Get a blob from a tree. Requests individual subtrees recursively if blob is
   * nested within one or more directories.
   */
  getBlobInTree(treeSha, pathToBlob) {
    const pathSegments = pathToBlob.split('/').filter(val => val);
    const directories = pathSegments.slice(0, -1);
    const filename = pathSegments.slice(-1)[0];
    const baseTree = this.getTree(treeSha);
    const subTreePromise = directories.reduce((treePromise, segment) => {
      return treePromise.then(tree => {
        const subTreeSha = find(tree.tree, { path: segment }).sha;
        return this.getTree(subTreeSha);
      });
    }, baseTree);
    return subTreePromise.then(subTree => find(subTree.tree, { path: filename }));
  }

  toBase64(str) {
    return Promise.resolve(Base64.encode(str));
  }

  uploadBlob(item) {
    const content = result(item, 'toBase64', partial(this.toBase64, item.raw));

    return content.then(contentBase64 =>
      this.request(`${this.repoURL}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({
          content: contentBase64,
          encoding: 'base64',
        }),
      }).then(response => {
        item.sha = response.sha;
        item.uploaded = true;
        return item;
      }),
    );
  }

  updateTree(sha, path, fileTree) {
    return this.getTree(sha).then(tree => {
      let obj;
      let filename;
      let fileOrDir;
      const updates = [];
      const added = {};

      for (let i = 0, len = tree.tree.length; i < len; i++) {
        obj = tree.tree[i];
        if ((fileOrDir = fileTree[obj.path])) {
          added[obj.path] = true;

          if (fileOrDir.file) {
            const sha = fileOrDir.remove ? null : fileOrDir.sha;
            updates.push({ path: obj.path, mode: obj.mode, type: obj.type, sha });
          } else {
            updates.push(this.updateTree(obj.sha, obj.path, fileOrDir));
          }
        }
      }

      for (filename in fileTree) {
        fileOrDir = fileTree[filename];
        if (added[filename]) {
          continue;
        }

        if (fileOrDir.file) {
          updates.push({ path: filename, mode: '100644', type: 'blob', sha: fileOrDir.sha });
        } else {
          updates.push(this.updateTree(null, filename, fileOrDir));
        }
      }

      return Promise.all(updates)
        .then(tree => this.createTree(sha, tree))
        .then(response => ({
          path,
          mode: '040000',
          type: 'tree',
          sha: response.sha,
          parentSha: sha,
        }));
    });
  }

  createTree(baseSha, tree) {
    return this.request(`${this.repoURL}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseSha, tree }),
    });
  }

  /**
   * Some GitHub API calls return commit data in a nested `commit` property,
   * with the SHA outside of the nested property, while others return a
   * flatter object with no nested `commit` property. This normalizes a commit
   * to resemble the latter.
   */
  normalizeCommit(commit) {
    if (commit.commit) {
      return { ...commit.commit, sha: commit.sha };
    }
    return commit;
  }

  commit(message, changeTree) {
    const parents = changeTree.parentSha ? [changeTree.parentSha] : [];
    return this.createCommit(message, changeTree.sha, parents);
  }

  createCommit(message, treeSha, parents, author, committer) {
    return this.request(`${this.repoURL}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message, tree: treeSha, parents, author, committer }),
    });
  }
}
