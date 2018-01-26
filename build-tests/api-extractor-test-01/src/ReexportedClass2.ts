// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/**
 * This class gets aliased twice before being exported from the package.
 * @public
 */
export class ReexportedClass2 {
  public getSelfReference(): ReexportedClass2 {
    return this;
  }

  public getValue(): string {
    return 'Hello, world!';
  }
}
