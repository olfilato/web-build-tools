// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as fsx from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as child_process from 'child_process';
import * as colors from 'colors';

import inquirer = require('inquirer');

import {
  CommandLineFlagParameter,
  CommandLineStringParameter
} from '@microsoft/ts-command-line';

import RushConfigurationProject from '../../data/RushConfigurationProject';
import {
  IChangeFile,
  IChangeInfo
} from '../../data/ChangeManagement';
import VersionControl from '../../utilities/VersionControl';
import { ChangeFile } from '../../data/ChangeFile';
import { BaseRushAction } from './BaseRushAction';
import RushCommandLineParser from './RushCommandLineParser';
import ChangeFiles from '../logic/ChangeFiles';
import {
  VersionPolicy,
  IndividualVersionPolicy,
  LockStepVersionPolicy,
  VersionPolicyDefinitionName
} from '../../data/VersionPolicy';

export default class ChangeAction extends BaseRushAction {
  private _parser: RushCommandLineParser;
  private _sortedProjectList: string[];
  private _changeFileData: Map<string, IChangeFile>;
  private _changeComments: Map<string, string[]>;
  private _verifyParameter: CommandLineFlagParameter;
  private _targetBranchParameter: CommandLineStringParameter;
  private _targetBranchName: string;
  private _projectHostMap: Map<string, string>;

  private _prompt: inquirer.PromptModule;

  constructor(parser: RushCommandLineParser) {
    const documentation: string[] = [
      'Asks a series of questions and then generates a <branchname>-<timstamp>.json file ' +
      'in the common folder. The `publish` command will consume these files and perform the proper ' +
      'version bumps. Note these changes will eventually be published in a changelog.md file in each package.',
      '',
      'The possible types of changes are: ',
      '',
      'MAJOR - these are breaking changes that are not backwards compatible. ' +
      'Examples are: renaming a public class, adding/removing a non-optional ' +
      'parameter from a public API, or renaming an variable or function that ' +
      'is exported.',
      '',
      'MINOR - these are changes that are backwards compatible (but not ' +
      'forwards compatible). Examples are: adding a new public API or adding an ' +
      'optional parameter to a public API',
      '',
      'PATCH - these are changes that are backwards and forwards compatible. ' +
      'Examples are: Modifying a private API or fixing a bug in the logic ' +
      'of how an existing API works.',
      '',
      'HOTFIX (EXPERIMENTAL) - these are changes that are hotfixes targeting a ' +
      'specific older version of the package. When a hotfix change is added, ' +
      'other changes will not be able to increment the version number.' +
      'Enable this feature by setting \'hotfixChangeEnabled\' in your rush.json.',
      ''
    ];
    super({
      actionVerb: 'change',
      summary: 'Records changes made to projects, indicating how the package version number should be bumped ' +
        'for the next publish.',
      documentation: documentation.join(os.EOL)
    });
    this._parser = parser;
  }

  public onDefineParameters(): void {
    this._verifyParameter = this.defineFlagParameter({
      parameterLongName: '--verify',
      parameterShortName: '-v',
      description: 'Verify the change file has been generated and that it is a valid JSON file'
    });
    this._targetBranchParameter = this.defineStringParameter({
      parameterLongName: '--target-branch',
      parameterShortName: '-b',
      key: 'BRANCH',
      description: 'If this parameter is specified, compare current branch with the target branch to get changes. ' +
        'If this parameter is not specified, the current branch is compared against the "master" branch.'
    });
  }

