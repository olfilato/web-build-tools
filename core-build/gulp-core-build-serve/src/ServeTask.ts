// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { GulpTask } from '@microsoft/gulp-core-build';
import { IBuildConfig } from '@microsoft/gulp-core-build/lib/IBuildConfig';
import * as Gulp from 'gulp';
import * as fs from 'fs';
import * as colors from 'colors';
import * as HttpType from 'http';
import * as HttpsType from 'https';
import * as pathType from 'path';
import * as gUtilType from 'gulp-util';
import * as ExpressType from 'express';

import {
  ICertificate
} from './certificates';

export interface IServeTaskConfig {
  /**
   * API server configuration
   */
  api?: {
    /**
     * The port on which to run the API server
     */
    port: number,

    /**
     * The path to the script to run as the API server
     */
    entryPath: string
  };

  /**
   * The path to the page which should open automatically after this task completes. If you prefer no page to be
   * launched, run the build with the "--nobrowser" flag
   */
  initialPage?: string;

  /**
   * The port on which to host the file server.
   */
  port?: number;

  /**
   * The name of the host on which serve is running. Defaults to 'localhost'
   */
  hostname?: string;

  /**
   * If true, the server should run on HTTPS
   */
  https?: boolean;

  /**
   * Path to the HTTPS key
   */
  keyPath?: string;

  /**
   * Path to the HTTPS cert
   */
  certPath?: string;

  /**
   * Path to the HTTPS PFX cert
   */
  pfxPath?: string;

  /**
   * If true, when gulp-core-build-serve is initialized and a dev certificate doesn't already exist and hasn't been
   *  specified, attempt to generate one and trust it automatically.
   *
   * @default false
   */
  tryCreateDevCertificate?: boolean;
}

interface IApiMap {
  [ route: string ]: Function;
}

export class ServeTask<TExtendedConfig = {}> extends GulpTask<IServeTaskConfig & TExtendedConfig> {
  constructor(extendedName?: string, extendedConfig?: TExtendedConfig) {
    super(
      extendedName || 'serve',
      {
        api: undefined,
        https: false,
        initialPage: '/index.html',
        port: 4321,
        hostname: 'localhost',
        tryCreateDevCertificate: false,
        ...(extendedConfig as Object)
      } as IServeTaskConfig & TExtendedConfig
    );
  }

  public loadSchema(): Object {
    return require('./serve.schema.json');
  }

