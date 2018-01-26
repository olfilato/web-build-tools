// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';

import {
  default as PublishUtilities,
  IChangeInfoHash
} from './PublishUtilities';
import {
  IChangeInfo,
  ChangeType
} from '../../data/ChangeManagement';
import {
  IChangelog,
  IChangeLogEntry,
  IChangeLogComment
} from '../../data/Changelog';
import RushConfigurationProject from '../../data/RushConfigurationProject';
import RushConfiguration from '../../data/RushConfiguration';

const CHANGELOG_JSON: string = 'CHANGELOG.json';
const CHANGELOG_MD: string = 'CHANGELOG.md';
const EOL: string = '\n';

export default class ChangelogGenerator {
  private static _rushConfiguration: RushConfiguration;

  public static get rushConfiguration(): RushConfiguration {
    if (!ChangelogGenerator._rushConfiguration) {
      ChangelogGenerator._rushConfiguration = RushConfiguration.loadFromDefaultLocation();
    }
    return ChangelogGenerator._rushConfiguration;
  }

  public static set rushConfiguration(newConfiguration: RushConfiguration) {
    ChangelogGenerator._rushConfiguration = newConfiguration;
  }

  /**
   * Updates the appropriate changelogs with the given changes.
   */
  public static updateChangelogs(
    allChanges: IChangeInfoHash,
    allProjects: Map<string, RushConfigurationProject>,
    shouldCommit: boolean
  ): IChangelog[] {
    const updatedChangeLogs: IChangelog[] = [];

    for (const packageName in allChanges) {
      if (allChanges.hasOwnProperty(packageName)) {
        const project: RushConfigurationProject | undefined = allProjects.get(packageName);

        if (project && ChangelogGenerator._shouldUpdateChangeLog(project, allChanges)) {
          const changeLog: IChangelog | undefined = ChangelogGenerator.updateIndividualChangelog(
            allChanges[packageName],
            project.projectFolder,
            shouldCommit,
            project.versionPolicy && project.versionPolicy.isLockstepped,
            project.isMainProject);

            if (changeLog) {
              updatedChangeLogs.push(changeLog);
            }
        }
      }
    }
    return updatedChangeLogs;
  }

  /**
   * Fully regenerate the markdown files based on the current json files.
   */
  public static regenerateChangelogs(
    allProjects: Map<string, RushConfigurationProject>
  ): void {
    allProjects.forEach(project => {
      const markdownPath: string = path.resolve(project.projectFolder, CHANGELOG_MD);
      const markdownJSONPath: string = path.resolve(project.projectFolder, CHANGELOG_JSON);

      if (fs.existsSync(markdownPath)) {
        console.log('Found: ' + markdownPath);
        if (!fs.existsSync(markdownJSONPath)) {
          throw new Error('A CHANGELOG.md without json: ' + markdownPath);
        }

        const changelog: IChangelog = ChangelogGenerator._getChangelog(project.packageName, project.projectFolder);
        const isLockstepped: boolean = !!project.versionPolicy && project.versionPolicy.isLockstepped;

        fs.writeFileSync(
          path.join(project.projectFolder, CHANGELOG_MD),
          ChangelogGenerator._translateToMarkdown(changelog, isLockstepped),
          { encoding: 'utf8' }
        );
      }

    });
  }

  /**
   * Updates an individual changelog for a single project.
   */
  public static updateIndividualChangelog(
    change: IChangeInfo,
    projectFolder: string,
    shouldCommit: boolean,
    isLockstepped: boolean = false,
    isMain: boolean = true
  ): IChangelog | undefined {
    if (isLockstepped && !isMain) {
      // Early return if the project is lockstepped and does not host change logs
      return undefined;
    }
    const changelog: IChangelog = ChangelogGenerator._getChangelog(change.packageName, projectFolder);

    if (
      !changelog.entries.some(entry => entry.version === change.newVersion)) {

      const changelogEntry: IChangeLogEntry = {
        version: change.newVersion!,
        tag: PublishUtilities.createTagname(change.packageName, change.newVersion!),
        date: new Date().toUTCString(),
        comments: {}
      };

      change.changes!.forEach(individualChange => {
        if (individualChange.comment) {

          // Initialize the comments array only as necessary.
          const changeTypeString: string = ChangeType[individualChange.changeType!];
          const comments: IChangeLogComment[] =
            changelogEntry.comments[changeTypeString] =
            changelogEntry.comments[changeTypeString] || [];

          comments.push({
            author: individualChange.author,
            commit: individualChange.commit,
            comment: individualChange.comment
          });
        }
      });

      // Add the changelog entry to the start of the list.
      changelog.entries.unshift(changelogEntry);

      const changelogFilename: string = path.join(projectFolder, CHANGELOG_JSON);

      console.log(
        `${EOL}* ${shouldCommit ? 'APPLYING' : 'DRYRUN'}: ` +
        `Changelog update for "${change.packageName}@${change.newVersion}".`
      );

      if (shouldCommit) {
        // Write markdown transform.
        fs.writeFileSync(changelogFilename, JSON.stringify(changelog, undefined, 2), { encoding: 'utf8' });

        fs.writeFileSync(
          path.join(projectFolder, CHANGELOG_MD),
          ChangelogGenerator._translateToMarkdown(changelog, isLockstepped),
          { encoding: 'utf8' }
        );
      }
      return changelog;
    }
    // change log not updated.
    return undefined;
  }