  public run(): void {
    console.log(`Target branch is ${this._targetBranch}`);
    this._projectHostMap = this._generateHostMap();

    if (this._verifyParameter.value) {
      return this._verify();
    }
    this._sortedProjectList = this._getChangedPackageNames()
      .sort();

    if (this._sortedProjectList.length === 0) {
      console.log('No change file is needed.');
      this._warnUncommittedChanges();
      return;
    }

    this._prompt = inquirer.createPromptModule();
    this._changeFileData = new Map<string, IChangeFile>();
    this._changeComments = ChangeFiles.getChangeComments(this._getChangeFiles());

    // We should consider making onExecute either be an async/await or have it return a promise
    this._promptLoop()
      .catch((error: Error) => {
        console.error('There was an error creating the changefile:' + os.EOL + error.toString());
      });
  }

  private _generateHostMap(): Map<string, string> {
    const hostMap: Map<string, string> = new Map<string, string>();
    this.rushConfiguration.projects.forEach(project => {
      let hostProjectName: string = project.packageName;
      if (project.versionPolicy && project.versionPolicy.isLockstepped) {
        const lockstepPolicy: LockStepVersionPolicy = project.versionPolicy as LockStepVersionPolicy;
        hostProjectName = lockstepPolicy.mainProject || project.packageName;
      }
      hostMap.set(project.packageName, hostProjectName);
    });
    return hostMap;
  }

  private _verify(): void {
    const changedPackages: string[] = this._getChangedPackageNames();

    if (changedPackages.length > 0) {
      this._validateChangeFile(changedPackages);
    } else {
      console.log('No change is needed.');
    }
  }

  private get _targetBranch(): string {
    if (!this._targetBranchName) {
      this._targetBranchName = this._targetBranchParameter.value ||
        VersionControl.getRemoteMasterBranch(this.rushConfiguration.repositoryUrl);
    }
    return this._targetBranchName;
  }

  private _getChangedPackageNames(): string[] {
    const changedFolders: Array<string | undefined> | undefined = VersionControl.getChangedFolders(this._targetBranch);
    if (!changedFolders) {
      return [];
    }
    const changedPackageNames: Set<string> = new Set<string>();

    this.rushConfiguration.projects
    .filter(project => project.shouldPublish)
    .filter(project => this._hasProjectChanged(changedFolders, project))
    .forEach(project => {
      const hostName: string | undefined = this._projectHostMap.get(project.packageName);
      if (hostName) {
        changedPackageNames.add(hostName);
      }
    });
    return [...changedPackageNames];
  }

  private _validateChangeFile(changedPackages: string[]): void {
    const files: string[] = this._getChangeFiles();
    if (files.length === 0) {
      throw new Error(`No change file is found. Run 'rush change' to generate a change file.`);
    }
    ChangeFiles.validate(files, changedPackages);
  }

  private _getChangeFiles(): string[] {
    return VersionControl.getChangedFiles(`common/changes/`, this._targetBranch).map(relativePath => {
      return path.join(this.rushConfiguration.rushJsonFolder, relativePath);
    });
  }

  private _hasProjectChanged(changedFolders: Array<string | undefined>,
    project: RushConfigurationProject): boolean {
    let normalizedFolder: string = project.projectRelativeFolder;
    if (normalizedFolder.charAt(normalizedFolder.length - 1) !== '/') {
      normalizedFolder = normalizedFolder + '/';
    }
    const pathRegex: RegExp = new RegExp(`^${normalizedFolder}`, 'i');
    for (const folder of changedFolders) {
      if (folder && folder.match(pathRegex)) {
        return true;
      }
    }
    return false;
  }

  /**
   * The main loop which continually asks user for questions about changes until they don't
   * have any more, at which point we collect their email and write the change file.
   */
  private _promptLoop(): Promise<void> {
    // If there are still projects, ask about the next one
    if (this._sortedProjectList.length) {
      return this._askQuestions(this._sortedProjectList.pop()!)
        .then((answers: IChangeInfo) => {
          if (answers) {
            // Save the info into the changefile
            let changeFile: IChangeFile | undefined = this._changeFileData.get(answers.packageName);
            if (!changeFile) {
              changeFile = {
                changes: [],
                packageName: answers.packageName,
                email: undefined
              };
              this._changeFileData.set(answers.packageName, changeFile!);
            }
            changeFile!.changes.push(answers);
          }
          // Continue to loop
          return this._promptLoop();

        });
    } else {
      this._warnUncommittedChanges();
      // We are done, collect their e-mail
      return this._detectOrAskForEmail().then((email: string) => {
        this._changeFileData.forEach((changeFile: IChangeFile) => {
          changeFile.email = email;
        });
        return this._writeChangeFiles();
      });
    }
  }

