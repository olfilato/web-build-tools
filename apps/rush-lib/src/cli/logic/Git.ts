// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import PublishUtilities from './PublishUtilities';

export class Git {

  constructor(private _targetBranch: string) {
  }

  public checkout(branchName: string, createBranch?: boolean): void {
    const params: string = `checkout ${createBranch ? '-b ' : ''}${branchName}`;

    PublishUtilities.execCommand(!!this._targetBranch, 'git', params.split(' '));
  }

  public merge(branchName: string): void {
    PublishUtilities.execCommand(!!this._targetBranch, 'git', `merge ${branchName} --no-edit`.split(' '));
  }

  public deleteBranch(branchName: string, hasRemote: boolean = true): void {
    PublishUtilities.execCommand(!!this._targetBranch, 'git', `branch -d ${branchName}`.split(' '));
    if (hasRemote) {
      PublishUtilities.execCommand(!!this._targetBranch, 'git', `push origin --delete ${branchName}`.split(' '));
    }
  }

  public pull(): void {
    PublishUtilities.execCommand(!!this._targetBranch, 'git', `pull origin ${this._targetBranch}`.split(' '));
  }

  public addChanges(pathspec?: string, workingDirectory?: string): void {
    const files: string = pathspec ? pathspec : '.';
    PublishUtilities.execCommand(!!this._targetBranch, 'git', ['add', files],
      workingDirectory ? workingDirectory : process.cwd());
  }

  public addTag(shouldExecute: boolean, packageName: string, packageVersion: string): void {
    // Tagging only happens if we're publishing to real NPM and committing to git.
    const tagName: string = PublishUtilities.createTagname(packageName, packageVersion);
    PublishUtilities.execCommand(
      !!this._targetBranch && shouldExecute,
      'git',
      ['tag', '-a', tagName, '-m', `${packageName} v${packageVersion}`]);
  }

  public commit(message?: string): void {
    const commitMessage: string = message ? message : 'Applying package updates.';
    PublishUtilities.execCommand(!!this._targetBranch, 'git', ['commit', '-m', commitMessage]);
  }

  public push(branchName: string): void {
    PublishUtilities.execCommand(
      !!this._targetBranch,
      'git',
      ['push', 'origin', 'HEAD:' + branchName, '--follow-tags', '--verbose']);
  }
}