  /**
   * Loads the changelog json from disk, or creates a new one if there isn't one.
   */
  private static _getChangelog(packageName: string, projectFolder: string): IChangelog {
    const changelogFilename: string = path.join(projectFolder, CHANGELOG_JSON);
    let changelog: IChangelog | undefined = undefined;

    // Try to read the existing changelog.
    if (fs.existsSync(changelogFilename)) {
      changelog = JSON.parse(fs.readFileSync(changelogFilename, 'utf8')) as IChangelog;
    }

    if (!changelog) {
      changelog = {
        name: packageName,
        entries: []
      };
    } else {
      // Force the changelog name to be same as package name.
      // In case the package has been renamed but change log name is not updated.
      changelog.name = packageName;
    }

    return changelog;
  }

  /**
   * Translates the given changelog json object into a markdown string.
   */
  private static _translateToMarkdown(changelog: IChangelog, isLockstepped: boolean = false): string {
    let markdown: string = [
      `# Change Log - ${changelog.name}`,
      '',
      `This log was last generated on ${new Date().toUTCString()} and should not be manually modified.`,
      '',
      ''
    ].join(EOL);

    changelog.entries.forEach((entry, index) => {
      markdown += `## ${entry.version}${EOL}`;

      if (entry.date) {
        markdown += `${entry.date}${EOL}`;
      }

      markdown += EOL;

      let comments: string = '';

      comments += ChangelogGenerator._getChangeComments(
        'Breaking changes',
        entry.comments[ChangeType[ChangeType.major]]);

      comments += ChangelogGenerator._getChangeComments(
        'Minor changes',
        entry.comments[ChangeType[ChangeType.minor]]);

      comments += ChangelogGenerator._getChangeComments(
        'Patches',
        entry.comments[ChangeType[ChangeType.patch]]);

      if (isLockstepped) {
        // In lockstepped projects, all changes are of type ChangeType.none.
        comments += ChangelogGenerator._getChangeComments(
          'Updates',
          entry.comments[ChangeType[ChangeType.none]]);
      }

      if (this.rushConfiguration.hotfixChangeEnabled) {
        comments += ChangelogGenerator._getChangeComments(
          'Hotfixes',
          entry.comments[ChangeType[ChangeType.hotfix]]);
      }

      if (!comments) {
        markdown += ((changelog.entries.length === index + 1) ?
          '*Initial release*' :
          '*Version update only*') +
          EOL + EOL;
      } else {
        markdown += comments;
      }

    });

    return markdown;
  }

  /**
   * Helper to return the comments string to be appends to the markdown content.
   */
  private static _getChangeComments(title: string, commentsArray: IChangeLogComment[]): string {
    let comments: string = '';

    if (commentsArray) {
      comments = `### ${title}${EOL + EOL}`;
      commentsArray.forEach(comment => {
        comments += `- ${comment.comment}${EOL}`;
      });
      comments += EOL;
    }

    return comments;
  }

  /**
   * Changelogs should only be generated for publishable projects.
   * Do not update changelog or delete the change files for prerelease. Save them for the official release.
   * Unless the package is a hotfix, in which case do delete the change files.
   *
   * @param project
   * @param allChanges
   */
  private static _shouldUpdateChangeLog(
    project: RushConfigurationProject,
    allChanges: IChangeInfoHash
  ): boolean {

    return project.shouldPublish &&
      (!semver.prerelease(project.packageJson.version) ||
      allChanges[project.packageName].changeType === ChangeType.hotfix);
  }
}