  /**
   * Asks all questions which are needed to generate changelist for a project.
   */
  private _askQuestions(packageName: string): Promise<IChangeInfo | undefined> {
    console.log(`${os.EOL}${packageName}`);
    const comments: string[] | undefined = this._changeComments.get(packageName);
    if (comments) {
      console.log(`Found existing comments:`);
      comments.forEach(comment => {
        console.log(`    > ${comment}`);
      });
      return this._prompt({
        name: 'appendComment',
        type: 'list',
        default: 'skip',
        message: 'Append to existing comments or skip?',
        choices: [
          {
            'name': 'Skip',
            'value': 'skip'
          },
          {
            'name': 'Append',
            'value': 'append'
          }
        ]
      })
      .then(({ appendComment }: { appendComment: 'skip' | 'append' }) => {
        if (appendComment === 'skip') {
          return undefined;
        } else {
          return this._promptForComments(packageName);
        }
      });
    } else {
      return this._promptForComments(packageName);
    }
  }

  private _promptForComments(packageName: string): Promise<IChangeInfo | undefined> {
    const bumpOptions: { [type: string]: string } = this._getBumpOptions(packageName);
    return this._prompt({
      name: 'comment',
      type: 'input',
      message: `Describe changes, or ENTER if no changes:`
    })
    .then(({ comment }: { comment: string }) => {
      if (Object.keys(bumpOptions).length === 0 || !comment) {
        return {
          comment: comment || '',
          packageName: packageName,
          type: 'none'
        } as IChangeInfo;
      } else {
        return this._prompt({
          choices: Object.keys(bumpOptions).map(option => {
            return {
              'value': option,
              'name': bumpOptions[option]
            };
          }),
          default: 'patch',
          message: 'Select the type of change:',
          name: 'bumpType',
          type: 'list'
        }).then(({ bumpType }: { bumpType: string }) => {
          return {
            packageName: packageName,
            comment: comment,
            type: bumpType
          } as IChangeInfo;
        });
      }
    });
  }

  private _getBumpOptions(packageName: string): {[type: string]: string } {
    const project: RushConfigurationProject | undefined = this.rushConfiguration.getProjectByName(packageName);
    const versionPolicy: VersionPolicy | undefined = project!.versionPolicy;

    let bumpOptions: { [type: string]: string } = {
      'major': 'major - for changes that break compatibility, e.g. removing an API',
      'minor': 'minor - for backwards compatible changes, e.g. adding a new API',
      'patch': 'patch - for changes that do not affect compatibility, e.g. fixing a bug'
    };

    if (this.rushConfiguration.hotfixChangeEnabled) {
      // tslint:disable-next-line:no-string-literal
      bumpOptions['hotfix'] = 'hotfix - for changes that need to be published in a separate hotfix package';
    }

    if (versionPolicy) {
      if (versionPolicy.definitionName === VersionPolicyDefinitionName.lockStepVersion) {
        // No need to ask for bump types if project is lockstep versioned.
        bumpOptions = {};
      } else if (versionPolicy.definitionName === VersionPolicyDefinitionName.individualVersion) {
        const individualPolicy: IndividualVersionPolicy = versionPolicy as IndividualVersionPolicy;
        if (individualPolicy.lockedMajor !== undefined) {
          // tslint:disable-next-line:no-string-literal
          delete bumpOptions['major'];
        }
      }
    }
    return bumpOptions;
  }

