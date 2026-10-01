/**
 * ES5 syntax guard for code that goes into GTM Custom HTML tags and Custom JavaScript variables.
 * Everything already in OpenArt's container is ES5 (see the compiled tags in gtm_56CMP8K v25), and
 * older GTM workspaces reject ES2015 syntax in Custom JavaScript variables, so the fix pack stays ES5.
 */
import ts from 'typescript';

export interface Es5Violation {
  kind: string;
  text: string;
}

const FORBIDDEN_KINDS = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.ArrowFunction, 'arrow function'],
  [ts.SyntaxKind.TemplateExpression, 'template literal'],
  [ts.SyntaxKind.NoSubstitutionTemplateLiteral, 'template literal'],
  [ts.SyntaxKind.TaggedTemplateExpression, 'tagged template'],
  [ts.SyntaxKind.SpreadElement, 'spread'],
  [ts.SyntaxKind.SpreadAssignment, 'object spread'],
  [ts.SyntaxKind.ClassDeclaration, 'class'],
  [ts.SyntaxKind.ClassExpression, 'class'],
  [ts.SyntaxKind.ForOfStatement, 'for…of'],
  [ts.SyntaxKind.ObjectBindingPattern, 'destructuring'],
  [ts.SyntaxKind.ArrayBindingPattern, 'destructuring'],
  [ts.SyntaxKind.ShorthandPropertyAssignment, 'shorthand property'],
  [ts.SyntaxKind.ComputedPropertyName, 'computed property name'],
  [ts.SyntaxKind.AwaitExpression, 'await'],
  [ts.SyntaxKind.YieldExpression, 'yield'],
  [ts.SyntaxKind.BigIntLiteral, 'bigint'],
  [ts.SyntaxKind.MetaProperty, 'new.target / import.meta'],
]);

export function findEs5Violations(code: string): Es5Violation[] {
  const source = ts.createSourceFile('snippet.js', code, ts.ScriptTarget.ES5, true, ts.ScriptKind.JS);
  const violations: Es5Violation[] = [];
  const diagnostics = (source as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  for (const d of diagnostics) violations.push({ kind: 'parse error', text: ts.flattenDiagnosticMessageText(d.messageText, ' ') });

  const visit = (node: ts.Node): void => {
    const forbidden = FORBIDDEN_KINDS.get(node.kind);
    if (forbidden) violations.push({ kind: forbidden, text: node.getText(source).slice(0, 60) });
    if (ts.isVariableDeclarationList(node) && node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) {
      violations.push({ kind: 'let/const', text: node.getText(source).slice(0, 60) });
    }
    if (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent)) {
      violations.push({ kind: 'method shorthand', text: node.getText(source).slice(0, 60) });
    }
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && (node.asteriskToken || ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))) {
      violations.push({ kind: 'generator/async', text: node.getText(source).slice(0, 60) });
    }
    if (ts.isParameter(node) && (node.initializer || node.dotDotDotToken)) {
      violations.push({ kind: 'default/rest parameter', text: node.getText(source).slice(0, 60) });
    }
    if (ts.isPropertyAccessExpression(node) && node.questionDotToken) violations.push({ kind: 'optional chaining', text: node.getText(source) });
    if (ts.isCallExpression(node) && node.questionDotToken) violations.push({ kind: 'optional chaining', text: node.getText(source) });
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken) violations.push({ kind: 'nullish coalescing', text: node.getText(source) });
      if (op === ts.SyntaxKind.AsteriskAsteriskToken || op === ts.SyntaxKind.AsteriskAsteriskEqualsToken) violations.push({ kind: 'exponent operator', text: node.getText(source) });
      if (op === ts.SyntaxKind.BarBarEqualsToken || op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) violations.push({ kind: 'logical assignment', text: node.getText(source) });
    }
    if (ts.isRegularExpressionLiteral(node) && /\/[a-z]*[uys][a-z]*$/.test(node.text)) violations.push({ kind: 'ES2015+ regex flag', text: node.text });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

/** Extract the bodies of every <script> element in a Custom HTML string. */
export function scriptBodies(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(m[1] ?? '');
  return out;
}
