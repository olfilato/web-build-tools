// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { args } from './State';

const ENVIRONMENT_VARIABLE_PREFIX: string = 'GCB_';

let _defaultValues: Object = {};

export function setConfigDefaults(defaultValues: Object): void {
  _defaultValues = defaultValues;
}

export function getConfigValue(name: string, defaultValue?: string | boolean): string | boolean {

  // Try to get config value from environment variable.
  const envVariable: string = ENVIRONMENT_VARIABLE_PREFIX + name.toUpperCase();
  const envValue: string | undefined = process.env[envVariable];
  const argsValue: string | boolean = args[name.toLowerCase()];

  return _firstDefinedValue(argsValue, envValue, defaultValue, _defaultValues[name]);
}

export function getFlagValue(name: string, defaultValue?: boolean): boolean {
  const configValue: string | boolean = getConfigValue(name, defaultValue);

  return configValue === 'true' || configValue === true;
}

/* tslint:disable:no-any */
function _firstDefinedValue(...values: (string | boolean | undefined)[]): any {
/* tslint:enable:no-any */
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}