  /**
   * Will determine a user's email by first detecting it from their git config,
   * or will ask for it if it is not found or the git config is wrong.
   */
  private _detectOrAskForEmail(): Promise<string> {
    return this._detectAndConfirmEmail().then((email: string) => {

      if (email) {
        return Promise.resolve(email);
      } else {
        return this._promptForEmail();
      }

    });
  }

  /**
   * Detects the user's email address from their git configuration, prompts the user to approve the
   * detected email. It returns undefined if it cannot be detected.
   */
  private _detectAndConfirmEmail(): Promise<string | undefined> {
    let email: string | undefined;
    try {
      email = child_process.execSync('git config user.email')
        .toString()
        .replace(/(\r\n|\n|\r)/gm, '');
    } catch (err) {
      console.log('There was an issue detecting your git email...');
      email = undefined;
    }

    if (email) {
      return this._prompt([
        {
          type: 'confirm',
          name: 'isCorrectEmail',
          default: 'Y',
          message: `Is your email address ${email} ?`
        }
      ]).then(({ isCorrectEmail }: { isCorrectEmail: boolean }) => {
        return isCorrectEmail ? email : undefined;
      });
    } else {
      return Promise.resolve(undefined);
    }
  }

  /**
   * Asks the user for their e-mail address
   */
  private _promptForEmail(): Promise<string> {
    return this._prompt([
      {
        type: 'input',
        name: 'email',
        message: 'What is your email address?',
        validate: (input: string) => {
          return true; // @todo should be an email
        }
      }
    ])
      .then((answers) => {
        return answers.email;
      });
  }

  private _warnUncommittedChanges(): void {
    try {
      if (VersionControl.hasUncommittedChanges()) {
        console.log(os.EOL +
          colors.yellow('Warning: You have uncommitted changes, which do not trigger a change entry.'));
      }
    } catch (error) {
      console.log('Ignore the failure of checking uncommitted changes');
    }
  }

  /**
   * Writes changefile to the common/changes folder. Will prompt for overwrite if file already exists.
   */
  private _writeChangeFiles(): Promise<void> {
    const promises: Promise<void>[] = [];
    this._changeFileData.forEach((changeFile: IChangeFile) => {
      promises.push(this._writeChangeFile(changeFile));
    });

    return new Promise<void>((resolve, reject) => {
      Promise.all(promises).then(() => {
        resolve();
      })
      .catch(e => {
        reject(e);
      });
    });
  }

  private _writeChangeFile(changeFileData: IChangeFile): Promise<void> {
    const output: string = JSON.stringify(changeFileData, undefined, 2);
    const changeFile: ChangeFile = new ChangeFile(changeFileData, this.rushConfiguration);
    const filePath: string = changeFile.generatePath();

    if (fsx.existsSync(filePath)) {
      // prompt about overwrite
      this._prompt([
        {
          name: 'overwrite',
          type: 'confirm',
          message: `Overwrite ${filePath} ?`
        }
      ]).then(({ overwrite }: { overwrite: string }) => {
        if (overwrite) {
          return this._writeFile(filePath, output);
        } else {
          console.log(`Not overwriting ${filePath}...`);
          return Promise.resolve();
        }
      });
    }
    return this._writeFile(filePath, output);
  }

  /**
   * Writes a file to disk, ensuring the directory structure up to that point exists
   */
  private _writeFile(fileName: string, output: string): Promise<void> {
    return new Promise<void>((resolve: () => void, reject: (err: Error) => void) => {
      // tslint:disable-next-line:no-any
      fsx.mkdirs(path.dirname(fileName), (err: any) => {
        if (err) {
          reject(err);
        }
        fsx.writeFile(fileName, output, (error: NodeJS.ErrnoException) => {
          if (error) {
            reject(error);
          } else {
            console.log('Created file: ' + fileName);
            resolve();
          }
        });
      });
    });
  }
}
