/**
 * Enforces the multi-user isolation convention from CLAUDE.md §3:
 *
 *   Every exported function in the service and repository layers takes
 *   `userId` as its first parameter.
 *
 * The failure this guards against is silent. An unscoped read returns another
 * user's rows and looks entirely normal in any test with one user in the
 * database. Making the scope the first positional parameter means a call site
 * that forgot it does not compile.
 *
 * Functions that legitimately run before there is a user — registration, login,
 * session resolution, minting an invite — opt out by name via the
 * `allowUnscoped` option. Adding a name to that list is a deliberate act that
 * shows up in a diff, which is the point.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "require `userId` as the first parameter of exported service and repository functions",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowUnscoped: { type: "array", items: { type: "string" } },
          paramName: { type: "string" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missing:
        "`{{name}}` must take `{{paramName}}` as its first parameter (CLAUDE.md §3, multi-user isolation). If it genuinely runs before there is a user, add it to allowUnscoped in eslint.config.js and say why in a comment.",
      wrongPosition:
        "`{{name}}` takes `{{paramName}}`, but not first. It must be the first positional parameter so a call site that forgets the scope fails to compile.",
      inObject:
        "`{{name}}` takes `{{paramName}}` inside an object. Buried scope is how unscoped queries ship — make it the first positional parameter.",
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const paramName = options.paramName ?? "userId";
    const allowUnscoped = new Set(options.allowUnscoped ?? []);

    /** Does any parameter, at any position, carry the scope name? */
    function findParamPosition(params) {
      let objectPosition = -1;
      for (let i = 0; i < params.length; i++) {
        const param = params[i];
        const target = param.type === "AssignmentPattern" ? param.left : param;

        if (target.type === "Identifier" && target.name === paramName) return { position: i };
        if (target.type === "ObjectPattern") {
          const has = target.properties.some(
            (prop) =>
              prop.type === "Property" &&
              prop.key.type === "Identifier" &&
              prop.key.name === paramName,
          );
          if (has && objectPosition === -1) objectPosition = i;
        }
        if (
          target.type === "Identifier" &&
          target.typeAnnotation &&
          objectPosition === -1 &&
          typeAnnotationMentions(target.typeAnnotation, paramName)
        ) {
          objectPosition = i;
        }
      }
      return objectPosition === -1 ? null : { position: objectPosition, inObject: true };
    }

    function typeAnnotationMentions(annotation, name) {
      const node = annotation.typeAnnotation;
      if (!node || node.type !== "TSTypeLiteral") return false;
      return node.members.some(
        (member) =>
          member.type === "TSPropertySignature" &&
          member.key.type === "Identifier" &&
          member.key.name === name,
      );
    }

    function check(node, name) {
      if (!name || allowUnscoped.has(name)) return;

      const found = findParamPosition(node.params);
      const data = { name, paramName };

      if (found === null) {
        context.report({ node: node.id ?? node, messageId: "missing", data });
        return;
      }
      if (found.inObject) {
        context.report({ node: node.params[found.position], messageId: "inObject", data });
        return;
      }
      if (found.position !== 0) {
        context.report({ node: node.params[found.position], messageId: "wrongPosition", data });
      }
    }

    /** Only exported functions. Local helpers are free to take whatever they like. */
    function visitExport(declaration) {
      if (!declaration) return;

      if (declaration.type === "FunctionDeclaration") {
        check(declaration, declaration.id?.name);
        return;
      }

      if (declaration.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
          const init = declarator.init;
          if (!init) continue;
          if (init.type !== "ArrowFunctionExpression" && init.type !== "FunctionExpression") {
            continue;
          }
          check(init, declarator.id.type === "Identifier" ? declarator.id.name : undefined);
        }
      }
    }

    return {
      ExportNamedDeclaration(node) {
        visitExport(node.declaration);
      },
      ExportDefaultDeclaration(node) {
        if (
          node.declaration.type === "FunctionDeclaration" ||
          node.declaration.type === "ArrowFunctionExpression"
        ) {
          check(node.declaration, node.declaration.id?.name ?? "default export");
        }
      },
    };
  },
};

export default {
  rules: {
    "user-id-first-param": rule,
  },
};
