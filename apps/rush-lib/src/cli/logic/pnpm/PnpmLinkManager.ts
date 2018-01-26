// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as fsx from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import uriEncode = require('strict-uri-encode');

import { JsonFile } from '@microsoft/node-core-library';

import {
  BaseLinkManager,
  SymlinkKind
} from '../base/BaseLinkManager';
import IPackageJson from '../../../utilities/IPackageJson';
import Utilities from '../../../utilities/Utilities';
import { BasePackage } from '../base/BasePackage';
import { RushConstants } from '../../../RushConstants';
import { IRushLinkJson } from '../../../data/RushConfiguration';
import RushConfigurationProject from '../../../data/RushConfigurationProject';

// special flag for debugging, will print extra diagnostic information,
// but comes with performance cost
const DEBUG: boolean = false;

export class PnpmLinkManager extends BaseLinkManager {
  protected _linkProjects(): Promise<void> {
    try {
      const rushLinkJson: IRushLinkJson = { localLinks: {} };

      for (const rushProject of this._rushConfiguration.projects) {
        console.log(os.EOL + 'LINKING: ' + rushProject.packageName);
        this._linkProject(rushProject, rushLinkJson);
      }

      console.log(`Writing "${this._rushConfiguration.rushLinkJsonFilename}"`);
      JsonFile.save(rushLinkJson, this._rushConfiguration.rushLinkJsonFilename);

      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * This is called once for each local project from Rush.json.
   * @param project             The local project that we will create symlinks for
   * @param rushLinkJson        The common/temp/rush-link.json output file
   */
  private _linkProject(
    project: RushConfigurationProject,
    rushLinkJson: IRushLinkJson): void {

    // first, read the temp package.json information

    // Example: "project1"
    const unscopedTempProjectName: string = Utilities.parseScopedPackageName(project.tempProjectName).name;

    // Example: "C:\MyRepo\common\temp\projects\project1
    const extractedFolder: string = path.join(this._rushConfiguration.commonTempFolder,
      RushConstants.rushTempProjectsFolderName, unscopedTempProjectName);

    // Example: "C:\MyRepo\common\temp\projects\project1\package.json"
    const packageJsonFilename: string = path.join(extractedFolder, 'package.json');

    // Example: "C:\MyRepo\common\temp\node_modules\@rush-temp\project1"
    const installFolderName: string = path.join(this._rushConfiguration.commonTempFolder,
      RushConstants.nodeModulesFolderName, RushConstants.rushTempNpmScope, unscopedTempProjectName);

    const commonPackage: BasePackage = BasePackage.createVirtualTempPackage(packageJsonFilename, installFolderName);

    const localPackage: BasePackage = BasePackage.createLinkedPackage(
      project.packageJson.name,
      commonPackage.version,
      project.projectFolder
    );

    // now that we have the temp package.json, we can go ahead and link up all the direct dependencies

    // first, start with the rush dependencies, we just need to link to the project folder
    for (const dependencyName of Object.keys(commonPackage.packageJson!.rushDependencies || {})) {

      const matchedRushPackage: RushConfigurationProject | undefined =
        this._rushConfiguration.getProjectByName(dependencyName);

      if (matchedRushPackage) {
        // We found a suitable match, so place a new local package that
        // symlinks to the Rush project
        const matchedVersion: string = matchedRushPackage.packageJson.version;

        let localLinks: string[] = rushLinkJson.localLinks[localPackage.name];
        if (!localLinks) {
          localLinks = [];
          rushLinkJson.localLinks[localPackage.name] = localLinks;
        }
        localLinks.push(dependencyName);

        // e.g. "C:\my-repo\project-a\node_modules\project-b" if project-b is a rush dependency of project-a
        const newLocalFolderPath: string = path.join(localPackage.folderPath, 'node_modules', dependencyName);

        const newLocalPackage: BasePackage = BasePackage.createLinkedPackage(
          dependencyName,
          matchedVersion,
          newLocalFolderPath
        );

        newLocalPackage.symlinkTargetFolderPath = matchedRushPackage.projectFolder;
        localPackage.children.push(newLocalPackage);
      } else {
        // weird state or program bug
        throw Error(`Cannot find dependency "${dependencyName}" for "${project.packageName}" in rush configuration`);
      }
    }

    // Iterate through all the regular dependencies

    // With npm, it's possible for two different projects to have dependencies on
    // the same version of the same library, but end up with different implementations
    // of that library, if the library is installed twice and with different secondary
    // dependencies.The NpmLinkManager recursively links dependency folders to try to
    // honor this. Since PNPM always uses the same physical folder to represent a given
    // version of a library, we only need to link directly to the folder that PNPM has chosen,
    // and it will have a consistent set of secondary dependencies.

    // each of these dependencies should be linked in a special folder that pnpm
    // creates for the installed version of each .TGZ package, all we need to do
    // is re-use that symlink in order to get linked to whatever PNPM thought was
    // appropriate. This folder is usually something like:
    // C:\{uri-encoed-path-to-tgz}\node_modules\{package-name}

    // e.g.: C:\wbt\common\temp\projects\api-documenter.tgz
    const pathToTgzFile: string = path.join(
      this._rushConfiguration.commonTempFolder,
      'projects',
      `${unscopedTempProjectName}.tgz`);

    // e.g.: C%3A%2Fwbt%2Fcommon%2Ftemp%2Fprojects%2Fapi-documenter.tgz
    const escapedPathToTgzFile: string = uriEncode(pathToTgzFile.split(path.sep).join('/'));

    // tslint:disable-next-line:max-line-length
    // e.g.: C:\wbt\common\temp\node_modules\.local\C%3A%2Fwbt%2Fcommon%2Ftemp%2Fprojects%2Fapi-documenter.tgz\node_modules
    const pathToLocalInstallation: string = path.join(
      this._rushConfiguration.commonTempFolder,
      RushConstants.nodeModulesFolderName,
      '.local',
      escapedPathToTgzFile,
      RushConstants.nodeModulesFolderName);

    for (const dependencyName of Object.keys(commonPackage.packageJson!.dependencies || {})) {
      // the dependency we are looking for should have already created a symlink here

      // FYI dependencyName might contain an NPM scope, here it gets converted into a filesystem folder name
      // e.g. if the dependency is supi:
      // tslint:disable-next-line:max-line-length
      // "C:\wbt\common\temp\node_modules\.local\C%3A%2Fwbt%2Fcommon%2Ftemp%2Fprojects%2Fapi-documenter.tgz\node_modules\supi"
      const dependencyLocalInstallationSymlink: string = path.join(
        pathToLocalInstallation,
        dependencyName);

      if (!fsx.existsSync(dependencyLocalInstallationSymlink)) {
        // if this occurs, it is a bug in Rush algorithm or unexpected PNPM behavior
        throw Error(`Cannot find installed dependency "${dependencyName}" in "${pathToLocalInstallation}"`);
      }

      if (!fsx.lstatSync(dependencyLocalInstallationSymlink).isSymbolicLink()) {
        // if this occurs, it is a bug in Rush algorithm or unexpected PNPM behavior
        throw Error(`Dependency "${dependencyName}" is not a symlink in "${pathToLocalInstallation}`);
      }

      const newLocalFolderPath: string = path.join(
          localPackage.folderPath, 'node_modules', dependencyName);

      let version: string | undefined = undefined;
      if (DEBUG) {
        // read the version number for diagnostic purposes
        const packageJsonForDependency: IPackageJson = fsx.readJsonSync(
          path.join(dependencyLocalInstallationSymlink, RushConstants.packageJsonFilename));

        version = packageJsonForDependency.version;
      }

      const newLocalPackage: BasePackage = BasePackage.createLinkedPackage(
        dependencyName,
        version,
        newLocalFolderPath
      );

      newLocalPackage.symlinkTargetFolderPath = dependencyLocalInstallationSymlink;
      localPackage.addChild(newLocalPackage);
    }

    if (DEBUG) {
      localPackage.printTree();
    }

    PnpmLinkManager._createSymlinksForTopLevelProject(localPackage);

    // Also symlink the ".bin" folder
    const commonBinFolder: string = path.join(this._rushConfiguration.commonTempFolder, 'node_modules', '.bin');
    const projectBinFolder: string = path.join(localPackage.folderPath, 'node_modules', '.bin');

    if (fsx.existsSync(commonBinFolder)) {
      PnpmLinkManager._createSymlink(commonBinFolder, projectBinFolder, SymlinkKind.Directory);
    }
  }
}