  public executeTask(gulp: typeof Gulp, completeCallback?: (error?: string) => void): void {

    /* tslint:disable:typedef */
    const gulpConnect = this._loadGulpConnect();
    const open = require('gulp-open');
    const http = require('http');
    const https = require('https');
    /* tslint:enable:typedef */

    const gutil: typeof gUtilType = require('gulp-util');
    const path: typeof pathType = require('path');
    const openBrowser: boolean = (process.argv.indexOf('--nobrowser') === -1);
    const portArgumentIndex: number = process.argv.indexOf('--port');
    let { port, initialPage }: IServeTaskConfig = this.taskConfig;
    const { api }: IServeTaskConfig = this.taskConfig;
    const { rootPath }: IBuildConfig = this.buildConfig;
    const httpsServerOptions: HttpsType.ServerOptions = this._loadHttpsServerOptions();

    if (portArgumentIndex >= 0 && process.argv.length > (portArgumentIndex + 1)) {
      port = Number(process.argv[portArgumentIndex + 1]);
    }

    // Spin up the connect server
    gulpConnect.server({
      https: httpsServerOptions,
      livereload: true,
      middleware: (): Function[] => [this._logRequestsMiddleware, this._enableCorsMiddleware],
      port: port,
      root: rootPath
    });

    // If an api is provided, spin it up.
    if (api) {
      let apiMap: IApiMap | { default: IApiMap };

      try {
        apiMap = require(path.join(rootPath, api.entryPath));

        if (apiMap && (apiMap as { default: IApiMap }).default) {
          apiMap = (apiMap as { default: IApiMap }).default;
        }
      } catch (e) {
        this.logError(`The api entry could not be loaded: ${api.entryPath}`);
      }

      if (apiMap) {
        console.log(`Starting api server on port ${api.port}.`);

        const express: typeof ExpressType = require('express');
        const app: ExpressType.Express = express();

        app.use(this._logRequestsMiddleware);
        app.use(this._enableCorsMiddleware);
        app.use(this._setJSONResponseContentTypeMiddleware);

        // Load the apis.
        for (const apiMapEntry in apiMap) {
          if (apiMap.hasOwnProperty(apiMapEntry)) {
            console.log(`Registring api: ${ gutil.colors.green(apiMapEntry) }`);
            app.get(apiMapEntry, apiMap[apiMapEntry]);
          }
        }

        const apiPort: number = api.port || 5432;
        if (this.taskConfig.https) {
          https.createServer(httpsServerOptions, app).listen(apiPort);
        } else {
          http.createServer(app).listen(apiPort);
        }
      }
    }

    // Spin up the browser.
    if (openBrowser) {
      let uri: string = initialPage;
      if (!initialPage.match(/^https?:\/\//)) {
        if (!initialPage.match(/^\//)) {
          initialPage = `/${initialPage}`;
        }

        uri = `${this.taskConfig.https ? 'https' : 'http'}://${this.taskConfig.hostname}:${port}${initialPage}`;
      }

      gulp.src('')
        .pipe(open({
          uri: uri
        }));
    }

    completeCallback();
  }

  private _logRequestsMiddleware(req: HttpType.IncomingMessage, res: HttpType.ServerResponse, next?: () => void): void {
    /* tslint:disable:no-any */
    const ipAddress: string = (req as any).ip;
    /* tslint:enable:no-any */
    let resourceColor: (text: string) => string = colors.cyan;

    if (req && req.url) {
      if (req.url.indexOf('.bundle.js') >= 0) {
        resourceColor = colors.green;
      } else if (req.url.indexOf('.js') >= 0) {
        resourceColor = colors.magenta;
      }

      console.log(
        [
          `  Request: `,
          `${ ipAddress ? `[${ colors.cyan(ipAddress) }] ` : `` }`,
          `'${ resourceColor(req.url) }'`
        ].join(''));
    }

    next();
  }

  private _enableCorsMiddleware(req: HttpType.IncomingMessage, res: HttpType.ServerResponse, next?: () => void): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  }

  private _setJSONResponseContentTypeMiddleware(req: HttpType.IncomingMessage,
                                                res: HttpType.ServerResponse,
                                                next?: () => void): void {
    res.setHeader('content-type', 'application/json');
    next();
  }

  private _loadHttpsServerOptions(): HttpsType.ServerOptions {
    if (this.taskConfig.https) {
      const result: HttpsType.ServerOptions = {};

      // We're configuring an HTTPS server, so we need a certificate
      if (this.taskConfig.pfxPath) {
        // There's a PFX path in the config, so try that
        this.logVerbose(`Trying PFX path: ${this.taskConfig.pfxPath}`);
        if (fs.existsSync(this.taskConfig.pfxPath)) {
          try {
            result.pfx = fs.readFileSync(this.taskConfig.pfxPath);
            this.logVerbose(`Loaded PFX certificate.`);
          } catch (e) {
            this.logError(`Error loading PFX file: ${e}`);
          }
        } else {
          this.logError(`PFX file not found at path "${this.taskConfig.pfxPath}"`);
        }
      } else if (this.taskConfig.keyPath && this.taskConfig.certPath) {
        this.logVerbose(`Trying key path "${this.taskConfig.keyPath}" and cert path "${this.taskConfig.certPath}".`);
        const certExists: boolean = fs.existsSync(this.taskConfig.certPath);
        const keyExists: boolean = fs.existsSync(this.taskConfig.keyPath);

        if (keyExists && certExists) {
          try {
            result.cert = fs.readFileSync(this.taskConfig.certPath);
            result.key = fs.readFileSync(this.taskConfig.keyPath);
          } catch (e) {
            this.logError(`Error loading key or cert file: ${e}`);
          }
        } else {
          if (!keyExists) {
            this.logError(`Key file not found at path "${this.taskConfig.keyPath}`);
          }

          if (!certExists) {
            this.logError(`Cert file not found at path "${this.taskConfig.certPath}`);
          }
        }
      } else {
        const { ensureCertificate } = require('./certificates'); // tslint:disable-line
        const devCertificate: ICertificate = ensureCertificate(this.taskConfig.tryCreateDevCertificate, this);
        if (devCertificate.pemCertificate && devCertificate.pemKey) {
          result.cert = devCertificate.pemCertificate;
          result.key = devCertificate.pemKey;
        } else {
          this.logWarning('When serving in HTTPS mode, a PFX cert path or a cert path and a key path must be ' +
                          'provided, or a dev certificate must be generated and trusted. If a SSL certificate isn\'t ' +
                          'provided, a default, self-signed certificate will be used. Expect browser security ' +
                          'warnings.');
        }
      }

      return result;
    } else {
      return undefined;
    }
  }

  /**
   * Workaround for loading gulp-connect, which automatically uses http2 if it
   * can require() a module called 'http2'
   *
   * https://github.com/AveVlad/gulp-connect/issues/246
   *
   * In versions of NodeJS < 8:
   *   'http2' would have to be a module in the node_modules folder.
   *   We did not provide this normally, so most of the time nobody used http2 with gulp serve.
   *
   * However, in versions of NodeJS >= 8:
   *   They provide a built-in module called 'http2', which is experimental and unstable
   *   The built-in module is preferred unless an environment variable is set: NODE_NO_HTTP2=1
   *
   * We don't want to enforce environmental requirements, nor
   * do we want to support a toolchain that relies on an experimental API.
   *
   * Until gulp-connect provides a way to disable HTTP2, we're using this workaround:
   * Inject a falsey value into the require() cache, require gulp-connect,
   * then restore the old cache state.
   *
   * As a consequence, this approach will prevent "gulp-connect" from using http2 in
   * environments with Node < 8. This is intentional, because we don't see a reason to
   * support http2 for serving localhost scripts.
   */
  // tslint:disable-next-line:no-any
  private _loadGulpConnect(): any {
    // this will raise an exception if it can't find http2,
    // which happens if we are on Node6 and 'http2' has not been required yet
    let http2CacheKey: string = 'http2';
    try {
      http2CacheKey = require.resolve('http2');
    } catch (exception) {
      // no-op
    }

    /* tslint:disable:typedef */
    let gulpConnect;

    // node 6 and http2 is in cache
    if (Object.keys(require.cache).indexOf(http2CacheKey) !== -1) {
      // store the old cache value
      const http2CacheObject = require.cache[http2CacheKey];
      require.cache[http2CacheKey] = { exports: undefined };

      gulpConnect = require('gulp-connect');

      // restore the old cache value
      require.cache[http2CacheKey] = http2CacheObject;
    } else {
      // node 8 or http2 is not in cache, insert a module with no exports into cache
      require.cache[http2CacheKey] = { exports: undefined };

      gulpConnect = require('gulp-connect');

      // remove module with no exports from cache
      delete require.cache[http2CacheKey];
    }
    /* tslint:enable:typedef */
    return gulpConnect;
  }
}
