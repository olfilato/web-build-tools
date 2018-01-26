// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { expect } from 'chai';
import * as path from 'path';

import { PackageChangeAnalyzer } from '../PackageChangeAnalyzer';

import {
  IPackageDeps
} from '@microsoft/package-deps-hash';

const packageA: string = 'project-a';
const packageAPath: string = path.join('tools', packageA);
const fileA: string = path.join(packageAPath, 'src/index.ts');
// const packageB: string = 'project-b';
// const packageBPath: string = path.join('tools', packageB);
// const fileB: string = path.join(packageBPath, 'src/index.ts');
// const packageBPath: string = path.join('tools', packageB);
const HASH: string = '12345abcdef';
// const looseFile: string = 'some/other/folder/index.ts';

describe('PackageChangeAnalyzer', () => {
  afterEach(() => {
    PackageChangeAnalyzer.reset();
  });

  it('can associate a file in a project folder with a project', () => {
    const repoHashDeps: IPackageDeps = {
      files: {
        [fileA]: HASH
      }
    };

    PackageChangeAnalyzer.getPackageDeps = (packagePath: string, ignored: string[]) => repoHashDeps;
    PackageChangeAnalyzer.rushConfig = {
      projects: [{
        packageName: packageA,
        projectRelativeFolder: packageAPath
      }]
    } as any; // tslint:disable-line:no-any

    const packageDeps: IPackageDeps | undefined = PackageChangeAnalyzer.instance.getPackageDepsHash(packageA);
    expect(packageDeps).eql(repoHashDeps);
  });

  /*
  it('associates a file that is not in a project with all projects', () => {
    const repoHashDeps: IPackageDeps = {
      files: {
        [looseFile]: HASH,
        [fileA]: HASH,
        [fileB]: HASH
      }
    };

    PackageChangeAnalyzer.getPackageDeps = (path: string, ignored: string[]) => repoHashDeps;
    PackageChangeAnalyzer.rushConfig = {
      projects: [{
        packageName: packageA,
        projectRelativeFolder: packageAPath
      },
      {
        packageName: packageB,
        projectRelativeFolder: packageBPath
      }]
    } as any; // tslint:disable-line:no-any

    let packageDeps: IPackageDeps = PackageChangeAnalyzer.instance.getPackageDepsHash(packageA);
    expect(packageDeps).eql({
      files: {
        [looseFile]: HASH,
        [fileA]: HASH
      }
    });

    packageDeps = PackageChangeAnalyzer.instance.getPackageDepsHash(packageB);
    expect(packageDeps).eql({
      files: {
        [looseFile]: HASH,
        [fileB]: HASH
      }
    });
  });
  */
});