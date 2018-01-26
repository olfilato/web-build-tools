// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { GulpTask, IBuildConfig } from '@microsoft/gulp-core-build';
import * as Gulp from 'gulp';
import * as gulpMocha from 'gulp-mocha';
import * as gulpIstanbul from 'gulp-istanbul';

export interface IMochaTaskConfig {
  testMatch: string[];
  reportDir: string;
}

export class MochaTask extends GulpTask<IMochaTaskConfig> {
  constructor() {
    super(
      'mocha',
      {
        testMatch: ['lib/**/*.test.js'],
        reportDir: 'coverage'
      }
    );
  }

  public isEnabled(buildConfig: IBuildConfig): boolean {
    return (
      super.isEnabled(buildConfig) &&
      !buildConfig.jestEnabled
    );
  }

  public executeTask(gulp: typeof Gulp, completeCallback?: (error?: string) => void): NodeJS.ReadWriteStream {
    const istanbul: typeof gulpIstanbul = require('gulp-istanbul');
    const mocha: typeof gulpMocha = require('gulp-mocha');

    /* tslint:disable:no-string-literal */
    const matchString: string = this.buildConfig.args['match'] as string;
    /* tslint:enable:no-string-literal */

    return gulp.src(this.taskConfig.testMatch, { read: false })
      .pipe(mocha({
        grep: matchString,
        timeout: 15000
      }))
      .pipe(istanbul.writeReports({
        dir: this.taskConfig.reportDir
      }));
  }
}
