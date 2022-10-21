import path from 'path';
import { ESLintUtils } from '@typescript-eslint/utils';
import ts from 'typescript';
import type { CallExpressionArgument } from '@typescript-eslint/types/dist/generated/ast-spec';

const temporalWorkflowSuffix = 'workflow/lib/workflow.d.ts';
const temporalInternalWorkflowSuffix = 'common/lib/interfaces.d.ts';
// TODO: use the complete suffixes (they don't work when run in the SDK monorepo context)
// const temporalWorkflowSuffix = '/node_modules/@temporalio/workflow/lib/workflow.d.ts';
// const temporalInternalWorkflowSuffix = '/node_modules/@temporalio/common/lib/interfaces.d.ts';

const rule = ESLintUtils.RuleCreator.withoutDocs({
  create(context) {
    return {
      CallExpression(node) {
        const parserServices = ESLintUtils.getParserServices(context);
        const checker = parserServices.program.getTypeChecker();
        function getRootSymbol(sym: ts.Symbol | undefined): ts.Symbol | undefined {
          if (sym === undefined) {
            return undefined;
          }
          if (sym.flags & ts.SymbolFlags.Alias) {
            return checker.getAliasedSymbol(sym);
          }
          return sym;
        }

        function isSetHandler(sym: ts.Symbol | undefined): boolean {
          const propSymbol = getRootSymbol(sym);
          if (propSymbol === undefined) {
            return false;
          }
          // console.log(propSymbol);
          const sourceFile = propSymbol.valueDeclaration?.parent;
          if (sourceFile === undefined) {
            return false;
          }
          return (
            propSymbol.name === 'setHandler' &&
            ts.isSourceFile(sourceFile) &&
            sourceFile.fileName.endsWith(temporalWorkflowSuffix)
          );
        }
        function isQueryDefinition(arg: CallExpressionArgument): boolean {
          const node = parserServices.esTreeNodeToTSNodeMap.get(arg);
          const nodeType = checker.getTypeAtLocation(node);
          // const sym = getRootSymbol(nodeType.symbol);
          const sym = nodeType.symbol;
          const sourceFile = sym.declarations?.[0]?.parent;
          if (sourceFile === undefined || !ts.isSourceFile(sourceFile)) {
            return false;
          }
          return sym.escapedName === 'QueryDefinition' && sourceFile.fileName.endsWith(temporalInternalWorkflowSuffix);
        }

        let sym: ts.Symbol | undefined = undefined;
        if (node.callee.type === 'MemberExpression') {
          sym = checker.getSymbolAtLocation(parserServices.esTreeNodeToTSNodeMap.get(node.callee.property));
        } else if (node.callee.type === 'Identifier') {
          sym = checker.getSymbolAtLocation(parserServices.esTreeNodeToTSNodeMap.get(node.callee));
        }
        if (!(isSetHandler(sym) && node.arguments.length === 2 && isQueryDefinition(node.arguments[0]))) {
          return;
        }
        // TODO: check if the function (node.arguments[1]) has assignment expressions.
      },
      AssignmentExpression(node) {
        const parserServices = ESLintUtils.getParserServices(context);
        const checker = parserServices.program.getTypeChecker();

        const lhs = parserServices.esTreeNodeToTSNodeMap.get(node.left);
        const lhsSymbol = checker.getSymbolAtLocation(lhs);

        // Does this assignment expression have an ancestor that is a `setHandler()`
        // CallExpression where the first arg is a `QueryDefinition`?
        const ancestors = context.getAncestors();
        for (const ancestor of ancestors) {
          if (ancestor.type !== 'CallExpression') {
            continue;
          }

          const callee = parserServices.esTreeNodeToTSNodeMap.get(ancestor.callee);

          const calleeSymbol = checker.getSymbolAtLocation(callee);
          const calleeDeclaration = calleeSymbol?.declarations?.[0];
          if (!calleeDeclaration) {
            continue;
          }

          let isSetHandlerFromNamedImport = false;
          let isSetHandlerFromDefaultImport = false;

          if (
            ts.isNamedImports(calleeDeclaration.parent) &&
            // TODO: types
            (calleeDeclaration.parent.parent?.parent?.moduleSpecifier as any)?.text === '@temporalio/workflow'
            // calleeDeclaration.parent?.parent?.parent?.moduleSpecifier?.getFullText() === '@temporalio/workflow'
          ) {
            // `import { setHandler } from '@temporalio/workflows'` or
            // `import { setHandler as something } from '@temporalio/workflows'`
            const declaration = calleeDeclaration?.parent?.elements.find(
              // TODO: types
              (el) => el?.name?.escapedText === (ancestor.callee as any).name
            );
            if (declaration === undefined) {
              continue;
            }
            isSetHandlerFromNamedImport =
              declaration.propertyName != null
                ? declaration.propertyName.escapedText === 'setHandler'
                : declaration.name.escapedText === 'setHandler';
          } else if (
            ts.isFunctionDeclaration(calleeDeclaration) &&
            ts.isSourceFile(calleeDeclaration.parent) &&
            calleeDeclaration.parent.fileName.endsWith(temporalWorkflowSuffix)
          ) {
            // `import wf from '@temporalio/workflows'` or
            // `import * as wf from '@temporalio/workflows'`
            isSetHandlerFromDefaultImport = calleeDeclaration.name?.escapedText === 'setHandler';
          }

          if (!isSetHandlerFromNamedImport && !isSetHandlerFromDefaultImport) {
            continue;
          }

          const firstArg = parserServices.esTreeNodeToTSNodeMap.get(ancestor.arguments[0]);
          const nodeType = checker.getTypeAtLocation(firstArg);

          // If first arg is not of type `QueryDefinition`, skip
          if (
            nodeType.symbol.escapedName !== 'QueryDefinition' ||
            // TODO: types
            !(nodeType.symbol as any).parent?.valueDeclaration?.path?.endsWith(temporalInternalWorkflowSuffix)
            // !nodeType?.symbol?.parent?.valueDeclaration?.path?.endsWith(temporalInternalWorkflowSuffix)
          ) {
            continue;
          }

          const declaration = lhsSymbol?.declarations?.[0];

          if (
            declaration &&
            ts.isParameter(declaration) &&
            // TODO: types
            (declaration.parent?.parent as any)?.expression === callee
            // lhsSymbol.declarations[0]?.parent?.parent?.expression === callee
          ) {
            // Modifying a function argument is OK if it is a parameter to `setHandler()` callback
            continue;
          }

          context.report({
            messageId: 'queryHandlerMutation',
            node,
          });
        }
      },
    };
  },
  meta: {
    docs: {
      recommended: 'error',
      // category: 'Best Practices',
      description: 'Avoid mutations in query handlers.',
    },
    messages: {
      queryHandlerMutation: 'Avoid mutations in query handlers.',
    },
    type: 'suggestion',
    schema: [],
  },
  defaultOptions: [],
});

