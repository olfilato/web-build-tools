// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/* tslint:disable:no-bitwise */

import * as fs from 'fs';
import * as ts from 'typescript';

import { ExtractorContext } from '../ExtractorContext';
import IndentedWriter from '../IndentedWriter';
import TypeScriptHelpers from '../TypeScriptHelpers';
import { Span } from './Span';

/**
 * An "Entry" is a type definition that we encounter while traversing the
 * references from the package entry point.  This data structure helps filter,
 * sort, and rename the entries that end up in the output package typings file.
 */
class Entry {
  /**
   * The original name of the symbol, as exported from the module (i.e. source file)
   * containing the original TypeScript definition.
   */
  public localName: string;

  /**
   * The localName, possibly renamed to ensure that all the top-level exports have unique names.
   */
  public uniqueName: string | undefined = undefined;

  /**
   * The compiler symbol where this type was defined, after following any aliases.
   */
  public followedSymbol: ts.Symbol;

  /**
   * If true, this entry should be emitted using the "export" keyword instead of the "declare" keyword.
   */
  public exported: boolean = false;

  private _sortKey: string|undefined = undefined;

  public getSortKey(): string {
    if (!this._sortKey) {
      if (this.localName.substr(0, 1) === '_') {
        // Removes the leading underscore, for example:  "_example" --> "example*"
        // This causes internal definitions to sort alphabetically with regular definitions.
        // The star is appended to preserve uniqueness, since "*" is not a legal  identifier character.
        this._sortKey = this.localName.substr(1) + ' ';
      } else {
        this._sortKey = this.localName;
      }
    }
    return this._sortKey;
  }
}

/**
 * Return value for PackageTypingsGenerator._followAliases()
 */
interface IFollowAliasesResult {
  /**
   * The original symbol that defined this entry, after following any aliases.
   */
  symbol: ts.Symbol;

  /**
   * If true, the symbol was declared by an external package, e.g. versus being imported
   * from another source file in the current project.
   */
  external: boolean;

  /**
   * If true, the symbol is exported from a module somewhere.  If false, then it's
   * a global ambient definition or else a private declaration in the referencing file.
   * NOTE: The "external" status is unknown if moduleExport=true.
   */
  moduleExport: boolean;
}

export default class PackageTypingsGenerator {
  private _context: ExtractorContext;
  private _typeChecker: ts.TypeChecker;
  private _indentedWriter: IndentedWriter = new IndentedWriter();

  /**
   * A cache that tells us the Entry that is tracking a given symbol.  Because of aliases,
   * two different symbols can map to the same Entry object.
   */
  private readonly _entriesBySymbol: Map<ts.Symbol, Entry> = new Map<ts.Symbol, Entry>();

  /**
   * This data structure stores the same entries as _entriesBySymbol.values().
   * They are sorted according to Entry.getSortKey().
   */
  private readonly _entries: Entry[] = [];

  /**
   * Walks up the tree from the given starting node.  If each parent matches the expected kind
   * from parentKinds, then the matching node is returned.  Otherwise, undefined is returned.
   */
  private static _matchParent<T extends ts.Node>(node: ts.Node, parentKinds: ts.SyntaxKind[]): T | undefined {
    let current: ts.Node | undefined = node;

    let  i: number = 0;
    while (true) { // tslint:disable-line:no-constant-condition
      if (!current || current.kind !== parentKinds[i]) {
        return undefined;
      }

      if (i >= parentKinds.length - 1) {
        break;
      }

      ++i;
      current = current.parent;
    }

    return current as T;
  }

