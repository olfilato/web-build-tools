// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as colors from 'colors';
import * as Webpack from 'webpack';
import { GulpTask, IBuildConfig } from '@microsoft/gulp-core-build';
import * as Gulp from 'gulp';
import { EOL } from 'os';

/**
 * @public
 */
export interface IWebpackTaskConfig {
  /**
   * Path to a webpack config. A path to a config takes precedence over the "config" option.
   */
  configPath: string;

  /**
   * Webpack config object. If a path is specified by "configPath," and it is valid, this option is ignored.
   */
  config?: Webpack.Configuration;

  /**
   * An array of regular expressions or regular expression strings. If a warning matches any of them, it
   * will not be logged.
   */
  suppressWarnings?: (string | RegExp)[];

  /**
   * An instance of the webpack compiler object, useful for building with Webpack 2.X while GCB is still on 1.X.
   */
  webpack?: typeof Webpack;

  /**
   * If true, a summary of the compilation will be printed after it completes. Defaults to true.
   */
  printStats?: boolean;
}

/**
 * @public
 */
export interface IWebpackResources {
  webpack: typeof Webpack;
}

/**
 * @public
 */
export class WebpackTask<TExtendedConfig = {}> extends GulpTask<IWebpackTaskConfig & TExtendedConfig> {
  private _resources: IWebpackResources;

  constructor(extendedName?: string, extendedConfig?: TExtendedConfig) {
    super(
      extendedName || 'webpack',
      {
        configPath: './webpack.config.js',
        suppressWarnings: [],
        printStats: true,
        ...(extendedConfig as Object)
      } as any // tslint:disable-line:no-any
    );
  }

  public get resources(): IWebpackResources {
    if (!this._resources) {
      this._resources = {
        webpack: this.taskConfig.webpack || require('webpack')
      };
    }

    return this._resources;
  }

  public isEnabled(buildConfig: IBuildConfig): boolean {
    return (
      super.isEnabled(buildConfig) &&
      this.taskConfig.configPath !== null // tslint:disable-line:no-null-keyword
    );
  }

  public loadSchema(): Object {
    return require('./webpack.schema.json');
  }

  public executeTask(gulp: typeof Gulp, completeCallback: (error?: string) => void): void {
    const shouldInitWebpack: boolean = (process.argv.indexOf('--initwebpack') > -1);

    /* tslint:disable:typedef */
    const path = require('path');
    /* tslint:enabled:typedef */

    if (shouldInitWebpack) {
      this.log(
        'Initializing a webpack.config.js, which bundles lib/index.js ' +
        'into dist/packagename.js into a UMD module.');

      this.copyFile(path.resolve(__dirname, 'webpack.config.js'));
      completeCallback();
    } else {
      let webpackConfig: Object;

      if (this.taskConfig.configPath && this.fileExists(this.taskConfig.configPath)) {
        try {
          webpackConfig = require(this.resolvePath(this.taskConfig.configPath));
        } catch (err) {
          completeCallback(`Error parsing webpack config: ${this.taskConfig.configPath}: ${err}`);
          return;
        }
      } else if (this.taskConfig.config) {
        webpackConfig = this.taskConfig.config;
      } else {
        this._logMissingConfigWarning();
        completeCallback();
        return;
      }

      if (webpackConfig) {
        const webpack: typeof Webpack = this.taskConfig.webpack || require('webpack');
        const startTime = new Date().getTime();
        const outputDir = this.buildConfig.distFolder;

        webpack(
          webpackConfig,
          (error, stats) => {
            if (!this.buildConfig.properties) {
              this.buildConfig.properties = {};
            }

            /* tslint:disable:no-string-literal */
            this.buildConfig.properties['webpackStats'] = stats;
            /* tslint:enable:no-string-literal */

            const statsResult = stats.toJson({
              hash: false,
              source: false
            });

            if (statsResult.errors && statsResult.errors.length) {
              this.logError(`'${outputDir}':` + EOL + statsResult.errors.join(EOL) + EOL);
            }

            if (statsResult.warnings && statsResult.warnings.length) {
              const unsuppressedWarnings: string[] = [];
              const warningSuppressionRegexes = (this.taskConfig.suppressWarnings || []).map((regex: string) => {
                return new RegExp(regex);
              });

              statsResult.warnings.forEach((warning: string) => {
                let suppressed = false;
                for (let i = 0; i < warningSuppressionRegexes.length; i++) {
                  const suppressionRegex = warningSuppressionRegexes[i];
                  if (warning.match(suppressionRegex)) {
                    suppressed = true;
                    break;
                  }
                }

                if (!suppressed) {
                  unsuppressedWarnings.push(warning);
                }
              });

              if (unsuppressedWarnings.length > 0) {
                this.logWarning(`'${outputDir}':` + EOL + unsuppressedWarnings.join(EOL) + EOL);
              }
            }

            const duration = (new Date().getTime() - startTime);
            const statsResultChildren = statsResult.children ? statsResult.children : [statsResult];

            statsResultChildren.forEach(child => {
              if (child.chunks) {
                child.chunks.forEach(chunk => {
                  if (chunk.files && this.taskConfig.printStats) {
                    chunk.files.forEach(file => (
                      this.log(`Bundled: '${colors.cyan(path.basename(file))}', ` +
                                `size: ${colors.magenta(chunk.size)} bytes, ` +
                                `took ${colors.magenta(duration.toString(10))} ms.`)
                    )); // end file
                  }
                }); // end chunk
              }
            }); // end child

            completeCallback();
          }); // endwebpack callback
      }
    }
  }

  private _logMissingConfigWarning() {
    this.logWarning(
      'No webpack config has been provided. ' +
      'Run again using --initwebpack to create a default config, ' +
      `or call webpack.setConfig({ configPath: null }) in your gulpfile.`);
  }
}
