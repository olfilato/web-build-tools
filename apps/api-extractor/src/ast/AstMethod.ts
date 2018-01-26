// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as ts from 'typescript';
import { AstItemKind, IAstItemOptions } from './AstItem';
import AstMember from './AstMember';
import AstParameter from './AstParameter';
import TypeScriptHelpers from '../TypeScriptHelpers';
import { Markup } from '../markup/Markup';
import ApiDefinitionReference, { IScopedPackageName } from '../ApiDefinitionReference';

/**
 * This class is part of the AstItem abstract syntax tree. It represents functions that are members of
 * classes, interfaces, or nested type literal expressions. Unlike AstFunctions, AstMethods can have
 * access modifiers (public, private, etc.) or be optional, because they are members of a structured type
 *
 * @see AstFunction for functions that are defined inside of a package
 */
export default class AstMethod extends AstMember {
  public readonly returnType: string;
  public readonly params: AstParameter[];

  constructor(options: IAstItemOptions) {
    super(options);

    // tslint:disable-next-line:no-bitwise
    if ((options.declarationSymbol.flags & ts.SymbolFlags.Constructor) !== 0) {
      this.kind = AstItemKind.Constructor;
    } else {
      this.kind = AstItemKind.Method;
    }

    const methodDeclaration: ts.MethodDeclaration = options.declaration as ts.MethodDeclaration;

    // Parameters
    if (methodDeclaration.parameters) {
      this.params = [];
      for (const param of methodDeclaration.parameters) {
        const declarationSymbol: ts.Symbol = TypeScriptHelpers.tryGetSymbolForDeclaration(param);
        const astParameter: AstParameter = new AstParameter({
          context: this.context,
          declaration: param,
          declarationSymbol: declarationSymbol
        });

        this.innerItems.push(astParameter);
        this.params.push(astParameter);
      }
    }

    // Return type
    if (this.kind !== AstItemKind.Constructor) {
      if (methodDeclaration.type) {
        this.returnType = methodDeclaration.type.getText();
      } else {
        this.returnType = 'any';
        this.hasIncompleteTypes = true;
      }
    }
  }

  protected onCompleteInitialization(): void {
    super.onCompleteInitialization();

    // If this is a class constructor, and if the documentation summary was omitted, then
    // we fill in a default summary versus flagging it as "undocumented".
    // Generally class constructors have uninteresting documentation.
    if (this.kind === AstItemKind.Constructor) {
      if (this.documentation.summary.length === 0) {
        this.documentation.summary.push(
          ...Markup.createTextElements('Constructs a new instance of the '));

        const scopedPackageName: IScopedPackageName = ApiDefinitionReference
          .parseScopedPackageName(this.context.package.name);

        this.documentation.summary.push(
          Markup.createApiLinkFromText(this.parentContainer!.name, {
              scopeName: scopedPackageName.scope,
              packageName: scopedPackageName.package,
              exportName: this.parentContainer!.name,
              memberName: ''
            }
          )
        );

        this.documentation.summary.push(...Markup.createTextElements(' class'));
      }
      this.needsDocumentation = false;
    }
  }
}