  /**
   * For the given symbol, follow imports and type alias to find the symbol that represents
   * the original definition.
   */
  private static _followAliases(symbol: ts.Symbol, typeChecker: ts.TypeChecker): IFollowAliasesResult {
    let current: ts.Symbol = symbol;

    while (true) { // tslint:disable-line:no-constant-condition
      if (!(current.flags & ts.SymbolFlags.Alias)) {
        break;
      }
      const currentAlias: ts.Symbol = TypeScriptHelpers.getImmediateAliasedSymbol(current, typeChecker);
      // Stop if we reach the end of the chain
      if (!currentAlias || currentAlias === current) {
        break;
      }

      // Is it an export declaration?
      if (currentAlias.declarations) {
        const exportDeclaration: ts.ExportDeclaration | undefined
          = PackageTypingsGenerator._matchParent<ts.ExportDeclaration>(currentAlias.declarations[0],
          [ts.SyntaxKind.ExportSpecifier, ts.SyntaxKind.NamedExports, ts.SyntaxKind.ExportDeclaration]);

        if (exportDeclaration && exportDeclaration.moduleSpecifier) {
          // Example: " '@microsoft/sp-lodash-subset'" or " './MyClass'"
          const moduleSpecifier: string = exportDeclaration.moduleSpecifier.getFullText();

          // Does it start with something like "'./"?
          // If not, then assume it's an import from an external package
          if (!/^['"\s]+\.[\/\\]/.test(moduleSpecifier)) {
            return { symbol: current, external: true, moduleExport: true };
          }
        }
      }

      current = currentAlias;
    }

    // Is it an export?  We examine all of the declarations to see if any of them contains
    // the "export" keyword.
    let moduleExport: boolean = false;
    for (const declaration of current.declarations || []) {
      const modifiers: ts.ModifierFlags = ts.getCombinedModifierFlags(declaration);
      if (modifiers & (ts.ModifierFlags.Export | ts.ModifierFlags.ExportDefault)) {
        moduleExport = true;
        break;
      }
    }

    return { symbol: current, external: false, moduleExport: moduleExport };
  }

  public constructor(context: ExtractorContext) {
    this._context = context;
    this._typeChecker = context.typeChecker;
  }

  /**
   * Generates the typings file and writes it to disk.
   *
   * @param dtsFilename    - The *.d.ts output filename
   */
  public writeTypingsFile(dtsFilename: string): void {
    const fileContent: string = this.generateTypingsFileContent();
    fs.writeFileSync(dtsFilename, fileContent);
  }

  public generateTypingsFileContent(): string {
    this._indentedWriter.spacing = '';
    this._indentedWriter.clear();

    const packageSymbol: ts.Symbol = this._context.package.getDeclarationSymbol();

    const exportSymbols: ts.Symbol[] = this._typeChecker.getExportsOfModule(packageSymbol) || [];

    for (const exportSymbol of exportSymbols) {
      const entry: Entry | undefined = this._fetchEntryForSymbol(exportSymbol);

      if (!entry) {
        // We are reexporting an external definition.
        // To handle this, we would need to emit an import statement.
        this._indentedWriter.writeLine('// Unsupported re-export: ' + exportSymbol.name);
      } else {
        entry.exported = true;
      }
    }

    this._makeUniqueNames();

    this._entries.sort((a, b) => a.getSortKey().localeCompare(b.getSortKey()));

    for (const entry of this._entries) {
      if (entry.followedSymbol) {
        for (const declaration of entry.followedSymbol.declarations || []) {
          // console.log(PrettyPrinter.dumpTree(declaration));

          // console.log(declaration.getText());
          // console.log('=====================================');

          const span: Span = new Span(declaration);
          // console.log(span.getDump());
          // console.log('-------------------------------------');

          this._modifySpan(span, entry);

          this._indentedWriter.writeLine();
          this._indentedWriter.writeLine(span.getModifiedText());
        }
      }
    }

    // Normalize to CRLF
    const fileContent: string = this._indentedWriter.toString().replace(/\r?\n/g, '\r\n');
    return fileContent;
  }

  /**
   * Before writing out a declaration, _modifySpan() applies various fixups to make it nice.
   */
  private _modifySpan(rootSpan: Span, entry: Entry): void {
    rootSpan.modify((span: Span, previousSpan: Span | undefined, parentSpan: Span | undefined) => {
      switch (span.kind) {
        case ts.SyntaxKind.ExportKeyword:
        case ts.SyntaxKind.DefaultKeyword:
        case ts.SyntaxKind.DeclareKeyword:
          // Delete any explicit "export" keywords -- we will re-add them based on Entry.exported
          span.modification.skipAll();
          break;

        case ts.SyntaxKind.InterfaceKeyword:
        case ts.SyntaxKind.ClassKeyword:
        case ts.SyntaxKind.EnumKeyword:
        case ts.SyntaxKind.NamespaceKeyword:
        case ts.SyntaxKind.ModuleKeyword:
        case ts.SyntaxKind.TypeKeyword:
          span.modification.prefix = 'declare ' + span.modification.prefix;
          if (entry.exported) {
            span.modification.prefix = 'export ' + span.modification.prefix;
          }
          break;

        case ts.SyntaxKind.VariableDeclaration:
          if (!parentSpan) {
            // The VariableDeclaration node is part of a VariableDeclarationList, however
            // the Entry.followedSymbol points to the VariableDeclaration part because
            // multiple definitions might share the same VariableDeclarationList.
            //
            // Since we are emitting a separate declaration for each one, we need to look upwards
            // in the ts.Node tree and write a copy of the enclosing VariableDeclarationList
            // content (e.g. "var" from "var x=1, y=2").
            const list: ts.VariableDeclarationList | undefined = PackageTypingsGenerator._matchParent(span.node,
              [ts.SyntaxKind.VariableDeclaration, ts.SyntaxKind.VariableDeclarationList]);
            if (!list) {
              throw new Error('Unsupported variable declaration');
            }
            const listPrefix: string = list.getSourceFile().text
              .substring(list.getStart(), list.declarations[0].getStart());
            span.modification.prefix = 'declare ' + listPrefix + span.modification.prefix;
            span.modification.suffix = ';';
          }
          break;

        case ts.SyntaxKind.Identifier:
          if (parentSpan) {
            switch (parentSpan.kind) {
              case ts.SyntaxKind.ExpressionWithTypeArguments:
              case ts.SyntaxKind.TypeReference:

              case ts.SyntaxKind.ClassDeclaration:
              case ts.SyntaxKind.InterfaceDeclaration:
              case ts.SyntaxKind.EnumDeclaration:
              case ts.SyntaxKind.TypeAliasDeclaration:
              case ts.SyntaxKind.ModuleDeclaration:  // (namespaces are a type of module declaration)
                {
                  const symbol: ts.Symbol | undefined = this._typeChecker.getSymbolAtLocation(span.node);
                  if (!symbol) {
                    throw new Error('Symbol not found');
                  }

                  const referencedEntry: Entry | undefined = this._fetchEntryForSymbol(symbol);
                  if (referencedEntry) {
                    if (!referencedEntry.uniqueName) {
                      // This should never happen
                      throw new Error('referencedEntry.uniqueName is undefined');
                    }

                    span.modification.prefix = referencedEntry.uniqueName;
                    // span.modification.prefix += '/**/';
                  }
                }
                break;
            }
          }
          break;
        }
      }
    );
  }

  /**
   * Ensures a unique name for each item in the package typings file.
   */
  private _makeUniqueNames(): void {
    const usedNames: Set<string> = new Set<string>();
    for (const entry of this._entries) {
      let suffix: number = 1;
      entry.uniqueName = entry.localName;
      while (usedNames.has(entry.uniqueName)) {
        entry.uniqueName = entry.localName + '_' + ++suffix;
      }
      usedNames.add(entry.uniqueName);
    }
  }

  private _fetchEntryForSymbol(symbol: ts.Symbol): Entry | undefined {
    const result: IFollowAliasesResult = PackageTypingsGenerator._followAliases(symbol, this._typeChecker);
    if (result.external || !result.moduleExport) {
      return; // external definition
    }

    const followedSymbol: ts.Symbol = result.symbol;
    if (followedSymbol.flags & (
      ts.SymbolFlags.TypeParameter | ts.SymbolFlags.TypeLiteral
      )) {
      return undefined;
    }

    let entry: Entry | undefined = this._entriesBySymbol.get(followedSymbol);
    if (entry) {
      return entry;
    }

    entry = new Entry();
    entry.localName = symbol.name;
    entry.followedSymbol = followedSymbol;
    this._entries.push(entry);
    this._entriesBySymbol.set(followedSymbol, entry);
    console.log('======> ' + entry.localName);

    for (const declaration of followedSymbol.declarations || []) {
      // console.log(PrettyPrinter.dumpTree(declaration));
      // console.log('-------------------------------------');
      // console.log(declaration.getText());
      // console.log('=====================================');

      this._collectTypes(declaration);
    }

    return entry;
  }

  private _collectTypes(node: ts.Node): void {
    switch (node.kind) {
      case ts.SyntaxKind.Block:
        // Don't traverse into code
        return;

      case ts.SyntaxKind.Identifier:
        if (node.parent) {
          switch (node.parent.kind) {
            case ts.SyntaxKind.ExpressionWithTypeArguments:
            case ts.SyntaxKind.TypeReference:
              {
                const symbol: ts.Symbol | undefined = this._typeChecker.getSymbolAtLocation(node);
                if (!symbol) {
                  throw new Error('Symbol not found');
                }

                this._fetchEntryForSymbol(symbol);
              }
              break;
          }
        }
        return;
    }

    for (const child of node.getChildren() || []) {
      this._collectTypes(child);
    }
  }
}