const ruleTester = new ESLintUtils.RuleTester({
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: path.join(__dirname, '..'),
    // tsconfigRootDir: __dirname,
  },
});

const valid = [];

valid.push(`
import { setHandler, defineQuery, defineSignal } from '@temporalio/workflow';

export const unblockSignalButLooksLikeQuery = defineSignal('unblock');
export const isBlockedQuery = defineQuery<boolean>('isBlocked');

setHandler(unblockSignalButLooksLikeQuery, () => void (isBlocked = false));
setHandler(isBlockedQuery, () => isBlocked);
`);

valid.push(`
import { setHandler as notSetHandler, defineQuery } from '@temporalio/workflow';

export const isBlockedQuery = defineQuery<boolean>('isBlocked');

notSetHandler(isBlockedQuery, () => isBlocked);
`);

valid.push(`
import { setHandler as notSetHandler, defineQuery } from '@temporalio/workflow';

export const isBlockedQuery = defineQuery<boolean, [string]>('isBlocked');

notSetHandler(isBlockedQuery, (arg: string) => {
  arg = arg.toLowerCase();
  if (arg === 'skip') {
    return false;
  }
  return isBlocked;
});
`);

const invalid = [];

invalid.push(`
import { setHandler, defineQuery, defineSignal } from '@temporalio/workflow';

export const unblockSignalButLooksLikeQuery = defineSignal('unblock');
export const isBlockedQuery = defineQuery<boolean>('isBlocked');

setHandler(unblockSignalButLooksLikeQuery, () => void (isBlocked = false));
setHandler(isBlockedQuery, () => {
  isBlocked = !isBlocked;
  return isBlocked;
});
`);

invalid.push(`
import {
  setHandler as definitelyNotSetHandler,
  defineQuery
} from '@temporalio/workflow';

export const isBlockedQuery = defineQuery<boolean>('isBlocked');

definitelyNotSetHandler(isBlockedQuery, () => {
  isBlocked = !isBlocked;
  return isBlocked;
});
`);

invalid.push(`
import wf from '@temporalio/workflow';

export const isBlockedQuery = wf.defineQuery<boolean>('isBlocked');

wf.setHandler(isBlockedQuery, () => {
  isBlocked = !isBlocked;
  return isBlocked;
});
`);

invalid.push(`
import * as wf from '@temporalio/workflow';

export const isBlockedQuery = wf.defineQuery<boolean>('isBlocked');

wf.setHandler(isBlockedQuery, () => {
  isBlocked = !isBlocked;
  return isBlocked;
});
`);

invalid.push(`
import * as wf from '@temporalio/workflow';

export const isBlockedQuery = wf.defineQuery<boolean>('isBlocked');

function mySetHandler(fn: () => boolean) {
  wf.setHandler(isBlockedQuery, fn);
}

mySetHandler(() => {
  isBlocked = !isBlocked;
  return isBlocked;
});
`);

invalid.push(`
import { setHandler, defineQuery, defineSignal } from '@temporalio/workflow';

export const isBlockedQuery = defineQuery<boolean>('isBlocked');

let isBlocked = false;

function mutator() {
  isBlocked = !isBlocked;
}

setHandler(isBlockedQuery, () => {
  mutator();
  return isBlocked;
});
`);

ruleTester.run('test', rule, {
  valid: valid.map((code) => ({ code, filename: 'src/helpers.ts' })),
  invalid: invalid.map((code) => ({
    code,
    filename: 'src/helpers.ts',
    errors: [{ messageId: 'queryHandlerMutation' }],
  })),
});
